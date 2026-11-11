import dotenv from 'dotenv';
import express from 'express';
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import supertest from 'supertest';
import { config } from '../src/config.js';
import { createAuthRoutes } from '../src/routes/auth.js';
import { HttpWorkHub24Client } from '../src/wh24/httpClient.js';
import { formatSmsMobile } from '../src/wh24/mobileFormat.js';

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
  'WH24_WF01_ID',
  'WH24_WF02_ID'
] as const;

const missingConfig = requiredConfig.filter((key) => !process.env[key]);
if (missingConfig.length) {
  throw new Error(`Missing required WH24 settings in backend/.env.local: ${missingConfig.join(', ')}`);
}

const baseUrl = process.env.WH24_BASE_URL!.replace(/\/+$/, '');
const tenantId = process.env.WH24_TENANT_ID!;
const workflowId = process.env.WH24_WF01_ID!;
const wf02Id = process.env.WH24_WF02_ID!;
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
const wf02CardsPath = `/api/workflows/${encodeURIComponent(tenantId)}/${encodeURIComponent(wf02Id)}/cards`;

function allKeyPaths(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    return [childPath, ...allKeyPaths(child, childPath)];
  });
}

async function wf02KeysPhase(): Promise<void> {
  const create = await requestNoRetry(wf02CardsPath, {
    method: 'POST',
    body: JSON.stringify({ recipientName: 'Test' })
  });
  printFullResponse('WF-02 minimal create', create);
  if (!create.response.ok || !create.response.headers.get('content-type')?.toLowerCase().includes('json')) {
    console.error('WF-02 create could not be verified as a JSON response; no GET was attempted.');
    process.exitCode = 1;
    return;
  }
  const created = parseJson(create.body, 'WF-02 create response');
  const cardId = readCardId(created.id);
  if (cardId === undefined) throw new Error('WF-02 create response did not contain a numeric card id.');
  console.log('WF-02 create response key paths:');
  allKeyPaths(created).forEach((keyPath) => console.log(keyPath));

  const get = await requestNoRetry(`${wf02CardsPath}/${cardId}`);
  printFullResponse('WF-02 GET created card', get);
  if (!get.response.ok || !get.response.headers.get('content-type')?.toLowerCase().includes('json')) {
    console.error('WF-02 GET did not return JSON; field keys could not be verified.');
    process.exitCode = 1;
    return;
  }
  const card = parseJson(get.body, 'WF-02 GET response');
  console.log('WF-02 GET response key paths:');
  allKeyPaths(card).forEach((keyPath) => console.log(keyPath));
}

async function wf02FieldKeysPhase(cardId: number): Promise<void> {
  const result = await requestNoRetry(`${wf02CardsPath}/${cardId}`);
  const contentType = result.response.headers.get('content-type') ?? '';
  console.log(`Status: ${result.response.status}`);
  console.log(`Content-Type: ${contentType || '(none)'}`);
  if (!result.response.ok || !contentType.toLowerCase().includes('json')) {
    console.error('WF-02 GET did not return JSON; field keys could not be verified.');
    process.exitCode = 1;
    return;
  }
  const card = parseJson(result.body, 'WF-02 GET response');
  console.log('WF-02 card field keys (values omitted):');
  Object.keys(card).forEach((key) => console.log(key));
}

const WF02_KEYS = ['receipentEmail', 'oTPMobile', 'mobile', 'oTPCode', 'purpose', 'requestRef', 'sentAt', 'oTPResult'];

// Read-only. The tenant has no working card search, so the newest card is found by GET
// /cards/{id} from 1 upwards, stopping after 15 consecutive ids that do not return JSON.
async function newestCardIdByScan(cardsBase: string): Promise<number | undefined> {
  let newest: number | undefined;
  let misses = 0;
  for (let id = 1; id <= 1000 && misses < 15; id += 1) {
    const result = await requestNoRetry(`${cardsBase}/${id}`);
    const contentType = result.response.headers.get('content-type') ?? '';
    if (result.response.ok && contentType.toLowerCase().includes('json')) {
      newest = id;
      misses = 0;
    } else {
      misses += 1;
    }
  }
  return newest;
}

const newestWf02CardId = () => newestCardIdByScan(wf02CardsPath);

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function maskLast3(value: unknown): string {
  const text = String(value);
  return text.length <= 3 ? '***' : `${'*'.repeat(text.length - 3)}${text.slice(-3)}`;
}

