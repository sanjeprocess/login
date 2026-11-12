import { ApiError } from '../errors.js';
import type { WorkHub24Card, WorkHub24Client } from '../wh24/client.js';
import { REQUEST_STATUS, type RequestStatus } from '../wh24/fields.js';

const STATUS_ORDER: RequestStatus[] = [
  REQUEST_STATUS.awaitingQuotes,
  REQUEST_STATUS.awaitingSelection,
  REQUEST_STATUS.awaitingConsent,
  REQUEST_STATUS.awaitingPolicy,
  REQUEST_STATUS.completed
];

interface TaskStep {
  /** Status (A3) while this task is the current step. */
  status: RequestStatus;
  /**
   * True when the card shows the backend has just completed the step before this one. WorkHub24
   * can take up to about a minute (e.g. sending the customer SMS) before this task exists.
   */
  handedOver(fields: Record<string, unknown>): boolean;
  pendingMessage: string;
}

const text = (fields: Record<string, unknown>, key: string) => String(fields[key] ?? '').trim();

const TASK_STEPS: Record<string, TaskStep> = {
  // Opened by Broker Review in WorkHub24, not by a backend handover: never pending.
  'Awaiting Insurer Responses': {
    status: REQUEST_STATUS.awaitingQuotes,
    handedOver: () => false,
    pendingMessage: ''
  },
  // Screen 2 -> Screen 3: the insurer's response set "Awaiting Selection".
  'Awaiting Package Selection': {
    status: REQUEST_STATUS.awaitingSelection,
    handedOver: (fields) => !text(fields, 'I2'),
    pendingMessage: 'The insurer’s packages are still being prepared.'
  },
  // Screen 3 select -> code entry: the selection set "Awaiting Consent"; WorkHub24 sends the SMS.
  // Also the gap after three wrong codes, while WorkHub24 sends a new code.
  'Awaiting OTP Verification': {
    status: REQUEST_STATUS.awaitingConsent,
    handedOver: (fields) => Boolean(text(fields, 'I2')) && text(fields, 'I7') !== 'Verified',
    pendingMessage: 'Sending the code to the customer…'
  },
  // Code verified -> Screen 4: the verification set "Awaiting Policy".
  'Awaiting Policy Upload': {
    status: REQUEST_STATUS.awaitingPolicy,
    handedOver: (fields) => text(fields, 'I7') === 'Verified',
    pendingMessage: 'The customer’s confirmation is still being processed.'
  }
};

/**
 * Why is `taskName` not open? Decided from the status the backend itself sets on each handover:
 * - status past this step: ALREADY_SUBMITTED (REQUEST_CLOSED once completed);
 * - status at this step and the previous step was just completed: PENDING (WorkHub24 has not
 *   opened the task yet; the screen re-checks);
 * - status before this step: NOT_READY.
 * An unrecognised status or task keeps the plain ALREADY_SUBMITTED.
 */
export function explainMissingTask(fields: Record<string, unknown>, taskName: string, original: ApiError): ApiError {
  const status = text(fields, 'A3');
  if (status === REQUEST_STATUS.completed) return new ApiError('REQUEST_CLOSED', 'This request has already been completed.');
  const step = TASK_STEPS[taskName];
  const rank = STATUS_ORDER.indexOf(status as RequestStatus);
  if (!step || rank < 0) return original;
  const stepRank = STATUS_ORDER.indexOf(step.status);
  if (rank > stepRank) return original;
  if (rank === stepRank && step.handedOver(fields)) return new ApiError('PENDING', step.pendingMessage);
  return new ApiError('NOT_READY', 'This step is not open yet.');
}

export async function requireOpenTask(
  client: WorkHub24Client,
  card: WorkHub24Card,
  taskName: string
): Promise<string> {
  try {
    return await client.getOpenTaskId(card.id ?? card.itemId, taskName);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'ALREADY_SUBMITTED') {
      throw explainMissingTask(card.fields, taskName, error);
    }
    throw error;
  }
}
