const env = import.meta.env;

export const config = {
  useMockApi: String(env.VITE_USE_MOCK_API ?? 'true') !== 'false',
  apiBaseUrl: (env.VITE_API_BASE_URL as string) || '/api',
  brokerName: (env.VITE_BROKER_NAME as string) || '[Broker name]',
  supportPhone: (env.VITE_SUPPORT_PHONE as string) || '[Support phone]',
  supportEmail: (env.VITE_SUPPORT_EMAIL as string) || '[Support email]',
  /** Session length after OTP verification, in seconds */
  sessionSeconds: 30 * 60,
  otpLength: 6,
  maxFileBytes: 10 * 1024 * 1024,
  /** Premium payment step (T-06). Not part of the pilot: off unless VITE_PAYMENT_ENABLED=true. */
  paymentEnabled: String(env.VITE_PAYMENT_ENABLED ?? 'false') === 'true',
};
