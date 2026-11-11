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
  findItemByField(workflow: 'WF-01', fieldId: string, value: string): Promise<{ itemId: string } | null>;
  findItemsByField(workflow: 'WF-01', fieldId: string, value: string): Promise<{ itemId: string; fields: Record<string, unknown> }[]>;
  getItem(itemId: string): Promise<WorkHub24Card>;
  updateFields(itemId: string, fields: Record<string, unknown>): Promise<void>;
  addTableRow(itemId: string, tableId: string, row: Record<string, unknown>): Promise<void>;
  getOpenTaskId(cardId: string | number, taskName: string): Promise<string>;
  updateAndCompleteTask(
    cardId: string | number,
    taskName: string,
    prepareFields: () => Promise<Record<string, unknown>> | Record<string, unknown>
  ): Promise<void>;
  completeTask(cardId: string | number, taskName: string): Promise<void>;
}
