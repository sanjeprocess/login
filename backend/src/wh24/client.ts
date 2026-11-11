import { ApiError } from '../errors.js';

export interface WorkHub24Card {
  id?: number | string;
  itemId: string;
  taskID?: string | null;
  lastUpdatedDate?: string | null;
  fields: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
  openTask?: { taskId: string; stepId: string };
}

export interface WorkHub24Client {
  queryDatastore(table: string, filter: Record<string, string | number | boolean>): Promise<Record<string, unknown>[]>;
  createItem(workflow: 'WF-01' | 'WF-02', fields: Record<string, unknown>): Promise<{ itemId: string; requestNo?: string; title?: string | null }>;
  /** The WF-01 card for a request number, or null if there is none. */
  getRequestCard(requestNo: string): Promise<WorkHub24Card | null>;
  /**
   * Optional chassis search. The live tenant has no working card search (cards/list always
   * returns HTML), so the HTTP client leaves this out and the duplicate check is skipped.
   */
  findRequestByChassis?(chassisNo: string): Promise<WorkHub24Card | null>;
  getItem(itemId: string): Promise<WorkHub24Card>;
  updateFields(itemId: string, fields: Record<string, unknown>): Promise<void>;
  addTableRow(itemId: string, tableId: string, row: Record<string, unknown>): Promise<void>;
  /**
   * One lookup by default: no open task means ALREADY_SUBMITTED straight away.
   * Pass waitForTaskMs (capped at MAX_TASK_WAIT_MS) only when the task is expected to have
   * just been created, i.e. its predecessor was completed moments ago.
   */
  getOpenTaskId(cardId: string | number, taskName: string, workflow?: 'WF-01' | 'WF-02', options?: TaskLookupOptions): Promise<string>;
  updateAndCompleteTask(
    cardId: string | number,
    taskName: string,
    prepareFields: () => Promise<Record<string, unknown>> | Record<string, unknown>
  ): Promise<void>;
  completeTask(cardId: string | number, taskName: string): Promise<void>;
  updateAndCompleteTaskForWorkflow(
    workflow: 'WF-01' | 'WF-02',
    cardId: string | number,
    taskName: string,
    fields: Record<string, unknown>,
    options?: TaskLookupOptions
  ): Promise<void>;
}

export interface TaskLookupOptions {
  waitForTaskMs?: number;
}

export const MAX_TASK_WAIT_MS = 8_000;

/**
 * Completes a task after its card update has already been saved. If completion fails, the update
 * is not retried: the error is logged (ids only, no personal data) and the screen gets an error.
 */
export async function completeAfterUpdate(cardId: string | number, taskName: string, complete: () => Promise<void>): Promise<void> {
  try {
    await complete();
  } catch (error) {
    console.error('WorkHub24 card was updated but completing the task failed; the update is not retried.', {
      cardId: String(cardId),
      taskName,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new ApiError('UNKNOWN', 'Your changes were saved, but WorkHub24 could not complete this step. Please contact the broker.');
  }
}
