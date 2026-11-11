import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../api/types';

/*
 * The session token lives in sessionStorage, scoped to one screen and one request,
 * so a link for one request never unlocks another. It is cleared when the tab closes.
 */

function read(key: string): Session | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s.expiresAt || new Date(s.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(key);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function write(key: string, s: Session | null) {
  try {
    if (s) sessionStorage.setItem(key, JSON.stringify(s));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: the session simply lasts for this page view */
  }
}

export function sessionKey(screen: string, requestNo?: string) {
  return `mig.session.${screen}.${requestNo || 'new'}`;
}

export function useSession(key: string) {
  const [session, setState] = useState<Session | null>(() => read(key));
  const [expired, setExpired] = useState(false);

  const set = useCallback(
    (s: Session | null) => {
      write(key, s);
      setState(s);
      if (s) setExpired(false);
    },
    [key],
  );

  /** End the session early, e.g. after a successful submit. */
  const end = useCallback(() => set(null), [set]);

  useEffect(() => {
    if (!session) return;
    const ms = new Date(session.expiresAt).getTime() - Date.now();
    const t = setTimeout(() => {
      write(key, null);
      setState(null);
      setExpired(true);
    }, Math.max(0, ms));
    return () => clearTimeout(t);
  }, [session, key]);

  return { session, setSession: set, endSession: end, expired };
}

/** Seconds left until an ISO time, updated every second. */
export function useSecondsLeft(untilIso?: string) {
  const calc = () => (untilIso ? Math.max(0, Math.round((new Date(untilIso).getTime() - Date.now()) / 1000)) : 0);
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    if (!untilIso) return;
    const t = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [untilIso]);
  return left;
}

/** Simple countdown from a number of seconds (used for the resend timer). */
export function useCountdown(start: number, runKey: unknown) {
  const [left, setLeft] = useState(start);
  useEffect(() => {
    setLeft(start);
    if (start <= 0) return;
    const t = setInterval(() => setLeft((x) => (x <= 1 ? (clearInterval(t), 0) : x - 1)), 1000);
    return () => clearInterval(t);
  }, [start, runKey]);
  return left;
}
