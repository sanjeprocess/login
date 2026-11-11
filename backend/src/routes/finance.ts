import { randomInt } from 'node:crypto';
import express, { type Request } from 'express';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import { getItemByRequestNo, getRequestSummary } from '../services/requestService.js';
import { requireOpenTask } from '../services/taskAccess.js';
import { calculatePremiumBreakdown, packageDisplayName } from '../services/matching.js';
import type { OffersRepository, OtpAttemptsRepository } from '../services/offersStore.js';
import type { WorkHub24Client } from '../wh24/client.js';
import { tableColumnKey } from '../wh24/fields.js';

const selectSchema = z.object({ insurer: z.string().min(1), packageRef: z.string().min(1) });
const otpSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

function lastThree(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-3);
}

function getRequestNo(req: Request): string {
  const requestNo = req.params.requestNo;
  return typeof requestNo === 'string' ? requestNo : requestNo?.[0] ?? '';
}

function optionalCovers(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? '').split(',').map((cover) => cover.trim()).filter(Boolean);
}

function assertCanCompare(fields: Record<string, unknown>): void {
  if (String(fields.I2 ?? '').trim()) {
    throw new ApiError('ALREADY_SUBMITTED', 'A package has already been selected.');
  }
}

function getApiOffer(fields: Record<string, unknown>, sumInsured: number) {
  const insurer = String(fields['H1.insurer'] ?? '');
  if (!insurer) return undefined;
  return {
    insurer,
    source: 'api' as const,
    packageRef: String(fields['H1.packageRef'] ?? ''),
    packageName: String(fields['H1.packageName'] ?? ''),
    premium: Number(fields['H1.premium'] ?? 0),
    taxes: Number(fields['H1.taxes'] ?? 0),
    total: Number(fields['H1.total'] ?? 0),
    sumInsured,
    excess: Number(fields['H1.excess'] ?? 0),
    standardCovers: String(fields['H1.standardCovers'] ?? ''),
    optionalCovers: optionalCovers(fields['H1.optionalCovers']),
    validUntil: String(fields['H1.validUntil'] ?? '')
  };
}

function toWebformOffers(rows: Record<string, unknown>[], packageRefs: Set<string>, sumInsured: number) {
  return rows
    .filter((row) => packageRefs.has(String(row.package_ref ?? '')))
    .map((row) => {
      const premiumRate = Number(row.premium_rate ?? row.rate);
      const taxRate = Number(row.tax_rate);
      if (!Number.isFinite(premiumRate) || !Number.isFinite(taxRate)) {
        throw new Error(`Package ${String(row.package_ref ?? '')} has invalid premium or tax rates.`);
      }
      const breakdown = calculatePremiumBreakdown(sumInsured, premiumRate, taxRate);
      return {
        insurer: String(row.insurer ?? ''),
        source: 'webform' as const,
        packageRef: String(row.package_ref ?? ''),
        packageName: packageDisplayName(row),
        ...breakdown,
        sumInsured,
        excess: Number(row.excess ?? 0),
        standardCovers: String(row.standard_covers ?? ''),
        optionalCovers: optionalCovers(row.optional_covers),
        validUntil: String(row.valid_to ?? '')
      };
    });
}

async function getWebformOffers(
  client: WorkHub24Client,
  storedOffers: Awaited<ReturnType<OffersRepository['get']>>,
  sumInsured: number
) {
  const packageRefs = new Set(storedOffers.map((offer) => offer.packageRef));
  if (!packageRefs.size) return [];

  let rows = await client.queryDatastore('ds_package', {});
  const missingNewPackage = storedOffers.some((offer) =>
    offer.packageRef.includes('-NEW-') && !rows.some((row) => String(row.package_ref ?? '') === offer.packageRef)
  );
  if (missingNewPackage) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    rows = await client.queryDatastore('ds_package', {});
  }
  return toWebformOffers(rows, packageRefs, sumInsured);
}

function getSelectedInsurerDetails(fields: Record<string, unknown>, insurer: string) {
  const rows = Array.isArray(fields.F1) ? fields.F1 : [];
  const matchingRow = rows.find((row) => {
    if (typeof row === 'string') return row === insurer;
    if (typeof row !== 'object' || row === null) return false;
    return String((row as Record<string, unknown>)[tableColumnKey('F1', 'insurer')] ?? '') === insurer;
  });
  if (typeof matchingRow !== 'object' || matchingRow === null) {
    return { connection: '', email: '' };
  }
  const row = matchingRow as Record<string, unknown>;
  return {
    connection: String(row[tableColumnKey('F1', 'connection')] ?? ''),
    email: String(row[tableColumnKey('F1', 'insurerEmail')] ?? '')
  };
}

function getFinanceUser(req: Request): { name: string } {
  const session = (req as Request & { session?: { user?: { name?: string } } }).session;
  return { name: String(session?.user?.name ?? '') };
}

