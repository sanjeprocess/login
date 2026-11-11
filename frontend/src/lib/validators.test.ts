import { describe, expect, it } from 'vitest';
import { fileError, parseAmount, todayIso, V, validate } from './validators';

describe('validators', () => {
  it('accepts old and new NIC formats', () => {
    expect(V.nic('123456789V', 'NIC')).toBe('');
    expect(V.nic('123456789x', 'NIC')).toBe('');
    expect(V.nic('199012345678', 'NIC')).toBe('');
    expect(V.nic('19901234', 'NIC')).not.toBe('');
  });

  it('checks Sri Lankan mobile numbers', () => {
    expect(V.mobile('+94 77 456 7123', 'Mobile')).toBe('');
    expect(V.mobile('+94774567123', 'Mobile')).toBe('');
    expect(V.mobile('0774567', 'Mobile')).toBe('Enter as +94 7X XXX XXXX');
  });

  it('treats an empty optional email as valid', () => {
    expect(V.email('', 'Email')).toBe('');
    expect(V.email('bad@', 'Email')).not.toBe('');
  });

  it('parses amounts with thousand separators', () => {
    expect(parseAmount('8,500,000.00')).toBe(8500000);
    expect(V.amount('0', 'Amount')).not.toBe('');
    expect(V.amount('1,000', 'Amount')).toBe('');
  });

  it('limits tenure and premium rate', () => {
    expect(V.tenure('60', 'Tenure')).toBe('');
    expect(V.tenure('121', 'Tenure')).not.toBe('');
    expect(V.rate('2.95', 'Rate')).toBe('');
    expect(V.rate('12', 'Rate')).not.toBe('');
  });

  it('checks dates against today', () => {
    const today = todayIso();
    expect(V.dateFromToday(today, 'Date')).toBe('');
    expect(V.dateFromToday('2000-01-01', 'Date')).not.toBe('');
    expect(V.dateUpToToday('2999-01-01', 'Date')).not.toBe('');
  });

  it('returns the first failing rule', () => {
    expect(validate('', 'Customer name', [V.required])).toBe('Enter customer name');
  });

  it('checks file type and size', () => {
    const pdf = new File(['x'], 'quote.pdf', { type: 'application/pdf' });
    const exe = new File(['x'], 'run.exe');
    expect(fileError(pdf, ['pdf'], 1024)).toBe('');
    expect(fileError(exe, ['pdf'], 1024)).toMatch(/use PDF/);
    const big = new File([new Uint8Array(2048)], 'big.pdf');
    expect(fileError(big, ['pdf'], 1024)).toMatch(/larger than/);
  });
});
