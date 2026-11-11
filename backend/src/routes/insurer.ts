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
import { calculatePremiumBreakdown } from '../services/matching.js';
import { JsonOffersRepository, type OffersRepository, type StoredOffer } from '../services/offersStore.js';
import type { WorkHub24Client } from '../wh24/client.js';
import { config } from '../config.js';

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

function getRequestNo(req: Request): string {
  const requestNo = req.params.requestNo;
  return typeof requestNo === 'string' ? requestNo : requestNo?.[0] ?? '';
}

function asOptionalCovers(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? '').split(',').map((cover) => cover.trim()).filter(Boolean);
}

function packageDetails(row: Record<string, unknown>, sumInsured: number) {
  const premiumRate = Number(row.premium_rate ?? row.rate);
  const taxRate = Number(row.tax_rate);
  if (!Number.isFinite(premiumRate) || !Number.isFinite(taxRate)) {
    throw new Error('The package view row is missing a valid premium_rate or tax_rate.');
  }
  const breakdown = calculatePremiumBreakdown(sumInsured, premiumRate, taxRate);
  return {
    packageRef: String(row.package_ref ?? ''),
    name: String(row.name ?? row.package_ref ?? ''),
    premiumRate,
    premium: breakdown.premium,
    taxes: breakdown.taxes,
    total: breakdown.total,
    excess: Number(row.excess ?? 0),
    standardCovers: String(row.standard_covers ?? ''),
    optionalCovers: asOptionalCovers(row.optional_covers),
    validUntil: String(row.valid_to ?? '')
  };
}

function packageView(rows: Record<string, unknown>[], insurer: string, item: { fields: Record<string, unknown> }) {
  const vehicleCategory = String(item.fields.C1 ?? '');
  const coverType = String(item.fields.E1 ?? '');
  const sumInsured = Number(item.fields.E2 ?? 0);
  return rows
    .filter((row) => {
      const validTo = String(row.valid_to ?? '');
      return String(row.insurer ?? '') === insurer &&
        String(row.vehicle_category ?? '') === vehicleCategory &&
        String(row.cover_type ?? '') === coverType &&
        Number(row.sum_min ?? 0) <= sumInsured &&
        sumInsured <= Number(row.sum_max ?? Number.MAX_SAFE_INTEGER) &&
        Boolean(validTo) &&
        new Date(validTo) >= new Date();
    })
    .map((row) => packageDetails(row, sumInsured));
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
      const previousOffers = await offersRepository.get(requestNo);
      const submissionOffer = previousOffers.find((offer) => offer.insurer === insurerName);
      await requireOpenTask(wh24Client, requestItem, 'Awaiting Insurer Responses');
      const rows = await wh24Client.queryDatastore('ds_package', {});
      const recommended = packageView(rows, insurerName, requestItem);
      const submittedPackage = submissionOffer
        ? rows.find((row) => String(row.package_ref ?? '') === submissionOffer.packageRef)
        : undefined;
      const sumInsured = Number(requestItem.fields.E2 ?? 0);
      const packageInfo = submittedPackage
        ? packageDetails(submittedPackage, sumInsured)
        : submissionOffer
          ? {
              packageRef: submissionOffer.packageRef,
              name: String(requestItem.fields.G9 ?? submissionOffer.packageRef),
              premiumRate: Number(requestItem.fields.G14 ?? 0),
              premium: Number(((sumInsured * Number(requestItem.fields.G14 ?? 0)) / 100).toFixed(2)),
              taxes: Number((((sumInsured * Number(requestItem.fields.G14 ?? 0)) / 100 * Number(requestItem.fields.G15 ?? 0)) / 100).toFixed(2)),
              total: Number((((sumInsured * Number(requestItem.fields.G14 ?? 0)) / 100) *
                (1 + Number(requestItem.fields.G15 ?? 0) / 100)).toFixed(2)),
              excess: Number(requestItem.fields.G16 ?? 0),
              validUntil: String(requestItem.fields.G18 ?? ''),
              standardCovers: String(requestItem.fields.G17 ?? ''),
              optionalCovers: asOptionalCovers(requestItem.fields.G21)
            }
          : undefined;
      const submission = submissionOffer && packageInfo
        ? {
            submittedBy: submissionOffer.respondedBy,
            submittedAt: submissionOffer.respondedAt,
            package: packageInfo
          }
        : undefined;

      return res.json({
        request: getRequestSummary(requestItem.fields),
        insurerName,
        recommended,
        vehicleCategories: [...new Set(rows.map((row) => String(row.vehicle_category ?? '')).filter(Boolean))],
        ...(submission ? { submission } : {})
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
      const status = String(requestItem.fields.A3 ?? '');
      if (status === 'Completed') throw new ApiError('REQUEST_CLOSED', 'This request has already been completed.');
      if (status !== 'Awaiting Quotes') {
        throw new ApiError('ALREADY_SUBMITTED', 'This step is not available for this request.');
      }

      const insurerName = getInsurerName(req);
      const sumInsured = Number(requestItem.fields.E2 ?? 0);
      let packageRef: string;
      let packageFields: Record<string, unknown>;
      if (body.mode === 'stored') {
        const rows = await wh24Client.queryDatastore('ds_package', {});
        const recommended = packageView(rows, insurerName, requestItem);
        const selected = recommended.find((candidate) => candidate.packageRef === body.packageRef);
        const selectedRow = rows.find((row) =>
          String(row.insurer ?? '') === insurerName &&
          String(row.package_ref ?? '') === body.packageRef &&
          String(row.vehicle_category ?? '') === String(requestItem.fields.C1 ?? '') &&
          String(row.cover_type ?? '') === String(requestItem.fields.E1 ?? '')
        );
        if (!selected || !selectedRow) {
          throw new ApiError('VALIDATION', 'Selected package not found for insurer.', {
            fields: { packageRef: 'Unknown or unavailable package.' }
          });
        }
        packageRef = String(selectedRow.package_ref ?? '');
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
        packageRef = `${insurerCode(insurerName)}-NEW-${requestNo}`;
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
      }

      await wh24Client.updateAndCompleteTask(
        requestItem.itemId,
        'Awaiting Insurer Responses',
        async () => {
          const user = getSessionUser(req);
          const result = await offersRepository.add({
            requestNo,
            insurer: insurerName,
            packageRef,
            respondedBy: user.email || user.name,
            respondedAt: new Date().toISOString()
          });
          if (!result.added) throw new ApiError('ALREADY_SUBMITTED', 'This insurer has already submitted a response.');
          return packageFields;
        }
      );

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
            J7: remarks
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
