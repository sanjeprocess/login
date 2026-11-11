import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import { getOpenTaskId } from '../src/wh24/client.js';
import { HttpWorkHub24Client } from '../src/wh24/httpClient.js';

dotenv.config({ path: '.env.local' });

interface FieldMap {
  fields: Record<string, string>;
}

interface ApiResponse {
  response: Response;
  body: string;
  url: string;
}

const requiredConfig = [
  'WH24_BASE_URL',
  'WH24_TENANT_ID',
  'WH24_CLIENT_ID',
  'WH24_CLIENT_SECRET',
  'WH24_GRANT_TYPE',
  'WH24_WF01_ID'
] as const;

const missingConfig = requiredConfig.filter((key) => !process.env[key]);
if (missingConfig.length) {
  throw new Error(`Missing required WH24 settings in backend/.env.local: ${missingConfig.join(', ')}`);
}

const baseUrl = process.env.WH24_BASE_URL!.replace(/\/+$/, '');
const tenantId = process.env.WH24_TENANT_ID!;
const workflowId = process.env.WH24_WF01_ID!;
const clientId = process.env.WH24_CLIENT_ID!;
const clientSecret = process.env.WH24_CLIENT_SECRET!;
const grantType = process.env.WH24_GRANT_TYPE!;
const fieldMap = JSON.parse(await readFile(new URL('../config/wf01-field-map.json', import.meta.url), 'utf8')) as FieldMap;

function field(designId: string): string {
  const key = fieldMap.fields[designId];
  if (!key) throw new Error(`Missing ${designId} in config/wf01-field-map.json fields`);
  return key;
}

function apiUrl(path: string): string {
  return `${baseUrl}${path}`;
}

async function responseBody(response: Response): Promise<ApiResponse> {
  return { response, body: await response.text(), url: response.url };
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

async function authenticate(): Promise<CachedToken> {
  const result = await responseBody(await fetch(apiUrl('/api/auth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: grantType })
  }));
  if (!result.response.ok) {
    throw new Error(`Authentication failed (${result.response.status})`);
  }
  const payload = JSON.parse(result.body) as {
    access_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
  };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Authentication response did not contain access_token.');
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Authentication response did not contain a valid expires_in.');
  }
  const rawTokenType = typeof payload.token_type === 'string' ? payload.token_type.trim() : '';
  const tokenType = rawTokenType.toLowerCase() === 'bearer' ? 'Bearer' : rawTokenType || 'Bearer';
  return {
    accessToken: payload.access_token,
    tokenType,
    expiresAt: Date.now() + expiresIn * 1000
  };
}

async function getToken(forceRefresh = false): Promise<CachedToken> {
  if (forceRefresh || !cachedToken || cachedToken.expiresAt - Date.now() <= 60_000) {
    cachedToken = await authenticate();
  }
  return cachedToken;
}

async function request(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  let token = await getToken();
  headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
  let result = await responseBody(await fetch(apiUrl(path), { ...init, headers }));
  if (result.response.status === 401) {
    token = await getToken(true);
    headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
    result = await responseBody(await fetch(apiUrl(path), { ...init, headers }));
  }
  return result;
}

async function requestNoRetry(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return responseBody(await fetch(apiUrl(path), { ...init, headers }));
}

function printFullResponse(label: string, result: ApiResponse): void {
  console.log(`\n--- ${label} ---`);
  console.log(`Status: ${result.response.status}`);
  console.log(`Content-Type: ${result.response.headers.get('content-type') ?? '(none)'}`);
  console.log(`Body: ${result.body}`);
}

function printRaw(label: string, body: string): void {
  console.log(`\n--- ${label} ---\n${body}`);
}

