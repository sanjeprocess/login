import express from 'express';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import { getItemByRequestNo } from '../services/requestService.js';
import type { WorkHub24Client } from '../wh24/client.js';

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

const chassisCheckSchema = z.object({});

function createVehicleSummary(item: Record<string, unknown>) {
  const make = String(item.C2 ?? '');
  const model = String(item.C3 ?? '');
  return `${make} ${model}`.trim();
}

async function hasOpenChassisDuplicate(wh24Client: WorkHub24Client, chassisNo: string): Promise<boolean> {
  try {
    const existing = await wh24Client.findItemByField('WF-01', 'C7', chassisNo);
    if (!existing) return false;
    const item = await wh24Client.getItem(existing.itemId);
    return String(item.fields.A3 ?? '') !== 'Completed';
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
      const now = new Date().toISOString().slice(0, 10);
      const mobileDigits = body.customer.mobile.replace(/\D/g, '');

      const created = await wh24Client.createItem('WF-01', {
        title: `${body.customer.name} · ${chassisNo}`,
        A2: now,
        A3: 'Awaiting Quotes',
        A4: sessionUser.partner,
        A5: sessionUser.branch,
        A6: sessionUser.name,
        A7: sessionUser.email,
        B2: body.customer.name,
        B3: body.customer.idNumber,
        B4: body.customer.mobile,
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
        E3: body.cover.optionalCovers,
        E4: body.cover.policyStartDate,
        E5: body.consent,
        E6: body.cover.remarks ?? ''
      });
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
