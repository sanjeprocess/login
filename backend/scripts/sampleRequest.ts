/** Shared by scripts/e2e-wh24.ts and `probe createbisect`: the same users, package and request values. */
import { isRecommendable, normalizePackageRow, packageBelongsTo, type PackageRow } from '../src/services/matching.js';
import type { RequestBody } from '../src/routes/requests.js';
import { financePartnerName } from '../src/services/partners.js';
import type { WorkHub24Client } from '../src/wh24/client.js';
import type { SessionUser } from '../src/types.js';

export const FINANCE_EMAIL = 'renu@process361.com';

export function maskLast3(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits ? `${'*'.repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}` : '(empty)';
}

export function isoDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export async function loadFinanceUser(client: WorkHub24Client): Promise<{ user: SessionUser; customerMobile: string } | { error: string; expected: string }> {
  const rows = await client.queryDatastore('ds_finance_user', {});
  const row = rows.find((candidate) => candidate.active === 'Yes' && String(candidate.email ?? '').toLowerCase() === FINANCE_EMAIL);
  if (!row) return { error: 'Finance user not found or not active.', expected: `active row in the finance users view for ${FINANCE_EMAIL}` };
  const national = String(row.mobile ?? '').replace(/\D/g, '').slice(-9);
  if (!/^7\d{8}$/.test(national)) {
    return { error: `Finance user mobile (${maskLast3(String(row.mobile ?? ''))}) is not a Sri Lankan mobile.`, expected: 'finance users view "mobile" = 7XXXXXXXX' };
  }
  return {
    user: {
      role: 'finance', name: String(row.name ?? ''), email: String(row.email ?? ''),
      partner: await financePartnerName(client, String(row.partnerCode ?? ''))
    },
    customerMobile: `+94${national}`
  };
}

export interface TestPackage {
  pkg: PackageRow;
  sumInsured: number;
  insurerUser: SessionUser;
  insurerUserCode: string;
}

/** First active Webform insurer with an active user and an Active, in-date, recommendable package. */
export async function pickTestPackage(client: WorkHub24Client, insurerCode?: string): Promise<TestPackage | undefined> {
  const insurers = (await client.queryDatastore('ds_insurer', {}))
    .filter((row) => row.active === 'Yes' && row.connectionType === 'Webform')
    .filter((row) => !insurerCode || row.insurerCode === insurerCode);
  const insurerUsers = (await client.queryDatastore('ds_insurer_user', {})).filter((row) => row.active === 'Yes');
  const packages = (await client.queryDatastore('ds_package', {})).map(normalizePackageRow);

  for (const insurer of insurers) {
    const code = String(insurer.insurerCode ?? '');
    const name = String(insurer.name ?? '');
    const userRow = insurerUsers.find((row) => row.insurerCode === code);
    if (!userRow) continue;
    for (const pkg of packages) {
      if (!packageBelongsTo(pkg, { name, code }) || pkg.status !== 'Active') continue;
      if (pkg.coverType !== 'Comprehensive' && pkg.coverType !== 'Third Party') continue;
      const upper = pkg.sumMax === Number.MAX_SAFE_INTEGER ? pkg.sumMin + 2_000_000 : pkg.sumMax;
      const sumInsured = Math.round((pkg.sumMin + upper) / 2 / 1000) * 1000;
      if (!isRecommendable(pkg, pkg.vehicleCategory, pkg.coverType, sumInsured)) continue;
      return {
        pkg,
        sumInsured,
        insurerUser: { role: 'insurer', name: String(userRow.name ?? ''), email: String(userRow.email ?? ''), insurer: name || code, insurerCode: code },
        insurerUserCode: String(userRow.userCode ?? '')
      };
    }
  }
  return undefined;
}

/** The Screen 1 request body used by the e2e run. */
export function buildSampleRequest(pkg: PackageRow, sumInsured: number, customerMobile: string, stamp = Date.now().toString(36).toUpperCase()): RequestBody {
  return {
    customer: { type: 'Individual', name: 'E2E Test Customer', idNumber: '200012345678', mobile: customerMobile, address: 'E2E test address, Colombo' },
    vehicle: {
      category: pkg.vehicleCategory, make: 'Toyota', model: 'Axio', year: new Date().getFullYear() - 2, condition: 'Registered',
      registrationNo: `E2E-${stamp.slice(-4)}`, chassisNo: `E2ECH${stamp}`, engineNo: `E2EEN${stamp}`, value: sumInsured, usage: 'Private'
    },
    finance: { facilityType: 'Lease', referenceNo: `E2E-${stamp}`, amount: Math.round(sumInsured * 0.8), tenureMonths: 60 },
    cover: { coverType: pkg.coverType as RequestBody['cover']['coverType'], sumInsured, optionalCovers: [], policyStartDate: isoDate(7), remarks: 'E2E smoke test' },
    consent: true
  };
}
