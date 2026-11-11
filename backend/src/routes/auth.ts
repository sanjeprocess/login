import express from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../errors.js';
import { createOtp, verifyOtp } from '../auth/otpService.js';
import { issueSession } from '../auth/sessionService.js';
import { getItemByRequestNo } from '../services/requestService.js';
import { requireOpenTask } from '../services/taskAccess.js';
import type { WorkHub24Client } from '../wh24/client.js';

const otpRequestSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(['finance_signin', 'insurer_signin']),
  requestNo: z.string().optional()
});

const otpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(['finance_signin', 'insurer_signin']),
  requestNo: z.string().optional()
});

async function requireSignInTask(
  client: WorkHub24Client,
  card: NonNullable<Awaited<ReturnType<typeof getItemByRequestNo>>>,
  purpose: 'finance_signin' | 'insurer_signin'
): Promise<void> {
  const taskName = purpose === 'insurer_signin'
    ? 'Awaiting Insurer Responses'
    : String(card.fields.I2 ?? '').trim()
      ? 'Awaiting OTP Verification'
      : 'Awaiting Package Selection';
  await requireOpenTask(client, card, taskName);
}

async function resolveUserByEmail(client: WorkHub24Client, email: string, purpose: 'finance_signin' | 'insurer_signin') {
  const normalized = email.toLowerCase();
  if (purpose === 'finance_signin') {
    const rows = await client.queryDatastore('ds_finance_user', { email: normalized });
    if (!rows.length) return null;
    const row = rows[0];
    return { role: 'finance' as const, name: String(row.name ?? ''), email: String(row.email ?? ''), partner: String(row.partner ?? ''), branch: String(row.branch ?? ''), mobile: String(row.mobile ?? '') };
  }

  const rows = await client.queryDatastore('ds_insurer_user', { email: normalized });
  if (!rows.length) return null;
  const row = rows[0];
  return { role: 'insurer' as const, name: String(row.name ?? ''), email: String(row.email ?? ''), insurer: String(row.insurer ?? ''), department: String(row.department ?? ''), mobile: String(row.mobile ?? '') };
}

function maskMobile(mobile: string) {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 4) return mobile;
  return `●●● ●●● ${digits.slice(-4)}`;
}

export function createAuthRoutes(wh24Client: WorkHub24Client) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'VALIDATION', message: 'Too many OTP requests.' } },
    statusCode: 429
  });

  router.post('/otp/request', limiter, async (req, res, next) => {
    try {
      const body = otpRequestSchema.parse(req.body);
      if (body.requestNo) {
        const requestItem = await getItemByRequestNo(wh24Client, body.requestNo);
        if (!requestItem) {
          throw new ApiError('LINK_INVALID', 'Request link is invalid.');
        }
        const linkedUser = await resolveUserByEmail(wh24Client, body.email, body.purpose);
        const requestFields = requestItem.fields;
        const insurerNames = Array.isArray(requestFields.F1) ? requestFields.F1.map((value) => String(value)) : [];
        const linkedByFinance = linkedUser?.role === 'finance' && String(requestFields.A4 ?? '') === linkedUser.partner;
        const linkedByInsurer = linkedUser?.role === 'insurer' && insurerNames.includes(String(linkedUser.insurer ?? ''));
        if (body.purpose === 'finance_signin' && !linkedByFinance) {
          throw new ApiError('NOT_AUTHORISED', 'Finance user is not linked to this request.');
        }
        if (body.purpose === 'insurer_signin' && !linkedByInsurer) {
          throw new ApiError('NOT_AUTHORISED', 'Insurer is not linked to this request.');
        }
        await requireSignInTask(wh24Client, requestItem, body.purpose);
      }

      const user = await resolveUserByEmail(wh24Client, body.email, body.purpose);
      if (user) {
        const code = createOtp({ email: user.email, purpose: body.purpose, requestNo: body.requestNo });
        const maskedMobile = maskMobile(user.mobile);
        const created = await wh24Client.createItem('WF-02', {
          title: `OTP · ${body.purpose} · ${maskedMobile}`,
          O1: body.requestNo ?? '',
          O2: body.purpose,
          O3: user.email,
          O4: user.mobile,
          O5: code,
          O7: maskedMobile
        });
        if (!created.title?.trim()) {
          console.warn('WorkHub24 created a WF-02 card without a title.', { itemId: created.itemId });
        }
      }

      return res.status(200).json({ resendAfterSeconds: 60 });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/otp/verify', async (req, res, next) => {
    try {
      const body = otpVerifySchema.parse(req.body);
      if (body.requestNo) {
        const requestItem = await getItemByRequestNo(wh24Client, body.requestNo);
        if (!requestItem) {
          throw new ApiError('LINK_INVALID', 'Request link is invalid.');
        }
        await requireSignInTask(wh24Client, requestItem, body.purpose);
      }

      const otpResult = verifyOtp({ email: body.email, purpose: body.purpose, requestNo: body.requestNo, code: body.code });
      if (!otpResult.ok) {
        if (otpResult.expired) {
          throw new ApiError('OTP_EXPIRED', 'That code has expired.');
        }
        if (otpResult.locked) {
          throw new ApiError('OTP_LOCKED', 'This code has been locked.');
        }
        throw new ApiError('OTP_INCORRECT', 'That code is not correct.', { attemptsLeft: otpResult.attemptsLeft });
      }

      const user = await resolveUserByEmail(wh24Client, body.email, body.purpose);
      if (!user) {
        throw new ApiError('NOT_AUTHORISED', 'User is not recognised.');
      }

      const session = issueSession({ user: { name: user.name, email: user.email, role: user.role, ...(user.role === 'finance' ? { partner: user.partner, branch: user.branch } : { insurer: user.insurer, department: user.department }), }, purpose: body.purpose, requestNo: body.requestNo });

      return res.status(200).json({
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          name: user.name,
          email: user.email,
          role: user.role,
          ...(user.role === 'finance' ? { partner: user.partner, branch: user.branch } : { insurer: user.insurer, department: user.department })
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
