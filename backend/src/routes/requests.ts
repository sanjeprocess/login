import express from 'express';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import { getItemByRequestNo } from '../services/requestService.js';
import type { WorkHub24Client } from '../wh24/client.js';
import { formatSmsMobile } from '../wh24/mobileFormat.js';
import { REQUEST_STATUS } from '../wh24/fields.js';

const requestSchema = z.object({
  customer: z.object({
    type: z.enum(['Individual', 'Company']),
    name: z.string().min(1),
    idNumber: z.string().regex(/^(\d{9}[VX]|\d{12})$/i),
    mobile: z.string().regex(/^\+947\d{8}$/),
    email: z.string().email().optional(),
    address: z.string().min(1)
  }),
  vehicle: z.object({
    category: z.string().min(1),
    make: z.string().min(1),
    model: z.string().min(1),
    year: z.number().int().min(1990).max(new Date().getFullYear() + 1),
    condition: z.enum(['Brand new', 'Registered']),
    registrationNo: z.string().optional(),
    chassisNo: z.string().min(1),
    engineNo: z.string().min(1),
    value: z.number().positive(),
    usage: z.enum(['Private', 'Hiring', 'Commercial'])
  }),
  finance: z.object({
    facilityType: z.enum(['Lease', 'Loan']),
    referenceNo: z.string().min(1),
    amount: z.number().positive(),
    tenureMonths: z.number().int().min(1).max(120)
  }),
  cover: z.object({
    coverType: z.enum(['Comprehensive', 'Third Party']),
    sumInsured: z.number().positive(),
    optionalCovers: z.array(z.string()),
    policyStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    remarks: z.string().optional()
  }),
  consent: z.literal(true)
});

export type RequestBody = z.infer<typeof requestSchema>;
export { requestSchema };

export type Wh24DateTimeStyle = 'micro' | 'isoZ';
/** Style for WF-01 requestDate (A2), a WH24 datetime. Confirmed with `npm run probe -- createbisect`. */
export const REQUEST_DATE_STYLE: Wh24DateTimeStyle = 'micro';

/** "micro": "2026-11-11T11:33:33.000000" (UTC, as WH24 returns createdDate); "isoZ": "2026-11-11T11:33:33.000Z". */
export function formatWh24DateTime(date: Date, style: Wh24DateTimeStyle = REQUEST_DATE_STYLE): string {
  const iso = date.toISOString();
  return style === 'isoZ' ? iso : `${iso.slice(0, 19)}.${iso.slice(20, 23)}000`;
}

/** WF-01 create-card fields (design ids) for a Screen 1 request. Shared with the probe script. */
export function buildRequestCardFields(
  body: RequestBody,
  sessionUser: { partner?: string; name: string; email: string },
  now = formatWh24DateTime(new Date())
): Record<string, unknown> {
  const chassisNo = body.vehicle.chassisNo;
  const mobileDigits = body.customer.mobile.replace(/\D/g, '');
  return {
    title: `${body.customer.name} · ${chassisNo}`,
    A2: now,
    A3: REQUEST_STATUS.awaitingQuotes,
    A4: sessionUser.partner,
    A6: sessionUser.name,
    A7: sessionUser.email,
    B2: body.customer.name,
    B3: body.customer.idNumber,
    B4: formatSmsMobile(body.customer.mobile),
    B5: body.customer.email ?? '',
    B6: body.customer.address,
    B7: `●●● ●●● ${mobileDigits.slice(-4)}`,
    B1: body.customer.type,
    C1: body.vehicle.category,
    C2: body.vehicle.make,
    C3: body.vehicle.model,
    C4: body.vehicle.year,
    C5: body.vehicle.condition,
    C6: body.vehicle.registrationNo ?? '',
    C7: body.vehicle.chassisNo,
    C8: body.vehicle.engineNo,
    C9: body.vehicle.value,
    C10: body.vehicle.usage,
    D1: body.finance.facilityType,
    D2: body.finance.referenceNo,
    D3: body.finance.amount,
    D4: body.finance.tenureMonths,
    E1: body.cover.coverType,
    E2: body.cover.sumInsured,
    // optionalCovers is a WH24 text field: comma-separated, "" when none.
    E3: body.cover.optionalCovers.join(', '),
    E4: body.cover.policyStartDate,
    E5: body.consent,
    E6: body.cover.remarks ?? ''
  };
}

function createVehicleSummary(item: Record<string, unknown>) {
  const make = String(item.C2 ?? '');
  const model = String(item.C3 ?? '');
  return `${make} ${model}`.trim();
}

let warnedNoChassisLookup = false;

async function hasOpenChassisDuplicate(wh24Client: WorkHub24Client, chassisNo: string): Promise<boolean> {
  if (!wh24Client.findRequestByChassis) {
    // Non-blocking: no working card search on this tenant, so the check is skipped.
    if (!warnedNoChassisLookup) {
      warnedNoChassisLookup = true;
      console.warn('Duplicate-chassis check skipped: WorkHub24 has no working card search on this tenant.');
    }
    return false;
  }
  try {
    const item = await wh24Client.findRequestByChassis(chassisNo);
    if (!item) return false;
    return String(item.fields.A3 ?? '') !== REQUEST_STATUS.completed;
  } catch (error) {
    console.warn('WorkHub24 chassis duplicate check failed; allowing the request to continue.', {
      chassisNo,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

export function createRequestsRoutes(wh24Client: WorkHub24Client) {
  const router = express.Router();

  router.get('/requests/chassis/:chassisNo', requireSession('finance'), async (req, res, next) => {
    try {
      const chassisNo = typeof req.params.chassisNo === 'string' ? req.params.chassisNo : req.params.chassisNo?.[0] ?? '';
      const exists = await hasOpenChassisDuplicate(wh24Client, chassisNo);
      return res.json({ exists });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests', requireSession('finance'), async (req, res, next) => {
    try {
      const body = requestSchema.parse(req.body);
      const chassisNo = body.vehicle.chassisNo;
      if (await hasOpenChassisDuplicate(wh24Client, chassisNo)) {
        throw new ApiError('DUPLICATE_CHASSIS', 'A chassis already has an open request.', { fields: { 'v-chassis': 'A chassis already has an open request.' } });
      }

      const sessionUser = (req as any).session.user;
      const created = await wh24Client.createItem('WF-01', buildRequestCardFields(body, sessionUser));
      if (!created.title?.trim()) {
        console.warn('WorkHub24 created a WF-01 card without a title.', { itemId: created.itemId });
      }

      const requestNo = created.requestNo ?? String((await wh24Client.getItem(created.itemId)).fields.A1 ?? '');
      if (!requestNo) throw new Error('WorkHub24 created a WF-01 card without a requestNo.');
      return res.status(201).json({ requestNo });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
