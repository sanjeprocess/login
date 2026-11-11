// Aitken Spence sign-in backend. Zero dependencies (Node 20+).
// Flow: look up employee in the WorkHub24 datatable -> create OTP -> POST it to WorkHub24 -> verify.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const PORT = Number(env.PORT || 4100);
const WH24_BASE = (env.WH24_BASE_URL || 'https://app.workhub24.com').replace(/\/+$/, '');
const TENANT = env.WH24_TENANT_ID;
const EMPLOYEE_TABLE = env.WH24_EMPLOYEE_TABLE_ID;
const OTP_WORKFLOW = env.WH24_OTP_WORKFLOW_ID || '';
const PORTAL_URL = env.PORTAL_URL || '/dashboard.html';

const OTP_WINDOW_MS = 5 * 60 * 1000;
const OTP_ATTEMPTS_LIMIT = 3;
const SESSION_MS = 30 * 60 * 1000;

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/dashboard.html': 'dashboard.html',
  '/styles.css': 'styles.css',
  '/app.js': 'app.js',
  '/dashboard.js': 'dashboard.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

for (const k of ['WH24_TENANT_ID', 'WH24_EMPLOYEE_TABLE_ID', 'WH24_CLIENT_ID', 'WH24_CLIENT_SECRET']) {
  if (!env[k]) {
    console.error(`Missing ${k} in .env`);
    process.exit(1);
  }
}

// --- WorkHub24 client --------------------------------------------------------
let cachedToken = null; // { accessToken, expiresAt }

