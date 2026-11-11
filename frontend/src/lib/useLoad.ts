import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/types';

/** Load data for a screen once a session exists; exposes reload for after a submit. */
export function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!fn);

  const run = useCallback(async () => {
    if (!fn) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('UNKNOWN', (e as Error)?.message));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, error, loading, reload: run, setData };
}
