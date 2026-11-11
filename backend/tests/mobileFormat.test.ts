import { describe, expect, it } from 'vitest';

import { formatSmsMobile } from '../src/wh24/mobileFormat.js';

describe('formatSmsMobile', () => {
  it.each([
    ['e164', '+94751136543'],
    ['intl', '94751136543'],
    ['local', '0751136543']
  ] as const)('formats Sri Lankan mobile numbers as %s', (format, expected) => {
    expect(formatSmsMobile('+94751136543', format)).toBe(expected);
  });

  it('accepts local and international inputs for the selected output format', () => {
    expect(formatSmsMobile('0751 136 543', 'intl')).toBe('94751136543');
    expect(formatSmsMobile('0094 751 136 543', 'local')).toBe('0751136543');
  });

  it('rejects invalid numbers rather than sending a malformed mobile', () => {
    expect(() => formatSmsMobile('+94112223333', 'intl')).toThrow(/Sri Lankan mobile/);
  });
});
