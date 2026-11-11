import { ApiError } from '../errors.js';
import type { WorkHub24Card, WorkHub24Client } from '../wh24/client.js';
import { REQUEST_STATUS } from '../wh24/fields.js';

export async function requireOpenTask(
  client: WorkHub24Client,
  card: WorkHub24Card,
  taskName: string
): Promise<string> {
  try {
    return await client.getOpenTaskId(card.id ?? card.itemId, taskName);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'ALREADY_SUBMITTED' &&
        String(card.fields.A3 ?? '') === REQUEST_STATUS.completed) {
      throw new ApiError('REQUEST_CLOSED', 'This request has already been completed.');
    }
    throw error;
  }
}