export function createFinanceRoutes(
  wh24Client: WorkHub24Client,
  offersRepository: OffersRepository,
  otpAttemptsRepository: OtpAttemptsRepository
) {
  const router = express.Router();

  router.get('/finance/requests/:requestNo/offers', requireSession('finance', true), async (req, res, next) => {
    try {
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');

      const selectedInsurer = String(requestItem.fields.I2 ?? '');
      if (selectedInsurer) {
        await requireOpenTask(wh24Client, requestItem, 'Awaiting OTP Verification');
      } else {
        await requireOpenTask(wh24Client, requestItem, 'Awaiting Package Selection');
        assertCanCompare(requestItem.fields);
      }

      const sumInsured = Number(requestItem.fields.E2 ?? 0);
      const storedOffers = await offersRepository.get(requestNo);
      const apiOffer = getApiOffer(requestItem.fields, sumInsured);
      const offers = [
        ...(await getWebformOffers(wh24Client, storedOffers, sumInsured)),
        ...(apiOffer ? [apiOffer] : [])
      ].sort((a, b) => a.total - b.total);

      const otpStatus = String(requestItem.fields.I7 ?? '');
      const status = selectedInsurer
        ? otpStatus === 'Verified'
          ? 'confirmed'
          : 'awaiting_customer_otp'
        : 'awaiting_selection';
      return res.json({
        request: getRequestSummary(requestItem.fields),
        customer: { name: String(requestItem.fields.B2 ?? ''), mobileLast3: lastThree(String(requestItem.fields.B4 ?? '')) },
        offers,
        status,
        ...(selectedInsurer
          ? {
              selected: {
                insurer: selectedInsurer,
                packageRef: String(requestItem.fields.I5 ?? ''),
                total: Number(requestItem.fields.I5a ?? 0),
                acceptedAt: String(requestItem.fields.I8 ?? '') || undefined
              }
            }
          : {})
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/finance/requests/:requestNo/select', requireSession('finance', true), async (req, res, next) => {
    try {
      const body = selectSchema.parse(req.body);
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');
      await requireOpenTask(wh24Client, requestItem, 'Awaiting Package Selection');
      assertCanCompare(requestItem.fields);

      const sumInsured = Number(requestItem.fields.E2 ?? 0);
      const webformOffers = await getWebformOffers(wh24Client, await offersRepository.get(requestNo), sumInsured);
      const apiOffer = getApiOffer(requestItem.fields, sumInsured);
      const candidates = [...webformOffers, ...(apiOffer ? [apiOffer] : [])];
      const selectedOffer = candidates.find((offer) => offer.insurer === body.insurer && offer.packageRef === body.packageRef);
      if (!selectedOffer) {
        throw new ApiError('VALIDATION', 'Selected package not found for insurer.', {
          fields: { insurer: 'Unknown insurer/package combination.' }
        });
      }

      const details = getSelectedInsurerDetails(requestItem.fields, selectedOffer.insurer);
      const user = getFinanceUser(req);
      const customerOTP = String(randomInt(100000, 1_000_000));
      await wh24Client.updateAndCompleteTask(requestItem.itemId, 'Awaiting Package Selection', () => ({
          I1: user.name,
          I2: selectedOffer.insurer,
          I3: details.connection || (selectedOffer.source === 'api' ? 'API' : 'Webform'),
          I4: details.email,
          I5: selectedOffer.packageRef,
          I5a: selectedOffer.total,
          I11: selectedOffer.packageName,
          I6: customerOTP
        }));
      return res.status(200).json({ mobileLast3: lastThree(String(requestItem.fields.B4 ?? '')) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/finance/requests/:requestNo/customer-otp', requireSession('finance', true), async (req, res, next) => {
    try {
      const body = otpSchema.parse(req.body);
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');
      await requireOpenTask(wh24Client, requestItem, 'Awaiting OTP Verification');
      if (!String(requestItem.fields.I2 ?? '').trim()) {
        throw new ApiError('ALREADY_SUBMITTED', 'A package must be selected before customer verification.');
      }
      if (String(requestItem.fields.I7 ?? '') === 'Verified') {
        throw new ApiError('REQUEST_CLOSED', 'The customer has already confirmed this package.');
      }

      const attempts = await otpAttemptsRepository.get(requestNo);
      if (body.code === String(requestItem.fields.I6 ?? '')) {
        await wh24Client.updateAndCompleteTask(requestItem.itemId, 'Awaiting OTP Verification', () => ({
          I7: 'Verified',
          I8: new Date().toISOString()
        }));
        await otpAttemptsRepository.clear(requestNo);
        return res.json({ result: 'verified', attemptsLeft: 0 });
      }

      const updatedAttempts = await otpAttemptsRepository.increment(requestNo);
      if (updatedAttempts >= 3) {
        await wh24Client.updateAndCompleteTask(requestItem.itemId, 'Awaiting OTP Verification', () => ({
          I6: String(randomInt(100000, 1_000_000)),
          I7: 'Failed'
        }));
        await otpAttemptsRepository.clear(requestNo);
        return res.json({ result: 'new_code_sent', attemptsLeft: 3 });
      }
      return res.json({ result: 'incorrect', attemptsLeft: 3 - updatedAttempts });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
