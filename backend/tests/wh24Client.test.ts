import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpWorkHub24Client } from '../src/wh24/httpClient.js';
import { config } from '../src/config.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('HttpWorkHub24Client task completion', () => {
  it('looks up the newest task, then PUTs fields and completes that task', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/auth/token')) {
        return jsonResponse({ access_token: 'test-token', token_type: 'Bearer' });
      }
      if (url.includes('/api/view/')) {
        return jsonResponse([{ iD: 'newest-task-id' }, { iD: 'older-task-id' }]);
      }
      return jsonResponse({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpWorkHub24Client();

    await client.updateAndCompleteTask(42, 'Awaiting Package Selection', () => ({ I2: 'Insurer A' }));

    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/auth/token',
      expect.stringContaining('/api/view/'),
      expect.stringContaining('/api/workflows/'),
      expect.stringContaining('/api/tasks/')
    ]);
    const taskViewUrl = new URL(calls[1].url);
    expect(taskViewUrl.searchParams.get('Task_Name')).toBe('Awaiting Package Selection');
    expect(taskViewUrl.searchParams.get('Card_id')).toBe('42');
    expect(taskViewUrl.searchParams.get('Workflow_Id')).toBe(config.WH24_WF01_ID);
    expect(new URL(calls[3].url).pathname).toContain('/tasks/newest-task-id');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ selectedInsurer: 'Insurer A' });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      action: 'DONE',
      comment: 'Awaiting Package Selection via webform'
    });
  });

  it('uses the WF-02 workflow for result updates and its task-history query', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/auth/token')) return jsonResponse({ access_token: 'test-token' });
      if (url.includes('/api/view/')) return jsonResponse([{ iD: 'wf02-task-id' }]);
      return jsonResponse({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpWorkHub24Client();

    await client.updateAndCompleteTaskForWorkflow('WF-02', 7, 'Awaiting Verification', { oTPResult: 'Verified' });

    const taskViewCall = calls.find(({ url }) => url.includes('/api/view/'));
    const taskViewUrl = new URL(taskViewCall!.url);
    expect(taskViewUrl.searchParams.get('Task_Name')).toBe('Awaiting Verification');
    expect(taskViewUrl.searchParams.get('Card_id')).toBe('7');
    expect(taskViewUrl.searchParams.get('Workflow_Id')).toBe(config.WH24_WF02_ID);
    const putCall = calls.find(({ init }) => init?.method === 'PUT');
    expect(new URL(putCall!.url).pathname).toContain(`/${config.WH24_WF02_ID}/cards/7`);
    expect(JSON.parse(String(putCall!.init?.body))).toEqual({ oTPResult: 'Verified' });
    expect(new URL(calls[calls.length - 1].url).pathname).toContain('/tasks/wf02-task-id');
  });

  it('ignores finished rows from the task-history view and takes the newest open task', async () => {
    const respond = (rows: Record<string, unknown>[]) => vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/token')) return jsonResponse({ access_token: 'test-token' });
      if (url.includes('/api/view/')) return jsonResponse(rows);
      return jsonResponse({ success: true });
    });

    vi.stubGlobal('fetch', respond([
      { iD: 'done-1', completedDate: '2026-11-11T10:00:00.000000', status: 'COMPLETED' },
      { iD: 'open-1', completedDate: null, status: 'NEW' },
      { iD: 'done-2', completedDate: '', status: 'DONE' }
    ]));
    await expect(new HttpWorkHub24Client().getOpenTaskId(42, 'Broker Review')).resolves.toBe('open-1');

    vi.stubGlobal('fetch', respond([
      { iD: '105', completedDate: null, status: 'NEW' },
      { iD: '230', completedDate: '', status: 'NEW' },
      { iD: '999', completedDate: '2026-11-11T10:00:00.000000', status: 'NEW' }
    ]));
    await expect(new HttpWorkHub24Client().getOpenTaskId(42, 'Broker Review')).resolves.toBe('230');

    vi.stubGlobal('fetch', respond([{ iD: 'done-1', completedDate: '2026-11-11T10:00:00.000000', status: 'COMPLETED' }]));
    await expect(new HttpWorkHub24Client().getOpenTaskId(42, 'Broker Review')).rejects.toMatchObject({ code: 'ALREADY_SUBMITTED' });
  });

  it('does one task lookup with no retry by default, so closed links fail fast', async () => {
    let viewCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/token')) return jsonResponse({ access_token: 'test-token' });
      if (url.includes('/api/view/')) {
        viewCalls += 1;
        return jsonResponse([]);
      }
      return jsonResponse({ success: true });
    }));
    const client = new HttpWorkHub24Client();
    const started = Date.now();

    await expect(client.getOpenTaskId(42, 'Awaiting Insurer Responses')).rejects.toMatchObject({ code: 'ALREADY_SUBMITTED' });
    expect(viewCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('retries the task lookup only when asked, capped at 8 seconds', async () => {
    vi.useFakeTimers();
    try {
      let viewCalls = 0;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/auth/token')) return jsonResponse({ access_token: 'test-token' });
        if (url.includes('/api/view/')) {
          viewCalls += 1;
          return jsonResponse([]);
        }
        return jsonResponse({ success: true });
      }));
      const client = new HttpWorkHub24Client();
      const lookup = client.getOpenTaskId(7, 'Awaiting Verification', 'WF-02', { waitForTaskMs: 60_000 });
      const settled = expect(lookup).rejects.toMatchObject({ code: 'ALREADY_SUBMITTED' });
      await vi.advanceTimersByTimeAsync(8_000);
      await settled;
      // 0s, 2s, 4s, 6s, 8s: five lookups inside the 8-second cap, never 60 seconds.
      expect(viewCalls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a non-JSON task response as failure', async () => {
    let taskResponse = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/token')) return jsonResponse({ access_token: 'test-token' });
      if (url.includes('/api/view/')) return jsonResponse([{ iD: 'task-id' }]);
      if (url.includes('/api/tasks/')) {
        taskResponse = true;
        return new Response('<html>application shell</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }
      return jsonResponse({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpWorkHub24Client();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // The card update succeeded, so the failure is logged and reported, and the update is not retried.
      await expect(client.updateAndCompleteTask(42, 'Awaiting OTP Verification', () => ({ I7: 'Verified' })))
        .rejects.toThrow(/could not complete this step/i);
      expect(taskResponse).toBe(true);
      const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];
      expect(calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
      expect(errors).toHaveBeenCalledWith(
        expect.stringMatching(/updated but completing the task failed/),
        expect.objectContaining({ cardId: '42', error: expect.stringMatching(/non-JSON content/i) })
      );
    } finally {
      errors.mockRestore();
    }
  });
});
