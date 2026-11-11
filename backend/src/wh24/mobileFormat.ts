import { config } from '../config.js';

export type SmsMobileFormat = 'e164' | 'intl' | 'local';

export function formatSmsMobile(mobile: string, format: SmsMobileFormat = config.SMS_MOBILE_FORMAT): string {
  const trimmed = mobile.trim();
  const digits = trimmed.replace(/\D/g, '');
  const national = digits.startsWith('0094')
    ? digits.slice(4)
    : digits.startsWith('94')
      ? digits.slice(2)
      : digits.startsWith('0')
        ? digits.slice(1)
        : digits;

  if (!/^7\d{8}$/.test(national)) {
    throw new Error('WorkHub24 mobile number must be a Sri Lankan mobile number.');
  }

  const international = `94${national}`;
  if (format === 'e164') return `+${international}`;
  if (format === 'intl') return international;
  return `0${national}`;
}
