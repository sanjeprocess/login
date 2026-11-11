import crypto from 'node:crypto';

export const OTP_WINDOW_MS = 5 * 60 * 1000;
export const OTP_RESEND_SECONDS = 60;
export const OTP_ATTEMPTS_LIMIT = 3;

interface OtpRecord {
  hash: string;
  salt: string;
  expiresAt: number;
  attempts: number;
  locked: boolean;
  workHubCardId?: string;
}

const otpStore = new Map<string, OtpRecord>();

export function otpKey(email: string, purpose: string, requestNo?: string): string {
  return `${email.toLowerCase()}|${purpose}|${requestNo ?? ''}`;
}

export function generateOtpCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

export function createOtp({ email, purpose, requestNo }: { email: string; purpose: string; requestNo?: string }) {
  const code = generateOtpCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  otpStore.set(otpKey(email, purpose, requestNo), { hash, salt, expiresAt: Date.now() + OTP_WINDOW_MS, attempts: 0, locked: false });
  return code;
}

export function verifyOtp({ email, purpose, requestNo, code }: { email: string; purpose: string; requestNo?: string; code: string }) {
  const key = otpKey(email, purpose, requestNo);
  const record = otpStore.get(key);
  if (!record) {
    return { ok: false, expired: true, attemptsLeft: 0, locked: false };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(key);
    return { ok: false, expired: true, attemptsLeft: 0, locked: false };
  }

  if (record.locked) {
    return { ok: false, expired: false, attemptsLeft: 0, locked: true };
  }

  const hash = crypto.createHash('sha256').update(`${record.salt}:${code}`).digest('hex');
  const isValid = crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), Buffer.from(hash, 'hex'));

  if (isValid) {
    otpStore.delete(key);
    return { ok: true, attemptsLeft: 0, locked: false };
  }

  const nextAttempts = record.attempts + 1;
  record.attempts = nextAttempts;
  const attemptsLeft = Math.max(0, OTP_ATTEMPTS_LIMIT - nextAttempts);
  const locked = nextAttempts >= OTP_ATTEMPTS_LIMIT;
  if (locked) {
    record.locked = true;
    record.expiresAt = Date.now() + OTP_WINDOW_MS;
  }

  return { ok: false, expired: false, attemptsLeft, locked };
}

export function getOtpState(email: string, purpose: string, requestNo?: string) {
  return otpStore.get(otpKey(email, purpose, requestNo));
}

export function setOtpWorkHubCardId(email: string, purpose: string, requestNo: string | undefined, cardId: string): number | undefined {
  const record = otpStore.get(otpKey(email, purpose, requestNo));
  if (!record) return undefined;
  record.workHubCardId = cardId;
  return record.expiresAt;
}

export function takeOtpWorkHubCardId(email: string, purpose: string, requestNo?: string): string | undefined {
  const record = otpStore.get(otpKey(email, purpose, requestNo));
  if (!record) return undefined;
  const cardId = record.workHubCardId;
  record.workHubCardId = undefined;
  return cardId;
}
