import express from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';

import { ApiError } from '../errors.js';
import {
  createOtp,
  getOtpState,
  OTP_WINDOW_MS,
  setOtpWorkHubCardId,
  takeOtpWorkHubCardId,
  verifyOtp
} from '../auth/otpService.js';
import { issueSession } from '../auth/sessionService.js';
import { getItemByRequestNo } from '../services/requestService.js';
import { requireOpenTask } from '../services/taskAccess.js';
import { financePartnerName } from '../services/partners.js';
import { MAX_TASK_WAIT_MS, type WorkHub24Client } from '../wh24/client.js';
import { formatSmsMobile } from '../wh24/mobileFormat.js';

const OTP_TASK_NAME = 'Awaiting Verification';

// Which linked screen the sign-in is for. Screen 2 ("response") and Screen 4 ("binding")
// both use insurer_signin, so the screen decides which WF-01 task must be open.
const screenSchema = z.enum(['response', 'compare', 'binding', 'payment']).optional();
type SignInScreen = z.infer<typeof screenSchema>;

const otpRequestSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(['finance_signin', 'insurer_signin']),
  requestNo: z.string().optional(),
  screen: screenSchema
});

const otpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(['finance_signin', 'insurer_signin']),
  requestNo: z.string().optional(),
  screen: screenSchema
});

function signInTaskName(
  fields: Record<string, unknown>,
  purpose: 'finance_signin' | 'insurer_signin',
  screen: SignInScreen
): string {
  const packageSelected = Boolean(String(fields.I2 ?? '').trim());
  if (purpose === 'finance_signin') {
    if (screen && screen !== 'compare') {
      throw new ApiError('VALIDATION', 'This screen does not accept finance sign-in.');
    }
    // Screen 3 and the customer OTP step share the compare page.
    return packageSelected ? 'Awaiting OTP Verification' : 'Awaiting Package Selection';
  }
  if (screen === 'compare') throw new ApiError('VALIDATION', 'This screen does not accept insurer sign-in.');
  if (screen === 'payment') throw new ApiError('REQUEST_CLOSED', 'This request is closed.');
  if (screen === 'response') return 'Awaiting Insurer Responses';
  if (screen === 'binding') return 'Awaiting Policy Upload';
  return packageSelected ? 'Awaiting Policy Upload' : 'Awaiting Insurer Responses';
}

async function requireSignInTask(
  client: WorkHub24Client,
  card: NonNullable<Awaited<ReturnType<typeof getItemByRequestNo>>>,
  purpose: 'finance_signin' | 'insurer_signin',
  screen: SignInScreen
): Promise<void> {
  await requireOpenTask(client, card, signInTaskName(card.fields, purpose, screen));
}

/**
 * Is the signed-in insurer the one this request is with? Never reads selectedInsurers (F1): the
 * API does not return table rows.
 * - currentInsurer (G4, a name) when filled;
 * - otherwise currentInsurerEmail (G5), mapped to an insurer through the insurers view (contactEmail);
 * - on Screen 4 (binding) and payment, also the selected insurer (I2), as a safety net in case the
 *   current* fields are not filled (only the selected insurer may bind).
 */
async function isLinkedInsurer(
  client: WorkHub24Client,
  fields: Record<string, unknown>,
  insurer: { insurer: string; insurerCode?: string },
  screen: SignInScreen
): Promise<boolean> {
  const matches = (value: string) => Boolean(value) &&
    (value === insurer.insurer || (Boolean(insurer.insurerCode) && value === insurer.insurerCode));

  // Payment is closed to insurers; letting I2 through there shows "request closed", not "not linked".
  if ((screen === 'binding' || screen === 'payment') && matches(String(fields.I2 ?? '').trim())) return true;

  const currentName = String(fields.G4 ?? '').trim();
  if (currentName) return matches(currentName);

  const currentEmail = String(fields.G5 ?? '').trim().toLowerCase();
  if (!currentEmail) return false;
  const rows = await client.queryDatastore('ds_insurer', {});
  const row = rows.find((candidate) => String(candidate.contactEmail ?? '').trim().toLowerCase() === currentEmail);
  if (!row) return false;
  return matches(String(row.name ?? '')) || matches(String(row.insurerCode ?? ''));
}

