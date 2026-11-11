/**
 * End-to-end smoke test against LIVE WorkHub24, through the real Express routes and services
 * (HttpWorkHub24Client, JSON offers store). Sign-in is bypassed only here, by issuing sessions in
 * this process; the running server is untouched.
 *
 *   npm run e2e                         full run (Screens 1-4, with one manual WH24 step)
 *   npm run e2e -- --insurer <code>     pick the Webform test insurer by insurerCode
 *   npm run e2e -- --request <no>       skip Screen 1 and continue an existing request
 *
 * Never prints secrets, sign-in or customer codes, or full mobiles.
 */
import { createInterface } from 'node:readline';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { issueSession } from '../src/auth/sessionService.js';
import { getItemByRequestNo } from '../src/services/requestService.js';
import type { PackageRow } from '../src/services/matching.js';
import { ApiError } from '../src/errors.js';
import { HttpWorkHub24Client } from '../src/wh24/httpClient.js';
import type { SessionUser } from '../src/types.js';
import { REQUEST_STATUS, type RequestStatus } from '../src/wh24/fields.js';
import { FINANCE_EMAIL, buildSampleRequest, isoDate as today, loadFinanceUser, maskLast3, pickTestPackage } from './sampleRequest.js';
const TASK_NAMES = [
  'Broker Review',
  'Awaiting Insurer Responses',
  'Awaiting Package Selection',
  'Awaiting OTP Verification',
  'Awaiting Policy Upload'
];
const MANUAL_WAIT_MS = 30 * 60 * 1000;
const TASK_WAIT_MS = 45_000;

// ---------- WH24 response capture (for failure reports), redacted ----------

interface CapturedResponse { method: string; path: string; status: number; contentType: string; snippet: string }
let lastWh24: CapturedResponse | undefined;
const SENSITIVE_KEY = /otp|code|mobile|email|token|secret|password|nic|customerName|address|chassis|engine|registration|name/i;

function redactJson(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJson(v, k)]));
  }
  if (key && SENSITIVE_KEY.test(key) && value !== null && value !== '' && value !== undefined) return '[redacted]';
  return value;
}

function redactBody(body: string, contentType: string): string {
  let text = body;
  if (contentType.toLowerCase().includes('json')) {
    try { text = JSON.stringify(redactJson(JSON.parse(body))); } catch { /* keep raw text */ }
  }
  return text.replace(/\d{6,}/g, (digits) => '#'.repeat(digits.length)).slice(0, 300);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await realFetch(input, init);
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (!url.pathname.endsWith('/api/auth/token')) {
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.clone().text().catch(() => '');
    lastWh24 = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      status: response.status,
      contentType: contentType || '(none)',
      snippet: redactBody(body, contentType)
    };
  }
  return response;
};

// ---------- helpers ----------

const client = new HttpWorkHub24Client();
const app = createApp({ wh24Client: client });

interface StepResult { step: string; result: 'PASS' | 'FAIL'; cardId: string; task: string; status: string; note: string }
const results: StepResult[] = [];

class StepFailure extends Error {
  constructor(message: string, readonly expected: string, readonly response?: { status: number; body: unknown }) {
    super(message);
  }
}

async function openTask(cardId: string): Promise<string | undefined> {
  for (const name of TASK_NAMES) {
    try {
      await client.getOpenTaskId(cardId, name);
      return name;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ALREADY_SUBMITTED') continue;
      throw error;
    }
  }
  return undefined;
}

async function cardStatus(cardId: string): Promise<string> {
  return String((await client.getItem(cardId)).fields.A3 ?? '') || '(empty)';
}

async function waitForTask(cardId: string, expected: string | undefined, timeoutMs: number, everyMs = 3_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let current = await openTask(cardId);
  while (current !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    current = await openTask(cardId);
  }
  return current;
}

function expectHttp(response: request.Response, status: number, what: string): void {
  if (response.status !== status) {
    throw new StepFailure(`${what} returned HTTP ${response.status}.`, `HTTP ${status}`, { status: response.status, body: response.body });
  }
}