async function authenticate() {
  const res = await fetch(`${WH24_BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.WH24_CLIENT_ID,
      client_secret: env.WH24_CLIENT_SECRET,
      grant_type: env.WH24_GRANT_TYPE || 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`WH24 authentication failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('WH24 authentication response had no access_token.');
  const expiresIn = Number(body.expires_in) || 600;
  cachedToken = { accessToken: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedToken;
}

/** Calls WorkHub24, generating a new token when the cached one is missing, about to expire, or rejected. */
async function wh24(pathname, init = {}) {
  const send = async (forceNew) => {
    const token = forceNew || !cachedToken || cachedToken.expiresAt - Date.now() <= 60_000 ? await authenticate() : cachedToken;
    const headers = { accept: 'application/json', authorization: `Bearer ${token.accessToken}`, ...init.headers };
    if (init.body) headers['content-type'] = 'application/json';
    return fetch(`${WH24_BASE}${pathname}`, { ...init, headers });
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  const text = await res.text();
  if (!res.ok) throw new Error(`WH24 ${init.method || 'GET'} ${pathname} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const tablePath = (tableId) => `/api/datatables/${encodeURIComponent(TENANT)}/${encodeURIComponent(tableId)}/records`;

/** Normalises Sri Lankan mobiles to 94XXXXXXXXX so "076 907 3851", "+94769073851" and "94769073851" all match. */
function normalizePhone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 9) d = `94${d}`;
  return d;
}

async function findEmployee({ mode, value }) {
  const rows = await wh24(tablePath(EMPLOYEE_TABLE));
  if (!Array.isArray(rows)) throw new Error('WH24 employee table did not return an array.');
  if (mode === 'phone') {
    const phone = normalizePhone(value);
    return rows.find((r) => normalizePhone(r.mobileNumber) === phone) || null;
  }
  const id = String(value).trim().toUpperCase();
  return rows.find((r) => String(r.employeeID ?? '').trim().toUpperCase() === id) || null;
}

/** Creates a card in the WorkHub24 OTP workflow; the workflow sends the SMS. Logs it instead when no workflow is configured. */
async function deliverOtp(employee, otp) {
  const fullName = String(employee.fUllName ?? '').trim();
  const payload = {
    title: `OTP - ${employee.employeeID} - ${fullName}`,
    eMployeeID: employee.employeeID,
    fUllName: fullName,
    mobileNumber: normalizePhone(employee.mobileNumber),
    oTP: otp,
  };
  if (!OTP_WORKFLOW) {
    console.log(`[dev] WH24_OTP_WORKFLOW_ID not set. OTP for ${payload.eMployeeID} (${payload.mobileNumber}): ${otp}`);
    return;
  }
  const card = await wh24(`/api/workflows/${encodeURIComponent(TENANT)}/${encodeURIComponent(OTP_WORKFLOW)}/cards`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  console.log(`OTP card ${card?.id ?? ''} created for ${payload.eMployeeID} (${payload.mobileNumber})`);
}

// --- OTP + sessions (in memory) ---------------------------------------------
const otpStore = new Map(); // employeeID -> { hash, salt, expiresAt, attempts, employee }
const sessions = new Map(); // token -> { employee, expiresAt }

const hashCode = (salt, code) => crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');

function createOtp(employee) {
  const code = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(16).toString('hex');
  otpStore.set(employee.employeeID, {
    hash: hashCode(salt, code),
    salt,
    expiresAt: Date.now() + OTP_WINDOW_MS,
    attempts: 0,
    employee,
  });
  return code;
}

function maskPhone(phone) {
  const d = normalizePhone(phone);
  return `+94 •• ••• ${d.slice(-4)}`;
}

// Short-lived handle so the browser never has to hold the user ID it didn't type.
const challenges = new Map(); // challengeId -> employeeID

// --- HTTP -------------------------------------------------------------------
const rateHits = new Map();
function rateLimited(ip, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateHits.set(ip, hits);
  return hits.length > limit;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('Body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function requestOtp(req, res) {
  const { mode, value } = await readJson(req);
  if (!['emp', 'phone'].includes(mode) || typeof value !== 'string' || !value.trim()) {
    return send(res, 400, { code: 'BAD_REQUEST', message: 'Enter your User ID or mobile number.' });
  }
  const employee = await findEmployee({ mode, value });
  if (!employee || !employee.mobileNumber) {
    return send(res, 404, {
      code: 'NOT_FOUND',
      message: mode === 'phone' ? 'This mobile number is not registered. Please contact HR or IT Support.' : 'This User ID is not registered. Please contact HR or IT Support.',
    });
  }
  const code = createOtp(employee);
  await deliverOtp(employee, code);
  const challengeId = crypto.randomBytes(16).toString('hex');
  challenges.set(challengeId, employee.employeeID);
  send(res, 200, {
    challengeId,
    employeeID: employee.employeeID,
    fullName: String(employee.fUllName ?? '').trim(),
    maskedPhone: maskPhone(employee.mobileNumber),
    expiresInSeconds: OTP_WINDOW_MS / 1000,
  });
}

async function verifyOtp(req, res) {
  const { challengeId, code } = await readJson(req);
  const employeeID = challenges.get(challengeId);
  const record = employeeID && otpStore.get(employeeID);
  if (!record || Date.now() > record.expiresAt) {
    return send(res, 410, { code: 'OTP_EXPIRED', message: 'This code has expired. Please request a new code.' });
  }
  if (record.attempts >= OTP_ATTEMPTS_LIMIT) {
    return send(res, 423, { code: 'OTP_LOCKED', message: 'Too many incorrect attempts. Please request a new code.', attemptsLeft: 0 });
  }
  const ok = /^\d{6}$/.test(String(code)) && crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), Buffer.from(hashCode(record.salt, String(code)), 'hex'));
  if (!ok) {
    record.attempts += 1;
    const attemptsLeft = OTP_ATTEMPTS_LIMIT - record.attempts;
    return send(res, attemptsLeft > 0 ? 401 : 423, {
      code: attemptsLeft > 0 ? 'OTP_INCORRECT' : 'OTP_LOCKED',
      message: attemptsLeft > 0 ? 'That code is not correct.' : 'Too many incorrect attempts. Please request a new code.',
      attemptsLeft,
    });
  }
  otpStore.delete(employeeID);
  challenges.delete(challengeId);
  const token = crypto.randomBytes(32).toString('hex');
  const { employee } = record;
  sessions.set(token, { employee, expiresAt: Date.now() + SESSION_MS });
  send(res, 200, {
    token,
    expiresInSeconds: SESSION_MS / 1000,
    redirectUrl: PORTAL_URL,
    employee: { employeeID: employee.employeeID, fullName: String(employee.fUllName ?? '').trim() },
  });
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

function me(req, res) {
  const s = sessions.get(bearer(req));
  if (!s || Date.now() > s.expiresAt) return send(res, 401, { code: 'UNAUTHENTICATED', message: 'Please sign in.' });
  send(res, 200, {
    employeeID: s.employee.employeeID,
    fullName: String(s.employee.fUllName ?? '').trim(),
    maskedPhone: maskPhone(s.employee.mobileNumber),
    expiresInSeconds: Math.round((s.expiresAt - Date.now()) / 1000),
  });
}

function logout(req, res) {
  sessions.delete(bearer(req));
  send(res, 200, { ok: true });
}

async function serveStatic(req, res) {
  const file = STATIC_FILES[new URL(req.url, 'http://x').pathname];
  if (!file) return send(res, 404, { code: 'NOT_FOUND', message: 'Not found' });
  const body = await fs.readFile(path.join(STATIC_DIR, file));
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  try {
    if (req.method === 'POST' && req.url === '/api/auth/request-otp') {
      if (rateLimited(`req:${ip}`, 5)) return send(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' });
      return await requestOtp(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/auth/verify-otp') {
      if (rateLimited(`ver:${ip}`, 15)) return send(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' });
      return await verifyOtp(req, res);
    }
    if (req.method === 'GET' && req.url === '/api/auth/me') return me(req, res);
    if (req.method === 'POST' && req.url === '/api/auth/logout') return logout(req, res);
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET') return await serveStatic(req, res);
    send(res, 404, { code: 'NOT_FOUND', message: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 502, { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' });
  }
});

server.listen(PORT, () => {
  console.log(`Aitken Spence sign-in running at http://localhost:${PORT}`);
  if (!OTP_WORKFLOW) console.log('WH24_OTP_WORKFLOW_ID is empty: OTPs are printed here instead of being posted to WorkHub24.');
});