async function resolveUserByEmail(client: WorkHub24Client, email: string, purpose: 'finance_signin' | 'insurer_signin') {
  const normalized = email.toLowerCase();
  if (purpose === 'finance_signin') {
    const rows = await client.queryDatastore('ds_finance_user', {});
    const matches = rows.filter((row) =>
      row.active === 'Yes' && String(row.email ?? '').toLowerCase() === normalized
    );
    if (matches.length > 1) {
      console.warn('Multiple active finance user rows matched an email; using the first row.', { count: matches.length });
    }
    const row = matches[0];
    if (!row) return null;
    return {
      role: 'finance' as const,
      name: String(row.name ?? ''),
      email: String(row.email ?? ''),
      // Partner NAME, as WF-01 A4 (dynamic dropdown) stores and compares it.
      partner: await financePartnerName(client, String(row.partnerCode ?? '')),
      mobile: String(row.mobile ?? '')
    };
  }

  // Insurer users view keys (probed): iD, userCode, name, email, mobile, insurerCode, active.
  const rows = await client.queryDatastore('ds_insurer_user', {});
  const matches = rows.filter((row) =>
    row.active === 'Yes' && String(row.email ?? '').toLowerCase() === normalized
  );
  if (matches.length > 1) {
    console.warn('Multiple active insurer user rows matched an email; using the first row.', { count: matches.length });
  }
  const row = matches[0];
  if (!row) return null;
  const insurerCode = String(row.insurerCode ?? '');
  // Requests, offers and packages identify the insurer by name; the insurers view
  // (iD, insurerCode, name, connectionType, contactEmail, apiUrl, active) maps code -> name.
  const insurers = await client.queryDatastore('ds_insurer', {});
  const insurerRow = insurers.find((candidate) => String(candidate.insurerCode ?? '') === insurerCode);
  if (!insurerRow) {
    console.warn('Insurer user has an insurerCode with no row in the insurers view.', { insurerCode });
  }
  return {
    role: 'insurer' as const,
    name: String(row.name ?? ''),
    email: String(row.email ?? ''),
    insurer: String(insurerRow?.name ?? '') || insurerCode,
    insurerCode,
    mobile: String(row.mobile ?? '')
  };
}

function maskMobile(mobile: string) {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 4) return mobile;
  return `●●● ●●● ${digits.slice(-4)}`;
}

async function updateWf02OtpResult(client: WorkHub24Client, cardId: string, result: 'Verified' | 'Failed' | 'Expired') {
  // The WF-02 card was created moments ago; "Awaiting Verification" opens only once WH24 has
  // finished "Send OTP Code", so this is the one lookup allowed to wait for its task.
  await client.updateAndCompleteTaskForWorkflow('WF-02', cardId, OTP_TASK_NAME, { oTPResult: result }, {
    waitForTaskMs: MAX_TASK_WAIT_MS
  });
}