// cardId and note are read after the step runs, so a step that creates the card can report it.
// expectedStatus: the A3 status the backend must have written by the end of the step.
async function record(
  step: string,
  cardRef: string | (() => string),
  noteRef: string | (() => string),
  expectedStatus: RequestStatus | undefined,
  run: () => Promise<void>
): Promise<void> {
  const current = (ref: string | (() => string)) => (typeof ref === 'function' ? ref() : ref);
  const statusNote = (actual: string) => (expectedStatus ? `status expected "${expectedStatus}", actual "${actual}"` : '');
  let cardId = current(cardRef);
  try {
    await run();
    cardId = current(cardRef);
    const [task, status] = cardId ? [await openTask(cardId), await cardStatus(cardId)] : [undefined, ''];
    if (expectedStatus && status !== expectedStatus) {
      throw new StepFailure(`Status is "${status}".`, `A3 status "${expectedStatus}" after this step`);
    }
    const note = [current(noteRef), statusNote(status)].filter(Boolean).join('; ');
    results.push({ step, result: 'PASS', cardId, task: task ?? '(none)', status, note });
    console.log(`PASS  ${step}  card=${cardId}  task=${task ?? '(none)'}  status=${status}${note ? `  ${note}` : ''}`);
  } catch (error) {
    cardId = current(cardRef);
    let task = '?';
    let status = '?';
    if (cardId) {
      try { task = (await openTask(cardId)) ?? '(none)'; status = await cardStatus(cardId); } catch { /* reported below */ }
    }
    const reason = error instanceof Error ? error.message : String(error);
    results.push({ step, result: 'FAIL', cardId, task, status, note: [reason, statusNote(status)].filter(Boolean).join('; ') });
    console.log(`FAIL  ${step}  card=${cardId || '-'}  task=${task}  status=${status}`);
    console.log(`  reason:   ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof StepFailure) {
      console.log(`  expected: ${error.expected}`);
      if (error.response) console.log(`  backend:  HTTP ${error.response.status} ${JSON.stringify(redactJson(error.response.body)).slice(0, 300)}`);
    }
    if (lastWh24) {
      console.log(`  last WorkHub24 response: ${lastWh24.method} ${lastWh24.path}`);
      console.log(`    status: ${lastWh24.status}  content-type: ${lastWh24.contentType}`);
      console.log(`    body (first 300 chars, redacted): ${lastWh24.snippet}`);
    }
    throw error;
  }
}

async function waitForEnterOrTask(cardId: string): Promise<void> {
  console.log(`\nOpen WorkHub24, card ${cardId}, Broker Review: select the Webform test insurer and submit. Press Enter when done.`);
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => rl.once('line', () => { rl.close(); resolve(); }));
    return;
  }
  // No interactive terminal (e.g. run in the background): wait for the task instead of Enter.
  console.log(`(No interactive terminal: polling every 10s, up to 30 min, for "Awaiting Insurer Responses" instead.)`);
  await waitForTask(cardId, 'Awaiting Insurer Responses', MANUAL_WAIT_MS, 10_000);
}

function printSummary(): void {
  console.log('\n=== Summary ===');
  console.table(results.map(({ step, result, cardId, task, status, note }) => ({ step, result, card: cardId, task, status, note })));
}

// ---------- run ----------

const args = process.argv.slice(2);
const argValue = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const insurerArg = argValue('--insurer');
let requestNo = argValue('--request') ?? '';
let cardId = '';

try {
  if (!config.WH24_BASE_URL) throw new Error('WH24_BASE_URL is not configured in .env.local.');
  console.log(`WorkHub24 live run, ${new Date().toISOString()}`);

  // --- setup: finance user, Webform test insurer, insurer user, matching package ---
  let financeUser!: SessionUser;
  let insurerUser!: SessionUser;
  let pkg!: PackageRow;
  let customerMobile = '';
  let sumInsured = 0;
  await record('Setup', '', '', undefined, async () => {
    const finance = await loadFinanceUser(client);
    if ('error' in finance) throw new StepFailure(finance.error, finance.expected);
    financeUser = finance.user;
    customerMobile = finance.customerMobile;

    const picked = await pickTestPackage(client, insurerArg);
    if (!picked) {
      throw new StepFailure('No Webform insurer with an active user and an Active, in-date package.',
        `insurers view: active=Yes, connectionType=Webform${insurerArg ? `, insurerCode=${insurerArg}` : ''}; insurer users view: active=Yes for that insurerCode; packages view: status=Active, validTo >= today`);
    }
    ({ pkg, sumInsured, insurerUser } = picked);
    console.log(`Finance user: ${FINANCE_EMAIL} (partner ${financeUser.partner || '(empty)'}), customer mobile ${maskLast3(customerMobile)}`);
    console.log(`Test insurer: ${insurerUser.insurer} (${insurerUser.insurerCode}), insurer user code ${picked.insurerUserCode || '(none)'}`);
    console.log(`Package: ${pkg.packageRef} "${pkg.name}"  category=${pkg.vehicleCategory}  cover=${pkg.coverType}  range=${pkg.sumMin}-${pkg.sumMax}  validTo=${pkg.validTo}  -> sumInsured=${sumInsured}`);
  });

  const financeToken = issueSession({ user: financeUser, purpose: 'finance_signin' }).token;
  const insurerToken = issueSession({ user: insurerUser, purpose: 'insurer_signin' }).token;

  // --- Screen 1 ---
  // requestNo is the WF-01 card id; the card is read back with GET /cards/{requestNo}.
  const resolveCard = async () => {
    const card = await getItemByRequestNo(client, requestNo);
    if (!card) throw new StepFailure(`No WF-01 card found for ${requestNo}.`, `GET /cards/${requestNo} returns the WF-01 card as JSON`);
    cardId = String(card.id ?? card.itemId);
  };
  if (!requestNo) {
    await record('1 Screen 1: create request', () => cardId, () => `requestNo=${requestNo}`, REQUEST_STATUS.awaitingQuotes, async () => {
      const response = await request(app).post('/api/requests').set('Authorization', `Bearer ${financeToken}`)
        .send(buildSampleRequest(pkg, sumInsured, customerMobile));
      expectHttp(response, 201, 'POST /api/requests');
      requestNo = String(response.body.requestNo ?? '');
      if (!requestNo) throw new StepFailure('No requestNo in the response.', 'requestNo (the created WF-01 card id)', { status: response.status, body: response.body });
      cardId = requestNo;
      await resolveCard();
    });
  } else {
    await resolveCard();
  }

  // --- manual Broker Review ---
  if ((await openTask(cardId)) !== 'Awaiting Insurer Responses') await waitForEnterOrTask(cardId);

  // --- Screen 2 ---
  await record('3 Screen 2: insurer offers stored package', cardId, `package=${pkg.packageRef}`, REQUEST_STATUS.awaitingSelection, async () => {
    const before = await openTask(cardId);
    if (before !== 'Awaiting Insurer Responses') throw new StepFailure(`Open task is ${before ?? '(none)'}.`, 'open task "Awaiting Insurer Responses"');
    // Broker Review is a WorkHub24 step and must not change the status any more.
    const statusBefore = await cardStatus(cardId);
    if (statusBefore !== REQUEST_STATUS.awaitingQuotes) {
      throw new StepFailure(`Status after Broker Review is "${statusBefore}".`, `A3 status "${REQUEST_STATUS.awaitingQuotes}" (WorkHub24 no longer sets status)`);
    }
    const view = await request(app).get(`/api/insurer/requests/${requestNo}/response`).set('Authorization', `Bearer ${insurerToken}`);
    expectHttp(view, 200, 'GET Screen 2');
    const refs = (view.body.recommended ?? []).map((item: { packageRef: string }) => item.packageRef);
    if (!refs.includes(pkg.packageRef)) throw new StepFailure(`Package not recommended (got ${JSON.stringify(refs)}).`, `${pkg.packageRef} in Screen 2 recommended packages`);
    const submit = await request(app).post(`/api/insurer/requests/${requestNo}/response`).set('Authorization', `Bearer ${insurerToken}`)
      .send({ mode: 'stored', packageRef: pkg.packageRef });
    expectHttp(submit, 204, 'POST Screen 2 response');
    const after = await waitForTask(cardId, 'Awaiting Package Selection', TASK_WAIT_MS);
    if (after !== 'Awaiting Package Selection') throw new StepFailure(`Open task is ${after ?? '(none)'}.`, 'open task "Awaiting Package Selection"');
  });

  // --- Screen 3 ---
  let offerCount = 0;
  await record('4a Screen 3: list offers and select', cardId, () => `offers=${offerCount}`, REQUEST_STATUS.awaitingConsent, async () => {
    const offers = await request(app).get(`/api/finance/requests/${requestNo}/offers`).set('Authorization', `Bearer ${financeToken}`);
    expectHttp(offers, 200, 'GET Screen 3 offers');
    const list = (offers.body.offers ?? []) as { insurer: string; packageRef: string; total: number }[];
    offerCount = list.length;
    console.log(`      offers: ${offerCount}`);
    const offer = list.find((item) => item.packageRef === pkg.packageRef);
    if (!offer) throw new StepFailure('Offered package missing from Screen 3.', `offer with packageRef ${pkg.packageRef}`, { status: offers.status, body: list.map((item) => item.packageRef) });
    const select = await request(app).post(`/api/finance/requests/${requestNo}/select`).set('Authorization', `Bearer ${financeToken}`)
      .send({ insurer: offer.insurer, packageRef: offer.packageRef });
    expectHttp(select, 200, 'POST Screen 3 select');
    const after = await waitForTask(cardId, 'Awaiting OTP Verification', TASK_WAIT_MS);
    if (after !== 'Awaiting OTP Verification') throw new StepFailure(`Open task is ${after ?? '(none)'}.`, 'open task "Awaiting OTP Verification"');
  });
  await record('4b Screen 3: verify customer code', cardId, '', REQUEST_STATUS.awaitingPolicy, async () => {
    // The backend stores the customer code on the WF-01 card (I6 customerOTP) when the package is selected.
    const code = String((await client.getItem(cardId)).fields.I6 ?? '');
    if (!/^\d{6}$/.test(code)) throw new StepFailure('Customer code on the card is missing or not 6 digits (value not shown).', 'I6 customerOTP = 6 digits');
    const verify = await request(app).post(`/api/finance/requests/${requestNo}/customer-otp`).set('Authorization', `Bearer ${financeToken}`).send({ code });
    expectHttp(verify, 200, 'POST Screen 3 customer-otp');
    if (verify.body.result !== 'verified') throw new StepFailure(`Result was ${String(verify.body.result)}.`, 'result "verified"', { status: verify.status, body: verify.body });
    const after = await waitForTask(cardId, 'Awaiting Policy Upload', TASK_WAIT_MS);
    if (after !== 'Awaiting Policy Upload') throw new StepFailure(`Open task is ${after ?? '(none)'}.`, 'open task "Awaiting Policy Upload"');
  });

  // --- Screen 4 ---
  await record('5 Screen 4: binding', cardId, '', REQUEST_STATUS.completed, async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const start = today(7);
    const expiry = new Date(start);
    expiry.setFullYear(expiry.getFullYear() + 1);
    expiry.setDate(expiry.getDate() - 1);
    const stamp = Date.now().toString(36).toUpperCase();
    const binding = await request(app).post(`/api/insurer/requests/${requestNo}/binding`).set('Authorization', `Bearer ${insurerToken}`)
      .field('quotationRef', `E2E-Q-${stamp}`)
      .field('policyNumber', `E2E-POL-${stamp}`)
      .field('policyStartDate', start)
      .field('policyExpiryDate', expiry.toISOString().slice(0, 10))
      .field('remarks', 'E2E smoke test')
      .attach('quotationFile', pdf, { filename: 'e2e-quotation.pdf', contentType: 'application/pdf' })
      .attach('policyFiles', pdf, { filename: 'e2e-policy.pdf', contentType: 'application/pdf' });
    expectHttp(binding, 204, 'POST Screen 4 binding');
    const deadline = Date.now() + TASK_WAIT_MS;
    let task = await openTask(cardId);
    let status = await cardStatus(cardId);
    while ((task !== undefined || status !== REQUEST_STATUS.completed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      task = await openTask(cardId);
      status = await cardStatus(cardId);
    }
    if (task !== undefined) throw new StepFailure(`Task still open: ${task}.`, 'no open WF-01 task');
    // The A3 status itself is checked by record() against REQUEST_STATUS.completed.
  });
} catch (error) {
  if (!results.some((item) => item.result === 'FAIL')) {
    console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof StepFailure) console.log(`  expected: ${error.expected}`);
    if (lastWh24) console.log(`  last WorkHub24 response: ${lastWh24.method} ${lastWh24.path} ${lastWh24.status} ${lastWh24.contentType}: ${lastWh24.snippet}`);
  }
  process.exitCode = 1;
} finally {
  printSummary();
  if (requestNo) console.log(`requestNo=${requestNo}${cardId ? `  card=${cardId}` : ''}  (continue with: npm run e2e -- --request ${requestNo})`);
  process.exit(process.exitCode ?? 0);
}
