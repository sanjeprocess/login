import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { ApiError } from '../errors.js';
import { requireSession } from '../auth/middleware.js';
import { getItemByRequestNo, getRequestSummary } from '../services/requestService.js';
import { requireOpenTask } from '../services/taskAccess.js';
import {
  isRecommendable,
  normalizePackageRow,
  packageBelongsTo,
  priceForPackage,
  type PackageRow
} from '../services/matching.js';
import { JsonOffersRepository, type OffersRepository } from '../services/offersStore.js';
import type { WorkHub24Client } from '../wh24/client.js';
import { FIELD_MAP, REQUEST_STATUS } from '../wh24/fields.js';
import { config } from '../config.js';

// "Current Package Insurer Code" (WF-01). Written only once its API key is in
// config/wf01-field-map.json: an unmapped id would be sent to WH24 as the raw id.
export const CURRENT_PACKAGE_INSURER_CODE = 'G7a';
let warnedInsurerCodeUnmapped = false;

const responseSchema = z.union([
  z.object({ mode: z.literal('stored'), packageRef: z.string().min(1), remarks: z.string().optional() }),
  z.object({
    mode: z.literal('new'),
    remarks: z.string().optional(),
    package: z.object({
      name: z.string().min(1),
      coverType: z.enum(['Comprehensive', 'Third Party']),
      vehicleCategory: z.string().min(1),
      sumMin: z.number().positive(),
      sumMax: z.number().positive(),
      premiumRate: z.number().nonnegative(),
      taxes: z.number().nonnegative(),
      excess: z.number().nonnegative(),
      standardCovers: z.string(),
      optionalCovers: z.array(z.string()),
      validUntil: z.string().min(1)
    })
  })
]);

const bindingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const allowed = /application\/pdf|image\/png|image\/jpeg|image\/jpg/i.test(file.mimetype) || file.originalname.toLowerCase().endsWith('.pdf');
    if (!allowed) return cb(new Error('Invalid file type'));
    return cb(null, true);
  }
});

function getInsurerName(req: Request): string {
  const session = (req as Request & { session?: { user?: { insurer?: string } } }).session;
  return String(session?.user?.insurer ?? '');
}

function getInsurerIdentity(req: Request): { name: string; code: string } {
  const session = (req as Request & { session?: { user?: { insurer?: string; insurerCode?: string } } }).session;
  return { name: String(session?.user?.insurer ?? ''), code: String(session?.user?.insurerCode ?? '') };
}

function getRequestNo(req: Request): string {
  const requestNo = req.params.requestNo;
  return typeof requestNo === 'string' ? requestNo : requestNo?.[0] ?? '';
}

function packageDetails(pkg: PackageRow, sumInsured: number) {
  const breakdown = priceForPackage(pkg, sumInsured);
  return {
    packageRef: pkg.packageRef,
    name: pkg.name,
    premiumRate: pkg.premiumRate,
    premium: breakdown.premium,
    taxes: breakdown.taxes,
    total: breakdown.total,
    excess: pkg.excess,
    standardCovers: pkg.standardCovers,
    optionalCovers: pkg.optionalCovers,
    validUntil: pkg.validTo
  };
}

function recommendedPackages(packages: PackageRow[], insurer: { name: string; code: string }, item: { fields: Record<string, unknown> }) {
  const vehicleCategory = String(item.fields.C1 ?? '');
  const coverType = String(item.fields.E1 ?? '');
  const sumInsured = Number(item.fields.E2 ?? 0);
  return packages.filter((pkg) =>
    packageBelongsTo(pkg, insurer) && isRecommendable(pkg, vehicleCategory, coverType, sumInsured)
  );
}

async function loadPackages(client: WorkHub24Client): Promise<PackageRow[]> {
  return (await client.queryDatastore('ds_package', {})).map(normalizePackageRow);
}

function getSessionUser(req: Request): { name: string; email: string } {
  const session = (req as Request & { session?: { user?: { name?: string; email?: string } } }).session;
  return { name: String(session?.user?.name ?? ''), email: String(session?.user?.email ?? '') };
}

function insurerCode(insurer: string): string {
  const code = insurer.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!code) throw new Error('Insurer name cannot be converted to a package reference code.');
  return code;
}

async function saveBindingFile(file: Express.Multer.File, uploadDirectory: string): Promise<string> {
  await mkdir(uploadDirectory, { recursive: true });
  const extension = extname(file.originalname).toLowerCase();
  const fileName = `${randomUUID()}${extension}`;
  const path = join(uploadDirectory, fileName);
  await writeFile(path, file.buffer, { flag: 'wx' });
  return `${config.BACKEND_PUBLIC_URL.replace(/\/+$/, '')}/uploads/${encodeURIComponent(fileName)}`;
}

