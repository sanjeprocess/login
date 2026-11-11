import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpWorkHub24Client } from '../src/wh24/httpClient.js';

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
    expect(new URL(calls[3].url).pathname).toContain('/tasks/newest-task-id');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ selectedInsurer: 'Insurer A' });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      action: 'DONE',
      comment: 'Awaiting Package Selection via webform'
    });
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

    await expect(client.updateAndCompleteTask(42, 'Awaiting OTP Verification', () => ({ I7: 'Verified' })))
      .rejects.toThrow(/non-JSON content/i);
    expect(taskResponse).toBe(true);
  });
});
