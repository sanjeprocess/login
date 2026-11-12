import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/types';

/** A PENDING step is re-checked this often, for at most PENDING_MAX_WAIT_MS. */
export const PENDING_POLL_MS = 3_000;
export const PENDING_MAX_WAIT_MS = 2 * 60 * 1000;

/** Shown while the backend reports PENDING; `slow` once the wait passed PENDING_MAX_WAIT_MS. */
export interface PendingState {
  message: string;
  slow: boolean;
}

/**
 * Load data for a screen once a session exists; exposes reload for after a submit.
 * PENDING (WorkHub24 has not opened this step's task yet) is not an error: the load is re-tried
 * every 3 seconds for up to 2 minutes, with `pending` set meanwhile.
 */
export function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!fn);
  const [pending, setPending] = useState<PendingState | null>(null);
  // Each run gets a number; an older run (or one after unmount) stops polling.
  const runId = useRef(0);
  useEffect(() => () => {
    runId.current += 1;
  }, []);

  const run = useCallback(async () => {
    if (!fn) return;
    const id = ++runId.current;
    const started = Date.now();
    setLoading(true);
    setError(null);
    setPending(null);
    for (;;) {
      try {
        const result = await fn();
        if (id !== runId.current) return;
        setData(result);
        setPending(null);
        break;
      } catch (e) {
        if (id !== runId.current) return;
        const err = e instanceof ApiError ? e : new ApiError('UNKNOWN', (e as Error)?.message);
        if (err.code !== 'PENDING') {
          setPending(null);
          setError(err);
          break;
        }
        const message = err.message && err.message !== 'PENDING' ? err.message : 'Getting the next step ready…';
        if (Date.now() - started >= PENDING_MAX_WAIT_MS) {
          setPending({ message, slow: true });
          break;
        }
        setPending({ message, slow: false });
        await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
        if (id !== runId.current) return;
      }
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, error, loading, pending, reload: run, setData };
}
