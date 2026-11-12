export type ApiErrorCode =
  | 'LINK_INVALID'
  | 'NOT_AUTHORISED'
  | 'ALREADY_SUBMITTED'
  | 'REQUEST_CLOSED'
  /** The previous step was just completed; WorkHub24 has not opened this step's task yet. */
  | 'PENDING'
  /** The request has not reached this step. */
  | 'NOT_READY'
  | 'OTP_INCORRECT'
  | 'OTP_EXPIRED'
  | 'OTP_LOCKED'
  | 'DUPLICATE_CHASSIS'
  | 'VALIDATION'
  | 'SESSION_EXPIRED'
  | 'NETWORK'
  | 'UNKNOWN';

export class ApiError extends Error {
  code: ApiErrorCode;
  fields?: Record<string, string>;
  attemptsLeft?: number;

  constructor(code: ApiErrorCode, message?: string, extra?: { fields?: Record<string, string>; attemptsLeft?: number }) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.fields = extra?.fields;
    this.attemptsLeft = extra?.attemptsLeft;
  }
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
        ...(err.attemptsLeft !== undefined ? { attemptsLeft: err.attemptsLeft } : {})
      }
    };
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return { error: { code: 'UNKNOWN', message } };
}
