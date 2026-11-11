import { parseAmount } from './validators';

/** 8500000 -> "8,500,000.00" */
export function money(n: number): string {
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Reformat a typed amount on blur; leaves invalid input untouched so the error can show. */
export function formatAmountInput(v: string): string {
  const n = parseAmount(v);
  return n > 0 || n === 0 ? money(n) : v;
}

/** "0774567123" or "+94774567123" -> "+94 77 456 7123" */
export function formatMobile(v: string): string {
  let d = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^07\d{8}$/.test(d)) d = '+94' + d.slice(1);
  if (/^947\d{8}$/.test(d)) d = '+' + d;
  if (/^\+947\d{8}$/.test(d)) return `${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return v;
}

/** "2026-11-10" -> "10 Nov 2026" */
export function longDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** ISO date-time -> "5 Nov 2026, 12:04" */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${longDate(iso)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function fileSize(bytes: number): string {
  const kb = bytes / 1024;
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
}

/** Mask all but the last 4 digits of a mobile number. */
export function maskMobile(v: string): string {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `●●● ●●● ${digits.slice(-4)}` : v;
}