async function wf02LatestPhase(explicitId?: number): Promise<void> {
  const cardId = explicitId ?? await newestWf02CardId();
  if (cardId === undefined) {
    console.error('No WF-02 card returned JSON. Pass an id: npm run probe -- wf02latest <cardId>');
    process.exitCode = 1;
    return;
  }
  const result = await requestNoRetry(`${wf02CardsPath}/${cardId}`);
  const contentType = result.response.headers.get('content-type') ?? '';
  console.log(`\nGET WF-02 card ${cardId}: ${result.response.status} ${contentType || '(none)'}`);
  if (!result.response.ok || !contentType.toLowerCase().includes('json')) {
    console.error('WF-02 GET did not return JSON; treated as failure.');
    process.exitCode = 1;
    return;
  }
  const card = parseJson(result.body, 'WF-02 GET response');
  // Safe to show: workflow metadata and enum-like values. Everything else is filled/empty only.
  const showValue = new Set(['id', 'purpose', 'oTPResult', 'sentAt', 'requestRef', 'stageId', 'taskID', 'createdDate', 'lastUpdatedDate']);
  if (isFilled(card.title)) console.log(`Title (digits masked): ${JSON.stringify(String(card.title).replace(/\d/g, '#'))}`);
  console.log('\nExpected WF-02 keys:');
  for (const key of WF02_KEYS) {
    const present = key in card;
    const value = card[key];
    let detail = '';
    if (key === 'oTPMobile' && isFilled(value)) detail = ` (${maskLast3(value)})`;
    else if (showValue.has(key) && isFilled(value)) detail = ` (${JSON.stringify(value)})`;
    console.log(`  ${key}: ${!present ? 'MISSING KEY' : isFilled(value) ? 'filled' : 'empty'}${detail}`);
  }
  console.log('\nOther keys on the card:');
  for (const [key, value] of Object.entries(card)) {
    if (WF02_KEYS.includes(key)) continue;
    const detail = showValue.has(key) && isFilled(value) ? ` (${JSON.stringify(value)})` : '';
    console.log(`  ${key}: ${isFilled(value) ? 'filled' : 'empty'}${detail}`);
  }

  if (!isFilled(card.oTPMobile)) await checkMobileConversion(String(card.receipentEmail ?? ''), String(card.purpose ?? ''));
}

