import fieldMap from '../../config/wf01-field-map.json' with { type: 'json' };
import wf02FieldMap from '../../config/wf02-field-map.json' with { type: 'json' };

export const FIELD_MAP: Record<string, string> = fieldMap.fields;
export const WF02_FIELD_MAP: Record<string, string> = wf02FieldMap.fields;
export const REVERSE_FIELD_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_MAP).map(([fieldId, key]) => [key, fieldId])
);

/**
 * WF-01 status (A3). Set only by the backend (WorkHub24 no longer sets it), in the same card
 * update that runs just before the backend completes a task:
 *   Screen 1 create                          -> awaitingQuotes
 *   Screen 2 response (Awaiting Insurer Responses) -> awaitingSelection
 *   Screen 3 select (Awaiting Package Selection)   -> awaitingConsent
 *   Screen 3 code verified (Awaiting OTP Verification) -> awaitingPolicy
 *   Screen 4 binding (Awaiting Policy Upload) -> completed
 * A failed step (e.g. a wrong customer code) leaves it unchanged.
 */
export const REQUEST_STATUS = {
  awaitingQuotes: 'Awaiting Quotes',
  awaitingSelection: 'Awaiting Selection',
  awaitingConsent: 'Awaiting Consent',
  awaitingPolicy: 'Awaiting Policy',
  completed: 'Completed'
} as const;

export type RequestStatus = typeof REQUEST_STATUS[keyof typeof REQUEST_STATUS];

export function fieldKey(fieldId: string): string {
  return FIELD_MAP[fieldId] ?? fieldId;
}

export function fieldId(key: string): string {
  return REVERSE_FIELD_MAP[key] ?? key;
}

export function wf02FieldKey(fieldId: string): string {
  return WF02_FIELD_MAP[fieldId] ?? fieldId;
}
