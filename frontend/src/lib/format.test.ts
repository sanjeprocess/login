import { describe, expect, it } from 'vitest';
import { formatAmountInput, formatMobile, longDate, maskMobile, mmss, money } from './format';

describe('format', () => {
  it('formats money with 2 decimals', () => {
    expect(money(8500000)).toBe('8,500,000.00');
    expect(formatAmountInput('287980')).toBe('287,980.00');
    expect(formatAmountInput('abc')).toBe('abc');
  });

  it('normalises mobile numbers to +94 format', () => {
    expect(formatMobile('0774567123')).toBe('+94 77 456 7123');
    expect(formatMobile('+94774567123')).toBe('+94 77 456 7123');
    expect(formatMobile('12345')).toBe('12345');
  });

  it('formats dates and timers', () => {
    expect(longDate('2026-11-10')).toBe('10 Nov 2026');
    expect(mmss(65)).toBe('1:05');
    expect(maskMobile('+94 77 456 7123')).toBe('●●● ●●● 7123');
  });
});