async function updateWf02OtpResultBestEffort(
  client: WorkHub24Client,
  cardId: string,
  result: 'Verified' | 'Failed' | 'Expired'
): Promise<void> {
  try {
    await updateWf02OtpResult(client, cardId, result);
  } catch (error) {
    console.warn('WorkHub24 WF-02 OTP result update failed; continuing sign-in.', {
      cardId,
      result,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function scheduleOtpExpiry(
  client: WorkHub24Client,
  email: string,
  purpose: string,
  requestNo: string | undefined,
  cardId: string,
  expiresAt: number
): void {
  const timer = setTimeout(() => {
    const state = getOtpState(email, purpose, requestNo);
    if (!state || state.workHubCardId !== cardId || state.expiresAt > Date.now()) return;
    const pendingCardId = takeOtpWorkHubCardId(email, purpose, requestNo);
    if (pendingCardId) void updateWf02OtpResultBestEffort(client, pendingCardId, 'Expired');
  }, Math.max(0, expiresAt - Date.now()));
  timer.unref();
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
    // No personal data in these logs: never the email, mobile or code.
    const raw = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const enumOrInvalid = (value: unknown, allowed: readonly string[]) =>
      value === undefined ? '(none)' : allowed.includes(String(value)) ? String(value) : '(invalid)';
    console.info('OTP request received', {
      screen: enumOrInvalid(raw.screen, ['response', 'compare', 'binding', 'payment']),
      purpose: enumOrInvalid(raw.purpose, ['finance_signin', 'insurer_signin'])
    });
    try {
      const body = otpRequestSchema.parse(req.body);
      if (body.requestNo) {
        const requestItem = await getItemByRequestNo(wh24Client, body.requestNo);
        if (!requestItem) {
          throw new ApiError('LINK_INVALID', 'Request link is invalid.');
        }
        const linkedUser = await resolveUserByEmail(wh24Client, body.email, body.purpose);
        const requestFields = requestItem.fields;
        const linkedByFinance = linkedUser?.role === 'finance' && String(requestFields.A4 ?? '') === linkedUser.partner;
        const linkedByInsurer = linkedUser?.role === 'insurer' &&
          await isLinkedInsurer(wh24Client, requestFields, linkedUser, body.screen);
        if (body.purpose === 'finance_signin' && !linkedByFinance) {
          throw new ApiError('NOT_AUTHORISED', 'Finance user is not linked to this request.');
        }
        if (body.purpose === 'insurer_signin' && !linkedByInsurer) {
          throw new ApiError('NOT_AUTHORISED', 'Insurer is not linked to this request.');
        }
        await requireSignInTask(wh24Client, requestItem, body.purpose, body.screen);
      }

      const user = await resolveUserByEmail(wh24Client, body.email, body.purpose);
      if (user) {
        const oldCardId = takeOtpWorkHubCardId(user.email, body.purpose, body.requestNo);
        if (oldCardId) await updateWf02OtpResultBestEffort(wh24Client, oldCardId, 'Expired');

        const code = createOtp({ email: user.email, purpose: body.purpose, requestNo: body.requestNo });
        const maskedMobile = maskMobile(user.mobile);
        const wh24Purpose = body.purpose === 'finance_signin' ? 'Finance User Sign-in' : 'Insurer Sign-in';
        const created = await wh24Client.createItem('WF-02', {
          receipentEmail: user.email,
          oTPMobile: formatSmsMobile(user.mobile),
          mobile: maskedMobile,
          oTPCode: code,
          purpose: wh24Purpose,
          requestRef: body.requestNo ?? '',
          sentAt: new Date().toISOString(),
          title: `OTP · ${wh24Purpose} · ${maskedMobile}`
        });
        console.info('WF-02 card created', { id: created.itemId, purpose: body.purpose });
        if (!created.title?.trim()) {
          console.warn('WorkHub24 created a WF-02 card without a title.', { itemId: created.itemId });
        }
        const expiresAt = setOtpWorkHubCardId(user.email, body.purpose, body.requestNo, created.itemId);
        if (expiresAt !== undefined) {
          scheduleOtpExpiry(wh24Client, user.email, body.purpose, body.requestNo, created.itemId, expiresAt);
        }
      } else {
        // Still answers 200 so emails can't be tested, but say why no SMS will arrive.
        const view = body.purpose === 'finance_signin' ? 'finance users' : 'insurer users';
        console.warn(`OTP request: no active user in the ${view} view matched the email; no WF-02 card created.`, {
          purpose: body.purpose
        });
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
        await requireSignInTask(wh24Client, requestItem, body.purpose, body.screen);
      }

      const previousOtpCardId = getOtpState(body.email, body.purpose, body.requestNo)?.workHubCardId;
      const otpResult = verifyOtp({ email: body.email, purpose: body.purpose, requestNo: body.requestNo, code: body.code });
      if (otpResult.ok || otpResult.expired || otpResult.locked) {
        const cardId = takeOtpWorkHubCardId(body.email, body.purpose, body.requestNo) ?? previousOtpCardId;
        if (cardId) {
          const result = otpResult.ok ? 'Verified' : otpResult.expired ? 'Expired' : 'Failed';
          void updateWf02OtpResultBestEffort(wh24Client, cardId, result);
        }
      }
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

      const session = issueSession({ user: { name: user.name, email: user.email, role: user.role, ...(user.role === 'finance' ? { partner: user.partner } : { insurer: user.insurer, insurerCode: user.insurerCode }), }, purpose: body.purpose, requestNo: body.requestNo });

      return res.status(200).json({
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          name: user.name,
          email: user.email,
          role: user.role,
          ...(user.role === 'finance' ? { partner: user.partner } : { insurer: user.insurer })
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