// Runs the same lookup + formatSmsMobile the backend uses, printing only masked results.
async function checkMobileConversion(email: string, purpose: string): Promise<void> {
  console.log('\n--- oTPMobile is empty: checking the SMS_MOBILE_FORMAT conversion ---');
  console.log(`SMS_MOBILE_FORMAT: ${config.SMS_MOBILE_FORMAT}`);
  if (!email) {
    console.log('receipentEmail is empty too, so the user cannot be looked up.');
    return;
  }
  const table = purpose === 'Insurer Sign-in' ? 'ds_insurer_user' : 'ds_finance_user';
  const rows = await new HttpWorkHub24Client().queryDatastore(table, {});
  const row = rows.find((candidate) => String(candidate.email ?? '').toLowerCase() === email.toLowerCase());
  if (!row) {
    console.log(`No ${table} row matches receipentEmail.`);
    return;
  }
  const raw = String(row.mobile ?? '');
  console.log(`View mobile: ${isFilled(raw) ? `filled (${raw.replace(/\d/g, '#').slice(0, -3)}${raw.slice(-3)}, ${raw.replace(/\D/g, '').length} digits)` : 'EMPTY in the view'}`);
  for (const format of ['e164', 'intl', 'local'] as const) {
    try {
      console.log(`  ${format}: ${maskLast3(formatSmsMobile(raw, format))}`);
    } catch (error) {
      console.log(`  ${format}: FAILS (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

// Read-only: runs formatSmsMobile over every user row; prints masked output only.
async function mobilesPhase(): Promise<void> {
  console.log(`SMS_MOBILE_FORMAT: ${config.SMS_MOBILE_FORMAT}`);
  const client = new HttpWorkHub24Client();
  for (const table of ['ds_finance_user', 'ds_insurer_user'] as const) {
    const rows = await client.queryDatastore(table, {});
    console.log(`\n${table}: ${rows.length} rows`);
    rows.forEach((row, index) => {
      const raw = String(row.mobile ?? '');
      const shape = raw ? `${raw.replace(/\d/g, '#').slice(0, -3)}${raw.slice(-3)}` : '(empty)';
      let converted: string;
      try {
        converted = maskLast3(formatSmsMobile(raw));
      } catch (error) {
        converted = `FAILS: ${error instanceof Error ? error.message : String(error)}`;
      }
      console.log(`  row ${index + 1}: active=${String(row.active ?? '')} email=${isFilled(row.email) ? 'filled' : 'EMPTY'} mobile=${shape} -> ${converted}`);
    });
  }
}

// Prints each view's row keys and value types only: never row values, which hold personal data.
async function viewsPhase(): Promise<void> {
  const views: { label: string; env: string }[] = [
    { label: 'Insurer users', env: 'WH24_VIEW_INSURER_USERS' },
    { label: 'Packages', env: 'WH24_VIEW_PACKAGES' },
    { label: 'Insurers', env: 'WH24_VIEW_INSURERS' },
    { label: 'Finance partners', env: 'WH24_VIEW_FINANCE_PARTNERS' }
  ];
  // Enumeration-like keys whose distinct values are safe to print (no personal data).
  const enumKeys = new Set(['active', 'status', 'connectionType', 'connection', 'partnerCode']);
  for (const view of views) {
    console.log(`\n--- ${view.label} view (${view.env}) ---`);
    const viewId = process.env[view.env];
    if (!viewId) {
      console.error(`${view.env} is not configured.`);
      process.exitCode = 1;
      continue;
    }
    const result = await requestNoRetry(`/api/view/${encodeURIComponent(tenantId)}/${encodeURIComponent(viewId)}`);
    const contentType = result.response.headers.get('content-type') ?? '';
    console.log(`Status: ${result.response.status}`);
    console.log(`Content-Type: ${contentType || '(none)'}`);
    if (!result.response.ok || !contentType.toLowerCase().includes('json')) {
      console.error('View did not return JSON; treated as failure.');
      process.exitCode = 1;
      continue;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(result.body);
    } catch {
      console.error('View returned invalid JSON.');
      process.exitCode = 1;
      continue;
    }
    if (!Array.isArray(rows)) {
      console.error(`View did not return an array (got ${typeof rows}).`);
      process.exitCode = 1;
      continue;
    }
    console.log(`Row count: ${rows.length}`);
    const keyTypes = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      for (const [key, value] of Object.entries(row)) {
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        keyTypes.set(key, (keyTypes.get(key) ?? new Set()).add(type));
      }
    }
    console.log('Row keys (value types):');
    for (const [key, types] of keyTypes) console.log(`  ${key}: ${[...types].join(' | ')}`);
    for (const key of keyTypes.keys()) {
      if (!enumKeys.has(key)) continue;
      const values = new Set(rows.map((row) => JSON.stringify((row as Record<string, unknown>)[key] ?? null)));
      console.log(`Distinct ${key} values: ${[...values].join(', ')}`);
    }
  }
}

function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length < 4) throw new Error('The finance user view did not contain a valid mobile number.');
  return `●●● ●●● ${digits.slice(-4)}`;
}

async function wf02SendPhase(role: 'finance' | 'insurer', email: string): Promise<void> {
  const table = role === 'finance' ? 'ds_finance_user' : 'ds_insurer_user';
  const rows = await new HttpWorkHub24Client().queryDatastore(table, { email: email.toLowerCase() });
  if (rows.length !== 1) {
    console.error(`No unique ${role} user row found for the supplied email; no card was created.`);
    process.exitCode = 1;
    return;
  }
  const user = rows[0];
  const userEmail = String(user.email ?? '');
  const mobile = String(user.mobile ?? '');
  if (userEmail.toLowerCase() !== email.toLowerCase() || !mobile) {
    console.error('The matching user row is missing its email or mobile; no card was created.');
    process.exitCode = 1;
    return;
  }

  const wh24Purpose = role === 'finance' ? 'Finance User Sign-in' : 'Insurer Sign-in';
  const maskedMobile = maskMobile(mobile);
  const code = String(randomInt(100000, 1_000_000));
  const result = await requestNoRetry(wf02CardsPath, {
    method: 'POST',
    body: JSON.stringify({
      receipentEmail: userEmail,
      oTPMobile: formatSmsMobile(mobile),
      mobile: maskedMobile,
      oTPCode: code,
      purpose: wh24Purpose,
      requestRef: '',
      sentAt: new Date().toISOString(),
      title: `OTP · ${wh24Purpose} · ${maskedMobile}`
    })
  });
  const contentType = result.response.headers.get('content-type') ?? '(none)';
  let cardId = '(unavailable)';
  if (result.response.ok && contentType.toLowerCase().includes('json')) {
    try {
      const payload = JSON.parse(result.body) as Record<string, unknown>;
      const id = readCardId(payload.id);
      if (id !== undefined) cardId = String(id);
    } catch {
      cardId = '(unavailable: invalid JSON response)';
    }
  }
  console.log(`Status: ${result.response.status}`);
  console.log(`Content-Type: ${contentType}`);
  console.log(`Card ID: ${cardId}`);
  if (!result.response.ok || !contentType.toLowerCase().includes('json')) process.exitCode = 1;
}

async function financeOtpPhase(email: string): Promise<void> {
  const viewId = process.env.WH24_VIEW_FINANCE_USERS;
  if (!viewId) throw new Error('WH24_VIEW_FINANCE_USERS must be configured.');

  class CapturingClient extends HttpWorkHub24Client {
    createdWf02CardId?: string;

    override async createItem(workflow: 'WF-01' | 'WF-02', fields: Record<string, unknown>) {
      const created = await super.createItem(workflow, fields);
      if (workflow === 'WF-02') this.createdWf02CardId = created.itemId;
      return created;
    }
  }

  const client = new CapturingClient();
  const financeViewPath = `/api/view/${encodeURIComponent(tenantId)}/${encodeURIComponent(viewId)}`;
  let viewResponse: { status: number; contentType: string } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname === financeViewPath) {
      viewResponse = {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '(none)'
      };
    }
    return response;
  };

  let rows: Record<string, unknown>[];
  try {
    rows = await client.queryDatastore('ds_finance_user', {});
  } catch {
    const status = viewResponse?.status ?? '(unavailable)';
    const contentType = viewResponse?.contentType ?? '(unavailable)';
    console.log(`Finance view status: ${status}`);
    console.log(`Finance view Content-Type: ${contentType}`);
    console.log('Finance view row count: (unavailable; no OTP request sent)');
    process.exitCode = 1;
    return;
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`Finance view status: ${viewResponse?.status ?? '(unavailable)'}`);
  console.log(`Finance view Content-Type: ${viewResponse?.contentType ?? '(unavailable)'}`);
  console.log(`Finance view row count: ${rows.length}`);
  if (!viewResponse?.contentType.toLowerCase().includes('json')) {
    console.log('OTP request status: not sent');
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = email.toLowerCase();
  const matches = rows.filter((row) =>
    row.active === 'Yes' && String(row.email ?? '').toLowerCase() === normalizedEmail
  );
  if (matches.length > 1) console.warn('Multiple active finance rows matched; the backend will use the first.');

  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRoutes(client));
  const response = await supertest(app)
    .post('/auth/otp/request')
    .send({ email, purpose: 'finance_signin' });
  console.log(`OTP request status: ${response.status}`);
  console.log(`WF-02 card ID: ${client.createdWf02CardId ?? '(not created)'}`);
  if (response.status < 200 || response.status >= 300 || (matches.length > 0 && !client.createdWf02CardId)) {
    process.exitCode = 1;
  }
}

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

  console.log('\n--- Phase 2 report ---');
  console.log(`current stageId: ${String(card.stageId ?? '(empty)')}`);
  console.log('task IDs:');
  const taskIds = taskEntries.filter(({ path }) => /task.*id|id.*task/i.test(path));
  if (!taskIds.length) console.log('No task ID found in keys containing "task".');
  else for (const entry of taskIds) console.log(`${entry.path}: ${JSON.stringify(entry.value)}`);
  if (fieldMap.fields.H2) reportRows(card, field('H2'));
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

async function getWf01CardJson(cardId: number): Promise<Record<string, unknown> | undefined> {
  const result = await requestNoRetry(`${cardsPath}/${cardId}`);
  const contentType = result.response.headers.get('content-type') ?? '';
  if (!result.response.ok || !contentType.toLowerCase().includes('json')) return undefined;
  try {
    return parseJson(result.body, 'WF-01 GET response');
  } catch {
    return undefined;
  }
}

// Keys only, never values: lists card keys missing from config/wf01-field-map.json, which is
// where a newly added WF-01 field shows up.
async function wf01KeysPhase(explicitId?: number): Promise<void> {
  let cardId = explicitId;
  let card = cardId === undefined ? undefined : await getWf01CardJson(cardId);
  if (cardId === undefined) {
    let misses = 0;
    for (let id = 1; id <= 500 && misses < 15; id += 1) {
      const found = await getWf01CardJson(id);
      if (found) {
        cardId = id;
        card = found;
        misses = 0;
      } else {
        misses += 1;
      }
    }
  }
  if (cardId === undefined || !card) {
    console.error('No WF-01 card returned JSON. Pass an id: npm run probe -- wf01keys <cardId>');
    process.exitCode = 1;
    return;
  }
  console.log(`WF-01 card ${cardId} (values omitted)`);
  const mapped = new Set(Object.values(fieldMap.fields));
  const unmapped = Object.keys(card).filter((key) => !mapped.has(key));
  console.log('\nKeys not in config/wf01-field-map.json:');
  unmapped.forEach((key) => console.log(`  ${key}${/code/i.test(key) ? '   <-- contains "code"' : ''}`));
  console.log('\nAll keys containing "insurer" or "package":');
  Object.keys(card).filter((key) => /insurer|package/i.test(key)).forEach((key) => console.log(`  ${key}`));
}

// ---------- createbisect: which part of the Screen 1 create body makes WH24 return HTML ----------

const REDACTED_IDS = new Set(['title', 'A6', 'A7', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
const SHOW_VALUE_IDS = new Set(['A2', 'A3', 'A4', 'B1', 'C1', 'C5', 'C10', 'D1', 'E1', 'E3', 'E4', 'E5']);

function jsType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

async function postProbeCard(body: Record<string, unknown>, createdIds: number[]): Promise<{ ok: boolean; detail: string }> {
  const result = await requestNoRetry(cardsPath, { method: 'POST', body: JSON.stringify(body) });
  const contentType = result.response.headers.get('content-type') ?? '';
  if (result.response.ok && contentType.toLowerCase().includes('json')) {
    try {
      const id = readCardId(parseJson(result.body, 'create').id);
      if (id !== undefined) {
        createdIds.push(id);
        return { ok: true, detail: `card ${id}` };
      }
    } catch { /* fall through */ }
  }
  const snippet = result.body.replace(/\s+/g, ' ').replace(/\d{6,}/g, (d) => '#'.repeat(d.length)).slice(0, 120);
  return { ok: false, detail: `${result.response.status} ${contentType || '(none)'}: ${snippet}` };
}

async function createBisectPhase(): Promise<void> {
  const { buildRequestCardFields } = await import('../src/routes/requests.js');
  const { createCardBody } = await import('../src/wh24/httpClient.js');
  const { loadFinanceUser, pickTestPackage, buildSampleRequest } = await import('./sampleRequest.js');
  const client = new HttpWorkHub24Client();

  const finance = await loadFinanceUser(client);
  if ('error' in finance) throw new Error(`${finance.error} Expected: ${finance.expected}`);
  const picked = await pickTestPackage(client);
  if (!picked) throw new Error('No Webform insurer with an active user and an Active, in-date package (same rule as npm run e2e).');
  const designFields = buildRequestCardFields(buildSampleRequest(picked.pkg, picked.sumInsured, finance.customerMobile), finance.user);
  const fullBody = createCardBody(designFields);
  const keyOf = (id: string) => (id === 'title' ? 'title' : field(id));

  console.log(`Sample request (same as npm run e2e): package ${picked.pkg.packageRef}, sumInsured ${picked.sumInsured}`);
  console.log('\n1. Create body (POST /api/requests -> WF-01 cards):');
  for (const [id, value] of Object.entries(designFields)) {
    const shown = REDACTED_IDS.has(id) ? '[redacted]'
      : SHOW_VALUE_IDS.has(id) || typeof value === 'boolean' ? JSON.stringify(value)
      : '';
    console.log(`   ${id.padEnd(5)} ${keyOf(id).padEnd(24)} ${jsType(fullBody[keyOf(id)]).padEnd(9)} ${shown}`);
  }

  const createdIds: number[] = [];
  const report = () => console.log(`\nCreated WF-01 test cards (delete these): ${createdIds.length ? createdIds.join(', ') : '(none)'}`);

  // Base: customerName + title (both passed in the previous run), then sections A to E.
  const customerKey = field('B2');
  let base: Record<string, unknown> = { [customerKey]: fullBody[customerKey], title: fullBody.title };
  const first = await postProbeCard(base, createdIds);
  console.log(`\n2. { customerName, title }: ${first.ok ? 'OK' : 'FAIL'}  ${first.detail}`);
  if (!first.ok) {
    console.log('   The base card already fails: the problem is not in sections A-E (check auth, workflow id, or required fields in WH24).');
    report();
    return;
  }

  // requestDate (A2) is a WH24 datetime: try the createdDate style first, then ISO with Z.
  const dateKey = field('A2');
  const { formatWh24DateTime } = await import('../src/routes/requests.js');
  const now = new Date();
  let workingDateStyle: string | undefined;
  console.log('\n   requestDate (A2) format:');
  for (const style of ['micro', 'isoZ'] as const) {
    const value = formatWh24DateTime(now, style);
    const attempt = await postProbeCard({ ...base, [dateKey]: value }, createdIds);
    console.log(`   ${style.padEnd(6)} ${JSON.stringify(value).padEnd(30)} ${attempt.ok ? 'OK  ' : 'FAIL'}  ${attempt.detail}`);
    if (attempt.ok) {
      workingDateStyle = style;
      fullBody[dateKey] = value;
      break;
    }
  }
  console.log(workingDateStyle
    ? `   -> requestDate works with "${workingDateStyle}".`
    : '   -> requestDate fails with both formats; A2 is left out of the remaining sections.');

  const sections = ['A', 'B', 'C', 'D', 'E'].map((letter) => ({
    label: { A: 'A finance user', B: 'B customer', C: 'C vehicle', D: 'D facility', E: 'E cover' }[letter]!,
    ids: Object.keys(designFields).filter((id) => id.startsWith(letter) && id !== 'B2' && !(id === 'A2' && !workingDateStyle))
  }));
  const failingKeys: string[] = workingDateStyle ? [] : [`${dateKey} (A2)`];

  console.log('\n3. Adding one section at a time (a failing section is bisected, then the run continues without its failing keys):');
  for (const section of sections) {
    const sectionBody = Object.fromEntries(section.ids.map((id) => [keyOf(id), fullBody[keyOf(id)]]));
    const attempt = await postProbeCard({ ...base, ...sectionBody }, createdIds);
    console.log(`   + ${section.label.padEnd(15)} ${attempt.ok ? 'OK  ' : 'FAIL'}  ${attempt.detail}`);
    if (attempt.ok) {
      base = { ...base, ...sectionBody };
      continue;
    }

    console.log(`\n4. Section "${section.label}" field by field (on top of the last OK body):`);
    let accumulated = { ...base };
    let sectionFailures = 0;
    for (const id of section.ids) {
      const key = keyOf(id);
      const step = await postProbeCard({ ...accumulated, [key]: fullBody[key] }, createdIds);
      console.log(`   + ${id.padEnd(5)} ${key.padEnd(24)} ${jsType(fullBody[key]).padEnd(9)} ${step.ok ? 'OK  ' : 'FAIL'}  ${step.detail}`);
      if (step.ok) {
        accumulated = { ...accumulated, [key]: fullBody[key] };
        continue;
      }
      sectionFailures += 1;
      const alone = await postProbeCard({ ...base, [key]: fullBody[key] }, createdIds);
      failingKeys.push(`${key} (${id})`);
      console.log(`     -> HTML on ${key} (${id}), JS type ${jsType(fullBody[key])}; on the last OK body alone: ${alone.ok ? 'OK (fails only with earlier fields of this section)' : 'FAIL (fails on its own)'}.`);
    }
    if (!sectionFailures) console.log('   Every field passed individually; the section fails only as a whole.');
    base = accumulated;
    console.log('');
  }
  console.log(failingKeys.length
    ? `\nFailing keys: ${failingKeys.join(', ')}`
    : '\nAll sections passed: the full create body returns JSON.');
  report();
}

// Read-only: task-history view row keys and value types (values omitted; status values shown).
async function taskViewKeysPhase(cardId: number): Promise<void> {
  const viewId = process.env.WH24_VIEW_TASKS;
  if (!viewId) throw new Error('WH24_VIEW_TASKS is not configured.');
  const names = ['Broker Review', 'Awaiting Insurer Responses', 'Awaiting Package Selection', 'Awaiting OTP Verification', 'Awaiting Policy Upload'];
  for (const name of names) {
    const params = new URLSearchParams({ Task_Name: name, Card_id: String(cardId), Workflow_Id: workflowId });
    const result = await requestNoRetry(`/api/view/${encodeURIComponent(tenantId)}/${encodeURIComponent(viewId)}?${params}`);
    const contentType = result.response.headers.get('content-type') ?? '';
    if (!result.response.ok || !contentType.toLowerCase().includes('json')) {
      console.log(`${name}: ${result.response.status} ${contentType || '(none)'} (not JSON)`);
      continue;
    }
    const rows = JSON.parse(result.body) as Record<string, unknown>[];
    console.log(`${name}: ${rows.length} row(s)`);
    if (!rows.length) continue;
    const keys = new Map<string, Set<string>>();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        keys.set(key, (keys.get(key) ?? new Set()).add(type));
      }
    }
    console.log('Row keys (value types):');
    for (const [key, types] of keys) console.log(`  ${key}: ${[...types].join(' | ')}`);
    for (const key of keys.keys()) {
      if (/status|state/i.test(key)) console.log(`Distinct ${key} values: ${[...new Set(rows.map((row) => JSON.stringify(row[key])))].join(', ')}`);
    }
    return;
  }
}

const [mode, rawId, rawEmail, ...extraArgs] = process.argv.slice(2);
if (mode === 'wf02send') {
  if ((rawId !== 'finance' && rawId !== 'insurer') || !rawEmail || extraArgs.length) {
    throw new Error('Usage: npm run probe -- wf02send <finance|insurer> <registered-email>');
  }
  await wf02SendPhase(rawId, rawEmail);
} else if (mode === 'finance-otp' && rawId && !rawEmail && !extraArgs.length) {
  await financeOtpPhase(rawId);
} else if (extraArgs.length || rawEmail) {
  throw new Error('Usage: npm run probe -- finance-otp <email> | wf02keys | create | inspect <id> | complete <cardId> | tasktest <id>');
} else if (mode === 'wf02latest' && (!rawId || /^\d+$/.test(rawId))) {
  await wf02LatestPhase(rawId ? Number(rawId) : undefined);
} else if (mode === 'taskviewkeys' && rawId && /^\d+$/.test(rawId)) {
  await taskViewKeysPhase(Number(rawId));
} else if (mode === 'createbisect' && !rawId) {
  await createBisectPhase();
} else if (mode === 'wf01keys' && (!rawId || /^\d+$/.test(rawId))) {
  await wf01KeysPhase(rawId ? Number(rawId) : undefined);
} else if (mode === 'mobiles' && !rawId) {
  await mobilesPhase();
} else if (mode === 'views' && !rawId) {
  await viewsPhase();
} else if (mode === 'wf02keys' && !rawId) {
  await wf02KeysPhase();
} else if (mode === 'wf02fieldkeys' && rawId && /^\d+$/.test(rawId)) {
  await wf02FieldKeysPhase(Number(rawId));
} else if (mode === 'wf02fieldkeys' && !rawId) {
  const latest = await newestWf02CardId();
  if (latest === undefined) {
    console.error('No WF-02 card id found; pass one: npm run probe -- wf02fieldkeys <cardId>');
    process.exitCode = 1;
  } else {
    await wf02FieldKeysPhase(latest);
  }
} else if (mode === 'create' && !rawId) {
  await createPhase();
} else if (mode === 'inspect' && rawId && /^\d+$/.test(rawId)) {
  await inspectPhase(Number(rawId));
} else if (mode === 'complete' && rawId && /^\d+$/.test(rawId)) {
  await completePhase(Number(rawId));
} else if (mode === 'tasktest' && rawId && /^\d+$/.test(rawId)) {
  await taskTestPhase(Number(rawId));
} else {
  throw new Error('Usage: npm run probe -- views | wf02fieldkeys [cardId] | wf02keys | create | inspect <id> | complete <cardId> | tasktest <id>');
}