export function createInsurerRoutes(
  wh24Client: WorkHub24Client,
  offersRepository: OffersRepository = new JsonOffersRepository(),
  uploadDirectory = fileURLToPath(new URL('../../data/uploads/', import.meta.url))
) {
  const router = express.Router();

  router.get('/insurer/requests/:requestNo/response', requireSession('insurer', true), async (req, res, next) => {
    try {
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');
      const insurerName = getInsurerName(req);
      // The open task is the only gate. A stored offer is written only after the task completes,
      // so an offer seen while the task is still open is a half-finished attempt and may be resubmitted.
      await requireOpenTask(wh24Client, requestItem, 'Awaiting Insurer Responses');
      const packages = await loadPackages(wh24Client);
      const sumInsured = Number(requestItem.fields.E2 ?? 0);
      const recommended = recommendedPackages(packages, getInsurerIdentity(req), requestItem)
        .map((pkg) => packageDetails(pkg, sumInsured));

      return res.json({
        request: getRequestSummary(requestItem.fields),
        insurerName,
        recommended,
        vehicleCategories: [...new Set(packages.map((pkg) => pkg.vehicleCategory).filter(Boolean))]
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/insurer/requests/:requestNo/response', requireSession('insurer', true), async (req, res, next) => {
    try {
      const body = responseSchema.parse(req.body);
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');
      // Access is decided by the open WF-01 task, not by Status. updateAndCompleteTask
      // checks again under the card lock before writing.
      await requireOpenTask(wh24Client, requestItem, 'Awaiting Insurer Responses');

      const insurerName = getInsurerName(req);
      const sumInsured = Number(requestItem.fields.E2 ?? 0);
      let packageRef: string;
      let packageFields: Record<string, unknown>;
      if (body.mode === 'stored') {
        const packages = await loadPackages(wh24Client);
        const selected = recommendedPackages(packages, getInsurerIdentity(req), requestItem)
          .find((pkg) => pkg.packageRef === body.packageRef);
        if (!selected) {
          throw new ApiError('VALIDATION', 'Selected package not found for insurer.', {
            fields: { packageRef: 'Unknown or unavailable package.' }
          });
        }
        packageRef = selected.packageRef;
        // Existing package: only flag it. The package itself is already in the packages store.
        packageFields = { G19: 'No' };
      } else {
        if (body.package.coverType !== String(requestItem.fields.E1 ?? '') ||
            body.package.vehicleCategory !== String(requestItem.fields.C1 ?? '')) {
          throw new ApiError('VALIDATION', 'Package cover and vehicle category must match the request.', {
            fields: { package: 'Package cover and vehicle category must match the request.' }
          });
        }
        if (body.package.sumMin > body.package.sumMax ||
            sumInsured < body.package.sumMin || sumInsured > body.package.sumMax) {
          throw new ApiError('VALIDATION', 'The request sum insured is outside this package range.', {
            fields: { package: 'Package range must include the request sum insured.' }
          });
        }
        const identity = getInsurerIdentity(req);
        packageRef = `${insurerCode(identity.code || insurerName)}-NEW-${requestNo}`;
        const premiumRate = body.package.premiumRate;
        const premium = (sumInsured * premiumRate) / 100;
        const taxRate = premium === 0 ? 0 : Number(((body.package.taxes / premium) * 100).toFixed(4));
        packageFields = {
          G7: insurerName,
          G8: packageRef,
          G9: body.package.name,
          G10: body.package.vehicleCategory,
          G11: body.package.coverType,
          G12: body.package.sumMin,
          G13: body.package.sumMax,
          G14: premiumRate,
          G15: taxRate,
          G16: body.package.excess,
          G17: body.package.standardCovers,
          G18: body.package.validUntil,
          G19: 'Yes',
          G21: body.package.optionalCovers
        };
        if (FIELD_MAP[CURRENT_PACKAGE_INSURER_CODE]) {
          packageFields[CURRENT_PACKAGE_INSURER_CODE] = identity.code;
        } else if (!warnedInsurerCodeUnmapped) {
          warnedInsurerCodeUnmapped = true;
          console.warn(`Current Package Insurer Code not written: add "${CURRENT_PACKAGE_INSURER_CODE}" to config/wf01-field-map.json once its key is confirmed.`);
        }
      }

      // WH24 first: if the PUT or the task completion fails, nothing is stored and the insurer
      // can retry. An offer left by an earlier half-finished attempt (task still open) is overwritten.
      await wh24Client.updateAndCompleteTask(requestItem.itemId, 'Awaiting Insurer Responses', () => ({
        ...packageFields,
        // Each request has exactly one insurer, so this first response is also the last one:
        // the request is now waiting for package selection.
        A3: REQUEST_STATUS.awaitingSelection
      }));

      const user = getSessionUser(req);
      try {
        await offersRepository.save({
          requestNo,
          insurer: insurerName,
          packageRef,
          respondedBy: user.email || user.name,
          respondedAt: new Date().toISOString()
        });
      } catch (error) {
        // The WH24 task is already complete, so a retry would be refused. Log enough to repair it.
        console.error('Insurer response was completed in WorkHub24 but the offer could not be stored.', {
          requestNo,
          insurer: insurerName,
          packageRef,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }

      return res.status(204).send();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/insurer/requests/:requestNo/binding', requireSession('insurer', true), async (req, res, next) => {
    try {
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');
      await requireOpenTask(wh24Client, requestItem, 'Awaiting Policy Upload');
      const insurerName = getInsurerName(req);
      if (String(requestItem.fields.I2 ?? '') !== insurerName) {
        throw new ApiError('NOT_AUTHORISED', 'This insurer is not selected for this request.');
      }

      return res.json({
        request: getRequestSummary(requestItem.fields),
        insurerName,
        accepted: {
          packageName: String(requestItem.fields.I11 ?? ''),
          packageRef: String(requestItem.fields.I5 ?? ''),
          total: Number(requestItem.fields.I5a ?? 0),
          acceptedAt: String(requestItem.fields.I13 ?? '')
        },
        customer: {
          name: String(requestItem.fields.B2 ?? ''),
          idNumber: String(requestItem.fields.B3 ?? ''),
          mobile: String(requestItem.fields.B4 ?? ''),
          address: String(requestItem.fields.B6 ?? '')
        },
        vehicle: {
          description: `${String(requestItem.fields.C2 ?? '')} ${String(requestItem.fields.C3 ?? '')}`.trim(),
          registrationNo: String(requestItem.fields.C6 ?? ''),
          chassisNo: String(requestItem.fields.C7 ?? ''),
          engineNo: String(requestItem.fields.C8 ?? '')
        },
        interestedParty: `${String(requestItem.fields.A4 ?? '')} (${String(requestItem.fields.D1 ?? '')})`,
        policyStartDate: String(requestItem.fields.E4 ?? ''),
        ...(requestItem.fields.J3
          ? {
              submitted: {
                policyNumber: String(requestItem.fields.J3),
                submittedAt: String(requestItem.fields.I13 ?? ''),
                expiryDate: String(requestItem.fields.J5 ?? ''),
                documents: 0
              }
            }
          : {})
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/insurer/requests/:requestNo/binding', requireSession('insurer', true), bindingUpload.fields([
    { name: 'quotationFile', maxCount: 1 },
    { name: 'policyFiles', maxCount: 10 }
  ]), async (req, res, next) => {
    try {
      const requestNo = getRequestNo(req);
      const requestItem = await getItemByRequestNo(wh24Client, requestNo);
      if (!requestItem) throw new ApiError('LINK_INVALID', 'Request link is invalid.');
      await requireOpenTask(wh24Client, requestItem, 'Awaiting Policy Upload');
      const insurerName = getInsurerName(req);
      if (String(requestItem.fields.I2 ?? '') !== insurerName) {
        throw new ApiError('NOT_AUTHORISED', 'This insurer is not selected for this request.');
      }

      const fields = z.object({
        quotationRef: z.string(),
        policyNumber: z.string().trim().min(1),
        policyStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        policyExpiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        remarks: z.string().optional()
      }).parse(req.body);
      const files = req.files as { quotationFile?: Express.Multer.File[]; policyFiles?: Express.Multer.File[] };
      const quote = files.quotationFile?.[0];
      const policies = files.policyFiles ?? [];
      if (!quote || !quote.originalname.toLowerCase().endsWith('.pdf')) {
        throw new ApiError('VALIDATION', 'A PDF quotation document is required.', {
          fields: { quotationFile: 'Required PDF file.' }
        });
      }
      if (!policies.length) {
        throw new ApiError('VALIDATION', 'At least one policy document is required.', {
          fields: { policyFiles: 'At least one policy document is required.' }
        });
      }

      await wh24Client.updateAndCompleteTask(
        requestItem.itemId,
        'Awaiting Policy Upload',
        async () => {
          const quotationUrl = await saveBindingFile(quote, uploadDirectory);
          const policyUrls = await Promise.all(policies.map((file) => saveBindingFile(file, uploadDirectory)));
          const remarks = [
            fields.remarks?.trim(),
            `Quotation document: ${quotationUrl}`,
            ...policyUrls.map((url) => `Policy document: ${url}`)
          ].filter(Boolean).join('\n');
          return {
            J1: fields.quotationRef,
            J3: fields.policyNumber,
            J4: fields.policyStartDate,
            J5: fields.policyExpiryDate,
            J7: remarks,
            A3: REQUEST_STATUS.completed
          };
        }
      );
      return res.status(204).send();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/insurer/requests/:requestNo/payment', requireSession('insurer', true), (_req, _res, next) => {
    return next(new ApiError('REQUEST_CLOSED', 'This request is closed.'));
  });

  router.post('/insurer/requests/:requestNo/payment', requireSession('insurer', true), (_req, _res, next) => {
    return next(new ApiError('REQUEST_CLOSED', 'This request is closed.'));
  });

  return router;
}
