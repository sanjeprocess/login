import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { ApiError } from '../errors.js';

const quoteSchema = z.object({
  requestNo: z.string(),
  vehicleCategory: z.string(),
  coverType: z.string(),
  sumInsured: z.number().positive(),
  year: z.number().int(),
  usage: z.string(),
  optionalCovers: z.array(z.string()).optional().default([])
});

const bindSchema = z.object({
  requestNo: z.string(),
  packageRef: z.string(),
  customer: z.object({ name: z.string() }),
  vehicle: z.object({ description: z.string() }),
  policyStartDate: z.string()
});

const router = express.Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.headers['x-mock-key'] !== config.MOCK_INSURER_KEY) {
    return next(new ApiError('NOT_AUTHORISED', 'Invalid mock insurer key.'));
  }
  return next();
});

router.post('/quote', (req: Request, res: Response) => {
  const parsed = quoteSchema.parse(req.body);
  const premium = Number(((parsed.sumInsured * 2.9) / 100).toFixed(2));
  const taxes = Number(((premium * 21) / 100).toFixed(2));
  const total = Number((premium + taxes).toFixed(2));

  return res.json({
    packageRef: 'C-API-PRIME',
    name: 'Prime Motor',
    premium,
    taxes,
    total,
    excess: 20000,
    standardCovers: 'Basic cover',
    optionalCovers: parsed.optionalCovers,
    validUntil: '2026-12-31'
  });
});

router.post('/bind', (req: Request, res: Response) => {
  const parsed = bindSchema.parse(req.body);
  const start = new Date(parsed.policyStartDate);
  const expiry = new Date(start);
  expiry.setFullYear(start.getFullYear() + 1);
  expiry.setDate(expiry.getDate() - 1);
  const ref = `C/MV/${new Date().getFullYear()}/${Math.floor(100000 + Math.random() * 900000)}`;

  return res.json({
    quotationRef: `Q-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    policyNumber: ref,
    policyStartDate: parsed.policyStartDate,
    policyExpiryDate: expiry.toISOString().slice(0, 10)
  });
});

export default router;
