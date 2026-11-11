import { randomInt } from 'node:crypto';
import express, { type Request } from 'express';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import { getItemByRequestNo, getRequestSummary } from '../services/requestService.js';
import { requireOpenTask } from '../services/taskAccess.js';
import { normalizePackageRow, priceForPackage, roundCurrency, splitCovers, type PackageRow } from '../services/matching.js';
import type { OffersRepository, OtpAttemptsRepository } from '../services/offersStore.js';
import type { WorkHub24Client } from '../wh24/client.js';
import { REQUEST_STATUS } from '../wh24/fields.js';

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

const optionalCovers = splitCovers;

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

function toWebformOffers(
  packages: PackageRow[],
  storedOffers: Awaited<ReturnType<OffersRepository['get']>>,
  sumInsured: number
) {
  return storedOffers.flatMap((offer) => {
    const pkg = packages.find((candidate) => candidate.packageRef === offer.packageRef);
    if (!pkg) {
      console.warn('Stored offer package is not in the packages view; leaving it out.', {
        requestNo: offer.requestNo,
        packageRef: offer.packageRef
      });
      return [];
    }
    const breakdown = priceForPackage(pkg, sumInsured);
    return [{
      // The offers store records which insurer responded; the package row may only carry a code.
      insurer: offer.insurer || pkg.insurerName,
      source: 'webform' as const,
      packageRef: pkg.packageRef,
      packageName: pkg.name,
      ...breakdown,
      sumInsured,
      excess: pkg.excess,
      standardCovers: pkg.standardCovers,
      optionalCovers: pkg.optionalCovers,
      validUntil: pkg.validTo
    }];
  });
}

async function getWebformOffers(
  client: WorkHub24Client,
  storedOffers: Awaited<ReturnType<OffersRepository['get']>>,
  sumInsured: number
) {
  if (!storedOffers.length) return [];

  // The packages view is never cached, so a package WorkHub24 just created is visible here.
  const load = async () => (await client.queryDatastore('ds_package', {})).map(normalizePackageRow);
  let packages = await load();
  const missingNewPackage = storedOffers.some((offer) =>
    offer.packageRef.includes('-NEW-') && !packages.some((pkg) => pkg.packageRef === offer.packageRef)
  );
  if (missingNewPackage) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    packages = await load();
  }
  return toWebformOffers(packages, storedOffers, sumInsured);
}

/**
 * Selected insurer's email and connection type, from the insurers view
 * (iD, insurerCode, name, connectionType, contactEmail, apiUrl, active), matched by name or code.
 */
async function getSelectedInsurerDetails(client: WorkHub24Client, insurer: string) {
  const rows = await client.queryDatastore('ds_insurer', {});
  const row = rows.find((candidate) => String(candidate.name ?? '') === insurer) ??
    rows.find((candidate) => String(candidate.insurerCode ?? '') === insurer);
  if (!row) {
    console.warn('Selected insurer has no row in the insurers view; email and connection type use fallbacks.', { insurer });
    return { connection: '', email: '' };
  }
  return { connection: String(row.connectionType ?? ''), email: String(row.contactEmail ?? '') };
}

/** Premium totals are written to WH24 as numbers rounded to cents. */
function premiumNumber(value: unknown): number {
  return roundCurrency(Number(value ?? 0));
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

      const details = await getSelectedInsurerDetails(wh24Client, selectedOffer.insurer);
      const user = getFinanceUser(req);
      const customerOTP = String(randomInt(100000, 1_000_000));
      await wh24Client.updateAndCompleteTask(requestItem.itemId, 'Awaiting Package Selection', () => ({
          I1: user.name,
          I2: selectedOffer.insurer,
          I3: details.connection || (selectedOffer.source === 'api' ? 'API' : 'Webform'),
          I4: details.email,
          I5: selectedOffer.packageRef,
          I5a: premiumNumber(selectedOffer.total),
          I11: selectedOffer.packageName,
          I6: customerOTP,
          A3: REQUEST_STATUS.awaitingConsent
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
          I8: new Date().toISOString(),
          // Same number as selectedTotalPremiumLKR, so both totals are written the same way.
          I12: premiumNumber(requestItem.fields.I5a),
          A3: REQUEST_STATUS.awaitingPolicy
        }));
        await otpAttemptsRepository.clear(requestNo);
        return res.json({ result: 'verified', attemptsLeft: 0 });
      }

      const updatedAttempts = await otpAttemptsRepository.increment(requestNo);
      if (updatedAttempts >= 3) {
        // Wrong code three times: a new code is sent; status (A3) stays as it is.
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
