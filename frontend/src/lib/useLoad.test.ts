import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/types';
import { PENDING_MAX_WAIT_MS, PENDING_POLL_MS, useLoad } from './useLoad';

const pendingError = () => new ApiError('PENDING', 'Sending the code to the customer…');

describe('useLoad and PENDING', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-checks every 3 seconds while the step is pending, then shows the data', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(pendingError())
      .mockRejectedValueOnce(pendingError())
      .mockResolvedValueOnce('ready');
    const { result } = renderHook(() => useLoad(fn, []));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.pending).toEqual({ message: 'Sending the code to the customer…', slow: false });
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 2);
    });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.current.pending).toBeNull();
    expect(result.current.data).toBe('ready');
  });

  it('stops after 2 minutes and flags the wait as slow', async () => {
    const fn = vi.fn().mockRejectedValue(pendingError());
    const { result } = renderHook(() => useLoad(fn, []));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_MAX_WAIT_MS + PENDING_POLL_MS);
    });
    expect(result.current.pending?.slow).toBe(true);
    const calls = fn.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 5);
    });
    expect(fn).toHaveBeenCalledTimes(calls);
    // 0 s, then every 3 s up to 120 s.
    expect(calls).toBe(PENDING_MAX_WAIT_MS / PENDING_POLL_MS + 1);
  });

  it('keeps other errors as errors', async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError('ALREADY_SUBMITTED'));
    const { result } = renderHook(() => useLoad(fn, []));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error?.code).toBe('ALREADY_SUBMITTED');
    expect(result.current.pending).toBeNull();
  });
});
