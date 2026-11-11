import crypto from 'node:crypto';

import type { SessionUser } from '../types.js';

const sessionStore = new Map<string, { token: string; user: SessionUser; expiresAt: number; purpose?: string; requestNo?: string }>();

export function issueSession({ user, purpose, requestNo }: { user: SessionUser; purpose?: string; requestNo?: string }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 30 * 60 * 1000;

  sessionStore.set(token, { token, user, expiresAt, purpose, requestNo });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function verifySession(token: string, requestNo?: string) {
  const record = sessionStore.get(token);
  if (!record) {
    throw new Error('SESSION_EXPIRED');
  }
  if (Date.now() > record.expiresAt) {
    sessionStore.delete(token);
    throw new Error('SESSION_EXPIRED');
  }
  if (requestNo && record.requestNo && record.requestNo !== requestNo) {
    throw new Error('NOT_AUTHORISED');
  }
  return record;
}

export function getSessionFromAuthorization(header?: string) {
  if (!header) return undefined;
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return sessionStore.get(token);
}

export function clearSession(token: string) {
  sessionStore.delete(token);
}