async function probeCall(label: string, action: () => Promise<ApiResponse>): Promise<ApiResponse | undefined> {
  try {
    const result = await action();
    printRaw(label, result.body);
    return result;
  } catch (error) {
    console.error(`\n--- ${label} ERROR ---\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return undefined;
  }
}

const testFields = {
  [field('B2')]: 'Probe Customer',
  [field('C7')]: 'PROBE-0001',
  [field('C2')]: 'Toyota',
  [field('E2')]: 5000000,
  [field('E1')]: 'Comprehensive',
  [field('A4')]: 'Northgate Finance PLC'
};

const cardsPath = `/api/workflows/${encodeURIComponent(tenantId)}/${encodeURIComponent(workflowId)}/cards`;
const listPath = `${cardsPath}/list`;

function parseJson(body: string, context: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected a JSON object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readCardId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function printRequestError(label: string, result: ApiResponse): void {
  console.error(`\n--- ${label} ERROR ---\nStatus: ${result.response.status}\n${result.body}`);
}

function inspectTaskKeys(value: unknown, path = '$'): { path: string; value: unknown }[] {
  if (!value || typeof value !== 'object') return [];
  const found: { path: string; value: unknown }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    if (key.toLowerCase().includes('task')) found.push({ path: childPath, value: child });
    found.push(...inspectTaskKeys(child, childPath));
  }
  return found;
}

function reportRows(card: Record<string, unknown>, key: string): void {
  const value = card[key];
  if (!Array.isArray(value)) {
    console.log(`${key}: no rows (value is ${value === null ? 'null' : typeof value})`);
    return;
  }
  const rows = value.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown>[];
  console.log(`${key}: ${value.length ? 'has' : 'no'} rows (${value.length})`);
  rows.forEach((row, index) => console.log(`${key}[${index}] keys: ${JSON.stringify(Object.keys(row))}`));
}

async function createPhase(): Promise<void> {
  const title = 'PROBE · Probe Customer · PROBE-0001';
  const createResult = await requestNoRetry(cardsPath, {
    method: 'POST',
    body: JSON.stringify({ title, ...testFields })
  });
  printFullResponse('WF-01 create card', createResult);
  if (!createResult.response.ok) {
    process.exitCode = 1;
    return;
  }

  const created = parseJson(createResult.body, 'Create response');
  const cardId = readCardId(created.id);
  if (cardId === undefined) {
    throw new Error('Create response did not contain a numeric card id.');
  }
  console.log(`id: ${String(created.id)}`);
  console.log(`taskID: ${typeof created.taskID === 'string' && created.taskID ? created.taskID : '(empty)'}`);

  const getResult = await requestNoRetry(`${cardsPath}/${cardId}`);
  printFullResponse('WF-01 GET created card', getResult);
  if (!getResult.response.ok) {
    process.exitCode = 1;
    return;
  }
  const card = parseJson(getResult.body, 'GET card response');
  console.log(`GET taskID: ${typeof card.taskID === 'string' && card.taskID ? card.taskID : '(empty)'}`);
  console.log(`\nSubmit Broker Review on card ${cardId} with NO insurers, then run: npm run probe -- tasktest ${cardId}`);
}

function readTaskId(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const taskID = (parsed as Record<string, unknown>).taskID;
      return typeof taskID === 'string' ? taskID : '';
    }
  } catch {
    return '';
  }
  return '';
}

async function taskTestPhase(cardId: number): Promise<void> {
  const cardPath = `${cardsPath}/${cardId}`;
  const taskIDs: { step: string; value: string }[] = [];

  const before = await requestNoRetry(cardPath);
  printFullResponse('GET card before PUT', before);
  const initialTaskID = before.response.ok ? readTaskId(before.body) : '';
  taskIDs.push({ step: 'GET before PUT', value: initialTaskID });

  const put = await requestNoRetry(cardPath, {
    method: 'PUT',
    body: JSON.stringify({ remarks1: 'tasktest put' })
  });
  printFullResponse('PUT card', put);
  const putTaskID = put.response.ok ? readTaskId(put.body) : '';
  taskIDs.push({ step: 'PUT response', value: putTaskID });

  const afterPut = await requestNoRetry(cardPath);
  printFullResponse('GET card after PUT', afterPut);
  const afterPutTaskID = afterPut.response.ok ? readTaskId(afterPut.body) : '';
  taskIDs.push({ step: 'GET after PUT', value: afterPutTaskID });

  const taskIDToComplete = putTaskID || afterPutTaskID;
  let post: ApiResponse | undefined;
  if (taskIDToComplete) {
    post = await requestNoRetry(
      `/api/tasks/${encodeURIComponent(tenantId)}/tasks/${encodeURIComponent(taskIDToComplete)}`,
      {
        method: 'POST',
        body: JSON.stringify({ action: 'DONE', comment: 'tasktest' })
      }
    );
    printFullResponse('POST complete task', post);
  } else {
    console.log('\nPOST complete task skipped: no taskID in PUT response or subsequent GET.');
  }

  const afterPost = await requestNoRetry(cardPath);
  printFullResponse('GET card after task attempt', afterPost);
  const finalCard = afterPost.response.ok ? parseJson(afterPost.body, 'Final GET card response') : {};
  const finalTaskID = typeof finalCard.taskID === 'string' ? finalCard.taskID : '';
  taskIDs.push({ step: 'GET after POST', value: finalTaskID });

  console.log('\n--- Tasktest report ---');
  console.log('| Step | taskID |');
  console.log('|---|---|');
  for (const entry of taskIDs) console.log(`| ${entry.step} | ${entry.value || '(empty)'} |`);
  console.log(`POST succeeded: ${post ? post.response.ok ? 'yes (HTTP success)' : 'no (HTTP failure)' : 'not sent'}`);
}

async function inspectPhase(cardId: number): Promise<void> {
  const getResult = await request(`${cardsPath}/${cardId}`);
  printRaw('WF-01 GET card', getResult.body);
  if (!getResult.response.ok) {
    printRequestError('WF-01 GET card', getResult);
    process.exitCode = 1;
    return;
  }
  const card = parseJson(getResult.body, 'GET card response');
  const taskEntries = inspectTaskKeys(card);
  console.log('\n--- Task keys ---');
  if (!taskEntries.length) {
    console.log('No keys containing "task" found.');
  } else {
    for (const entry of taskEntries) console.log(`${entry.path}: ${JSON.stringify(entry.value)}`);
  }

  const filters = [
    { type: 'field', value: 'id' },
    { type: 'operator', value: 'IS_EQUAL_TO' },
    { type: 'number', value: cardId },
    { type: 'operator', value: 'AND' },
    { type: 'field', value: 'deleted' },
    { type: 'operator', value: 'IS_EQUAL_TO' },
    { type: 'boolean', value: false }
  ];
  const listResult = await request(listPath, {
    method: 'POST',
    body: JSON.stringify({
      fields: [...new Set(['id', 'stageId', 'title', field('A1'), field('F1'), field('H2')])],
      filters: JSON.stringify(filters),
      limit: 50,
      offset: 0,
      orderBy: 'lastUpdatedDate DESC',
      showArchived: false
    })
  });
  const contentType = listResult.response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('text/html')) {
    console.log('\n--- WF-01 cards/list ---');
    console.log(`Status: ${listResult.response.status}`);
    console.log(`Content-Type: ${contentType}`);
    console.log(`URL: ${apiUrl(listPath)}`);
  } else {
    printRaw('WF-01 cards/list', listResult.body);
    if (!listResult.response.ok) printRequestError('WF-01 cards/list', listResult);
  }

  console.log('\n--- Phase 2 report ---');
  console.log(`current stageId: ${String(card.stageId ?? '(empty)')}`);
  console.log('task IDs:');
  const taskIds = taskEntries.filter(({ path }) => /task.*id|id.*task/i.test(path));
  if (!taskIds.length) console.log('No task ID found in keys containing "task".');
  else for (const entry of taskIds) console.log(`${entry.path}: ${JSON.stringify(entry.value)}`);
  reportRows(card, field('H2'));
  reportRows(card, field('F1'));
}

async function completePhase(cardId: number): Promise<void> {
  const client = new HttpWorkHub24Client();
  const before = await client.getCard(cardId);
  const initialTaskId = before.taskID ?? '';
  console.log('--- Before task completion ---');
  console.log(`taskID: ${initialTaskId || '(empty)'}`);
  console.log(`stageId: ${String(before.fields.stageId ?? '(empty)')}`);
  console.log(`lastUpdatedDate: ${String(before.lastUpdatedDate ?? '(empty)')}`);
  console.log(`title: ${String(before.fields.title ?? '(empty)')}`);

  if (!initialTaskId.trim()) {
    console.log(`\nCard ${cardId} has no open taskID; nothing was completed.`);
    return;
  }

  getOpenTaskId(before);
  let completionError: string | undefined;
  try {
    await client.completeTask(before, 'probe');
  } catch (error) {
    completionError = error instanceof Error ? error.message : String(error);
  }

  const after = await client.getCard(cardId);
  const nextTaskId = after.taskID ?? '';
  console.log('\n--- After task completion ---');
  console.log(`taskID: ${nextTaskId || '(empty)'}`);
  console.log(`stageId: ${String(after.fields.stageId ?? '(empty)')}`);
  console.log(`lastUpdatedDate: ${String(after.lastUpdatedDate ?? '(empty)')}`);
  console.log(`task completed: ${nextTaskId !== initialTaskId ? 'yes' : 'no'}`);
  console.log(`taskID changed: ${nextTaskId !== initialTaskId ? 'yes' : 'no'}`);
  console.log(`next task state: ${nextTaskId ? (nextTaskId === initialTaskId ? `same taskID remains ${nextTaskId}` : `new taskID ${nextTaskId}`) : 'taskID is empty'}`);
  if (completionError) console.log(`completion error: ${completionError}`);
}

const [mode, rawId, ...extraArgs] = process.argv.slice(2);
if (extraArgs.length) throw new Error('Usage: npm run probe -- create | inspect <id> | complete <cardId> | tasktest <id>');
if (mode === 'create' && !rawId) {
  await createPhase();
} else if (mode === 'inspect' && rawId && /^\d+$/.test(rawId)) {
  await inspectPhase(Number(rawId));
} else if (mode === 'complete' && rawId && /^\d+$/.test(rawId)) {
  await completePhase(Number(rawId));
} else if (mode === 'tasktest' && rawId && /^\d+$/.test(rawId)) {
  await taskTestPhase(Number(rawId));
} else {
  throw new Error('Usage: npm run probe -- create | inspect <id> | complete <cardId> | tasktest <id>');
}
