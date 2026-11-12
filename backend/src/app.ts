import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';

import { config } from './config.js';
import { ApiError, errorResponse } from './errors.js';
import { createAuthRoutes } from './routes/auth.js';
import { createRequestsRoutes } from './routes/requests.js';
import { createInsurerRoutes } from './routes/insurer.js';
import { createFinanceRoutes } from './routes/finance.js';
import mockInsurerRouter from './mockInsurer/router.js';
import { HttpWorkHub24Client } from './wh24/httpClient.js';
import { FakeWorkHub24Client } from './wh24/fakeClient.js';
import type { WorkHub24Client } from './wh24/client.js';
import { JsonOffersRepository, JsonOtpAttemptsRepository, type OffersRepository, type OtpAttemptsRepository } from './services/offersStore.js';

const defaultUploadDirectory = fileURLToPath(new URL('../data/uploads/', import.meta.url));

export function createApp({
  wh24Client,
  offersRepository,
  otpAttemptsRepository,
  uploadDirectory = defaultUploadDirectory
}: {
  wh24Client?: WorkHub24Client;
  offersRepository?: OffersRepository;
  otpAttemptsRepository?: OtpAttemptsRepository;
  uploadDirectory?: string;
} = {}) {
  const app = express();
  const resolvedClient = wh24Client ?? (config.WH24_MODE === 'http' ? new HttpWorkHub24Client() : new FakeWorkHub24Client());
  const resolvedOffersRepository = offersRepository ?? new JsonOffersRepository();
  const resolvedOtpAttemptsRepository = otpAttemptsRepository ?? new JsonOtpAttemptsRepository();

  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN.split(',').map((value) => value.trim()), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/uploads', express.static(uploadDirectory));

  app.use('/api/auth', createAuthRoutes(resolvedClient));
  app.use('/api', createRequestsRoutes(resolvedClient));
  app.use('/api', createInsurerRoutes(resolvedClient, resolvedOffersRepository, uploadDirectory));
  app.use('/api', createFinanceRoutes(resolvedClient, resolvedOffersRepository, resolvedOtpAttemptsRepository));
  app.use('/mock-insurer', mockInsurerRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.') || 'body';
        fields[key] = issue.message;
      }
      return res.status(422).json({ error: { code: 'VALIDATION', message: 'Validation failed.', fields } });
    }

    if (err instanceof ApiError) {
      const status = err.code === 'SESSION_EXPIRED' ? 401 : err.code === 'OTP_LOCKED' ? 429 : err.code === 'LINK_INVALID' ? 404 : err.code === 'NOT_AUTHORISED' ? 403 : err.code === 'REQUEST_CLOSED' ? 410 : err.code === 'DUPLICATE_CHASSIS' || err.code === 'ALREADY_SUBMITTED' || err.code === 'PENDING' || err.code === 'NOT_READY' ? 409 : err.code === 'OTP_INCORRECT' || err.code === 'OTP_EXPIRED' ? 400 : err.code === 'VALIDATION' ? 422 : 500;
      return res.status(status).json(errorResponse(err));
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: { code: 'UNKNOWN', message } });
  });

  return app;
}

export const app = createApp();
