export function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

export function calculatePremiumBreakdown(sumInsured: number, premiumRate: number, taxRate: number) {
  const premium = roundCurrency((sumInsured * premiumRate) / 100);
  const taxes = roundCurrency((premium * taxRate) / 100);
  const total = roundCurrency(premium + taxes);
  return { premium, taxes, total };
}

/**
 * A row of the packages view (WH24_VIEW_PACKAGES). Keys verified with `npm run probe -- views`:
 * iD, packageRef, name, insurerCode, insurerName, vehicleCategory, coverType, sumMin, sumMax,
 * premiumRate, taxRate, excess, standardCovers, optionalCovers, validTo, status, sourceRequestNo.
 * Numeric columns arrive as strings.
 */
export interface PackageRow {
  packageRef: string;
  name: string;
  insurerCode: string;
  insurerName: string;
  vehicleCategory: string;
  coverType: string;
  sumMin: number;
  sumMax: number;
  premiumRate: number;
  taxRate: number;
  excess: number;
  standardCovers: string;
  optionalCovers: string[];
  validTo: string;
  status: string;
}

function toNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function splitCovers(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((cover) => cover.trim()).filter(Boolean);
  return String(value ?? '').split(',').map((cover) => cover.trim()).filter(Boolean);
}

export function normalizePackageRow(row: Record<string, unknown>): PackageRow {
  const packageRef = String(row.packageRef ?? '');
  return {
    packageRef,
    name: String(row.name ?? '') || packageRef,
    insurerCode: String(row.insurerCode ?? ''),
    insurerName: String(row.insurerName ?? ''),
    vehicleCategory: String(row.vehicleCategory ?? ''),
    coverType: String(row.coverType ?? ''),
    sumMin: toNumber(row.sumMin, 0),
    sumMax: toNumber(row.sumMax, Number.MAX_SAFE_INTEGER),
    premiumRate: toNumber(row.premiumRate, Number.NaN),
    taxRate: toNumber(row.taxRate, Number.NaN),
    excess: toNumber(row.excess, 0),
    standardCovers: String(row.standardCovers ?? ''),
    optionalCovers: splitCovers(row.optionalCovers),
    validTo: String(row.validTo ?? ''),
    status: String(row.status ?? '')
  };
}

export function packageBelongsTo(pkg: PackageRow, insurer: { name: string; code?: string }): boolean {
  return (Boolean(insurer.name) && pkg.insurerName === insurer.name) ||
    (Boolean(insurer.code) && pkg.insurerCode === insurer.code);
}

/** Premium = sumInsured x premiumRate / 100; taxes = premium x taxRate / 100. */
export function priceForPackage(pkg: PackageRow, sumInsured: number) {
  if (!Number.isFinite(pkg.premiumRate) || !Number.isFinite(pkg.taxRate)) {
    throw new Error(`Package ${pkg.packageRef} has an invalid premiumRate or taxRate.`);
  }
  return calculatePremiumBreakdown(sumInsured, pkg.premiumRate, pkg.taxRate);
}

export function isRecommendable(pkg: PackageRow, vehicleCategory: string, coverType: string, sumInsured: number, today = new Date()) {
  const validTo = pkg.validTo ? new Date(pkg.validTo) : null;
  return (
    (!pkg.status || pkg.status === 'Active') &&
    pkg.vehicleCategory === vehicleCategory &&
    pkg.coverType === coverType &&
    sumInsured >= pkg.sumMin &&
    sumInsured <= pkg.sumMax &&
    validTo !== null &&
    !Number.isNaN(validTo.getTime()) &&
    // A package is still valid on its validTo date.
    validTo.getTime() + 24 * 60 * 60 * 1000 > today.getTime()
  );
}
