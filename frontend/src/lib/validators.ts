/* Field validators. Each returns '' when the value is valid, or the error message to show. */

export type Validator = (value: string, label: string) => string;

const strip = (v: string) => String(v ?? '').replace(/\s/g, '');

export const parseAmount = (v: string): number => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** Today's date as YYYY-MM-DD in the browser's time zone. */
export const todayIso = (now: Date = new Date()): string => {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
};

export const V = {
  required: ((v, label) => (String(v ?? '').trim() ? '' : `Enter ${label.toLowerCase()}`)) as Validator,

  /** Sri Lankan NIC: 9 digits + V/X (old) or 12 digits (new). */
  nic: ((v) => (/^(\d{9}[VvXx]|\d{12})$/.test(strip(v)) ? '' : 'Enter a valid NIC: 9 digits + V or X, or 12 digits')) as Validator,

  /** Business registration number, e.g. PV 00123456. */
  brn: ((v) => (/^[A-Za-z]{1,3}\s?\d{4,8}$/.test(String(v ?? '').trim()) ? '' : 'Enter the registration number, e.g. PV 00123456')) as Validator,

  /** Sri Lankan mobile in +94 7X XXX XXXX form (spaces allowed). */
  mobile: ((v) => (/^\+947\d{8}$/.test(strip(v)) ? '' : 'Enter as +94 7X XXX XXXX')) as Validator,

  /** Optional email: empty passes. */
  email: ((v) => (!String(v ?? '').trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? '' : 'Enter a valid email, e.g. name@example.com')) as Validator,

  emailRequired: ((v) => {
    if (!String(v ?? '').trim()) return 'Enter your registered email';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? '' : 'Enter a valid email, e.g. name@company.lk';
  }) as Validator,

  year: ((v) => {
    const max = new Date().getFullYear() + 1;
    const n = Number(v);
    return /^\d{4}$/.test(String(v ?? '')) && n >= 1990 && n <= max ? '' : `Enter a year between 1990 and ${max}`;
  }) as Validator,

  amount: ((v) => (parseAmount(v) > 0 ? '' : 'Enter an amount in LKR')) as Validator,

  amountOrZero: ((v) => (parseAmount(v) >= 0 ? '' : 'Enter an amount in LKR (0 or more)')) as Validator,

  tenure: ((v) => {
    const n = Number(v);
    return /^\d+$/.test(String(v ?? '')) && n >= 1 && n <= 120 ? '' : 'Enter 1 to 120 months';
  }) as Validator,

  rate: ((v) => {
    const n = parseFloat(String(v ?? ''));
    return n > 0 && n <= 10 ? '' : 'Enter a rate between 0.01 and 10.00';
  }) as Validator,

  /** Date today or later. */
  dateFromToday: ((v) => {
    if (!v) return 'Choose a date';
    return v >= todayIso() ? '' : 'Choose today or a later date';
  }) as Validator,

  /** Date today or earlier. */
  dateUpToToday: ((v) => {
    if (!v) return 'Choose a date';
    return v <= todayIso() ? '' : 'The date cannot be in the future';
  }) as Validator,

  date: ((v) => (v ? '' : 'Choose a date')) as Validator,

  otp: ((v) => (/^\d{6}$/.test(String(v ?? '')) ? '' : 'Enter all 6 digits')) as Validator,
};

/** Run validators in order and return the first error, or ''. */
export function validate(value: string, label: string, rules: Validator[] = []): string {
  for (const rule of rules) {
    const msg = rule(value, label);
    if (msg) return msg;
  }
  return '';
}

/** Files: type and size checks for uploads. */
export function fileError(file: File, allowed: string[], maxBytes: number): string {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!allowed.includes(ext)) return `${file.name}: use ${allowed.map((a) => a.toUpperCase()).join(', ')}`;
  if (file.size > maxBytes) return `${file.name}: larger than ${Math.round(maxBytes / 1024 / 1024)} MB`;
  return '';
}
