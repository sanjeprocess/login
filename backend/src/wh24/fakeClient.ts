import { ApiError } from '../errors.js';
import { completeAfterUpdate, type TaskLookupOptions, type WorkHub24Card, type WorkHub24Client } from './client.js';
import { REQUEST_STATUS } from './fields.js';

export class FakeWorkHub24Client implements WorkHub24Client {
  private items = new Map<string, { itemId: string; workflow: 'WF-01' | 'WF-02'; fields: Record<string, unknown>; tables: Record<string, Record<string, unknown>[]>; taskId?: string; taskName?: string; lastUpdatedDate: string; openTask?: { taskId: string; stepId: string } }>();
  private datastores = new Map<string, Record<string, unknown>[]>();
  private requestNoIndex = new Map<string, string>();
  private nextRequestSequence = 149;
  private nextTaskSequence = 1;
  private readonly cardQueues = new Map<string, Promise<void>>();
  readonly completedTasks: { cardId: string; taskName: string }[] = [];
  readonly taskEvents: { operation: 'GET_TASK' | 'PUT' | 'POST_TASK'; cardId: string; taskName: string }[] = [];

  constructor() {
    this.seed();
  }

  private seed() {
    this.datastores.set('ds_finance_partner', [
      { iD: 1, name: 'Northgate Finance PLC', partnerCode: 'FP-01', status: 'Active' }
    ]);
    this.datastores.set('ds_finance_user', [
      {
        active: 'Yes',
        email: 'nadeesha.fernando@northgate.lk',
        iD: 1,
        mobile: '+94770000001',
        name: 'Nadeesha Fernando',
        partnerCode: 'FP-01',
        userCode: 'FU-01'
      }
    ]);

    // Row shapes match the real views (npm run probe -- views); numeric package columns are strings.
    this.datastores.set('ds_insurer_user', [
      {
        active: 'Yes',
        email: 'dilani.w@insurer-a.lk',
        iD: 1,
        insurerCode: 'INSA',
        mobile: '+94770000002',
        name: 'Dilani Wickramasinghe',
        userCode: 'IU-01'
      }
    ]);

    this.datastores.set('ds_insurer', [
      { active: 'Yes', apiUrl: '', connectionType: 'Webform', contactEmail: 'quotes@insurer-a.lk', iD: 1, insurerCode: 'INSA', name: 'Insurer A' },
      { active: 'Yes', apiUrl: '', connectionType: 'Webform', contactEmail: 'quotes@insurer-b.lk', iD: 2, insurerCode: 'INSB', name: 'Insurer B' }
    ]);

    const packageRow = (row: Record<string, string>) => ({ iD: 0, status: 'Active', sourceRequestNo: null, ...row });
    this.datastores.set('ds_package', [
      packageRow({
        packageRef: 'A-COMP-STD',
        insurerCode: 'INSA',
        insurerName: 'Insurer A',
        name: 'A-COMP-STD',
        vehicleCategory: 'Motor car',
        coverType: 'Comprehensive',
        sumMin: '1000000',
        sumMax: '15000000',
        premiumRate: '2.8',
        taxRate: '21',
        excess: '25000',
        validTo: '2026-12-31',
        standardCovers: 'Basic cover',
        optionalCovers: 'SRCC'
      }),
      packageRow({
        packageRef: 'A-COMP-PLUS',
        insurerCode: 'INSA',
        insurerName: 'Insurer A',
        name: 'A-COMP-PLUS',
        vehicleCategory: 'Motor car',
        coverType: 'Comprehensive',
        sumMin: '1000000',
        sumMax: '20000000',
        premiumRate: '3.1',
        taxRate: '21',
        excess: '15000',
        validTo: '2027-01-31',
        standardCovers: 'Extended cover',
        optionalCovers: 'SRCC'
      }),
      packageRow({
        packageRef: 'B-COMP-01',
        insurerCode: 'INSB',
        insurerName: 'Insurer B',
        name: 'B-COMP-01',
        vehicleCategory: 'Motor car',
        coverType: 'Comprehensive',
        sumMin: '2000000',
        sumMax: '12000000',
        premiumRate: '2.7',
        taxRate: '21',
        excess: '30000',
        validTo: '2027-01-31',
        standardCovers: 'Basic cover',
        optionalCovers: 'Roadside'
      })
    ]);

    const baseItem = {
      itemId: 'wf-01-0148',
      workflow: 'WF-01' as const,
      fields: {
        A1: 'MIG-2026-0148',
        A2: '2026-11-09T08:00:00.000000',
        A3: REQUEST_STATUS.awaitingQuotes,
        A4: 'Northgate Finance PLC',
        A6: 'Nadeesha Fernando',
        A7: 'nadeesha.fernando@northgate.lk',
        B2: 'Saman Silva',
        B3: '199012345V',
        B4: '+94770000007',
        B7: '●●● ●●● 0007',
        C1: 'Motor car',
        C2: 'Toyota',
        C3: 'Aqua',
        C4: 2019,
        C5: 'Registered',
        C6: 'ABC-4567',
        C7: 'CH-10001',
        C8: 'ENG-10001',
        C9: 8500000,
        C10: 'Private',
        D1: 'Lease',
        D2: 'FAC-01',
        D3: 1500000,
        D4: 36,
        E1: 'Comprehensive',
        E2: 8500000,
        E3: 'SRCC',
        E4: '2026-11-10',
        E5: 'Initial request',
        E6: true,
        // The insurer loop's current insurer; selectedInsurers (F1) is not returned by the API.
        G4: 'Insurer A',
        G5: 'quotes@insurer-a.lk',
        'H1.insurer': 'Insurer C',
        'H1.packageRef': 'C-API-PRIME',
        'H1.packageName': 'Prime Motor',
        'H1.premium': 320500,
        'H1.taxes': 67305,
        'H1.total': 387805,
        'H1.excess': 20000,
        'H1.standardCovers': 'Comprehensive',
        'H1.optionalCovers': 'SRCC',
        'H1.validUntil': '2026-12-31',
        I1: '',
        I2: '',
        I3: '',
        I4: '',
        I5: '',
        I5a: '',
        I6: '654321',
        I7: 'Pending',
        I8: 0,
        I9: '',
        I10: '',
        I11: '',
        I12: '',
        I13: '',
        K1: 287980,
        K2: '2026-11-25',
        K3: 'Outstanding'
      },
      tables: { J2: [], J6: [] },
      taskId: '4.0',
      taskName: 'Awaiting Insurer Responses',
      lastUpdatedDate: new Date().toISOString(),
      openTask: { taskId: '4.0', stepId: '4.0' }
    };

    this.items.set(baseItem.itemId, baseItem);
    this.requestNoIndex.set('MIG-2026-0148', baseItem.itemId);
  }

  async queryDatastore(table: string, filter: Record<string, string | number | boolean>): Promise<Record<string, unknown>[]> {
    const rows = this.datastores.get(table) ?? [];
    return rows.filter((row) => {
      return Object.entries(filter).every(([key, value]) => row[key] === value);
    });
  }

  async insertDatastoreRow(table: string, row: Record<string, unknown>): Promise<void> {
    const rows = this.datastores.get(table) ?? [];
    rows.push(row);
    this.datastores.set(table, rows);
  }

  async createItem(workflow: 'WF-01' | 'WF-02', fields: Record<string, unknown>): Promise<{ itemId: string; requestNo?: string; title?: string | null }> {
    const itemId = `item-${Math.random().toString(36).slice(2, 9)}`;
    const requestNo = typeof fields.A1 === 'string'
      ? fields.A1
      : workflow === 'WF-01'
        ? `MIG-${new Date().getFullYear()}-${String(this.nextRequestSequence++).padStart(4, '0')}`
        : undefined;
    const cardFields = requestNo ? { ...fields, A1: requestNo } : fields;
    const item = {
      itemId,
      workflow,
      fields: cardFields,
      tables: {},
      taskId: workflow === 'WF-01' ? '4.0' : 'wf-02-verification',
      taskName: workflow === 'WF-01' ? 'Start' : 'Awaiting Verification',
      lastUpdatedDate: new Date().toISOString(),
      openTask: workflow === 'WF-01'
        ? { taskId: '4.0', stepId: '4.0' }
        : { taskId: 'wf-02-verification', stepId: 'Awaiting Verification' }
    };
    this.items.set(itemId, item);
    if (requestNo) {
      this.requestNoIndex.set(requestNo, itemId);
    }
    return {
      itemId,
      requestNo,
      title: typeof cardFields.title === 'string' ? cardFields.title : null
    };
  }

  async getRequestCard(requestNo: string): Promise<WorkHub24Card | null> {
    const found = Array.from(this.items.values()).find((item) => item.workflow === 'WF-01' && String(item.fields.A1 ?? '') === requestNo);
    return found ? this.getItem(found.itemId) : null;
  }

  async findRequestByChassis(chassisNo: string): Promise<WorkHub24Card | null> {
    const found = Array.from(this.items.values()).find((item) => item.workflow === 'WF-01' && String(item.fields.C7 ?? '') === chassisNo);
    return found ? this.getItem(found.itemId) : null;
  }

  async getItem(itemId: string): Promise<WorkHub24Card> {
    const item = this.items.get(itemId);
    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }
    return {
      itemId: item.itemId,
      id: item.itemId,
      taskID: item.taskId ?? null,
      lastUpdatedDate: item.lastUpdatedDate,
      fields: item.fields,
      tables: item.tables,
      openTask: item.openTask
    };
  }

  async updateFields(itemId: string, fields: Record<string, unknown>): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    Object.assign(item.fields, fields);
    item.lastUpdatedDate = new Date().toISOString();
  }

  async addTableRow(itemId: string, tableId: string, row: Record<string, unknown>): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    const table = item.tables[tableId] ?? [];
    table.push(row);
    item.tables[tableId] = table;
    item.lastUpdatedDate = new Date().toISOString();
  }

  async uploadFile(itemId: string, fieldId: string, file: { name: string; mime: string; data: Buffer }): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    item.fields[fieldId] = { name: file.name, mime: file.mime, size: file.data.length, data: file.data };
  }

  private async withCardLock<T>(cardId: string | number, action: () => Promise<T>): Promise<T> {
    const key = String(cardId);
    const previous = this.cardQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.cardQueues.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.cardQueues.get(key) === tail) this.cardQueues.delete(key);
    }
  }

  readonly taskLookupWaits: number[] = [];

  async getOpenTaskId(
    cardId: string | number,
    taskName: string,
    workflow: 'WF-01' | 'WF-02' = 'WF-01',
    options: TaskLookupOptions = {}
  ): Promise<string> {
    this.taskLookupWaits.push(options.waitForTaskMs ?? 0);
    const item = this.items.get(String(cardId));
    if (!item) throw new Error(`Card ${cardId} not found`);
    if (item.workflow !== workflow) throw new Error(`Card ${cardId} does not belong to ${workflow}.`);
    if (item.taskName !== taskName || typeof item.taskId !== 'string' || !item.taskId.trim()) {
      throw new ApiError('ALREADY_SUBMITTED', 'This step has already been submitted.');
    }
    this.taskEvents.push({ operation: 'GET_TASK', cardId: String(cardId), taskName });
    return item.taskId;
  }

  private async markTaskDone(cardId: string | number, taskName: string): Promise<void> {
    const item = this.items.get(String(cardId));
    if (!item) throw new Error(`Card ${cardId} not found`);
    const taskId = `fake-task-${this.nextTaskSequence++}`;
    const nextTaskName = taskName === 'Awaiting Insurer Responses'
      ? 'Awaiting Package Selection'
      : taskName === 'Awaiting Package Selection'
        ? 'Awaiting OTP Verification'
        : taskName === 'Awaiting OTP Verification' && item.fields.I7 === 'Failed'
          ? 'Awaiting OTP Verification'
          : taskName === 'Awaiting OTP Verification'
            ? 'Awaiting Policy Upload'
            : undefined;
    const openNext = () => {
      item.taskId = taskId;
      item.taskName = nextTaskName;
    };
    if (this.nextTaskDelayMs > 0 && nextTaskName) {
      // Like WorkHub24 running automated steps (e.g. the customer SMS) before the next task exists.
      item.taskId = undefined;
      item.taskName = undefined;
      setTimeout(openNext, this.nextTaskDelayMs);
    } else {
      openNext();
    }
    item.openTask = { taskId, stepId: taskName };
    // Status (A3) is set by the backend, never by the workflow.
    item.lastUpdatedDate = new Date().toISOString();
    this.completedTasks.push({ cardId: String(cardId), taskName });
    this.taskEvents.push({ operation: 'POST_TASK', cardId: String(cardId), taskName });
  }

  async updateAndCompleteTask(
    cardId: string | number,
    taskName: string,
    prepareFields: () => Promise<Record<string, unknown>> | Record<string, unknown>
  ): Promise<void> {
    await this.withCardLock(cardId, async () => {
      await this.getOpenTaskId(cardId, taskName);
      const fields = await prepareFields();
      this.taskEvents.push({ operation: 'PUT', cardId: String(cardId), taskName });
      await this.updateFields(String(cardId), fields);
      await completeAfterUpdate(cardId, taskName, async () => {
        if (this.failNextTaskCompletion) {
          this.failNextTaskCompletion = false;
          throw new Error('Simulated task completion failure');
        }
        await this.markTaskDone(cardId, taskName);
      });
    });
  }

  /** Tests: after a WF-01 task is completed, the next task appears only after this many ms. */
  nextTaskDelayMs = 0;

  /** Tests: make the next WF-01 task completion fail after its card update succeeded. */
  failNextTaskCompletion = false;

  async completeTask(cardId: string | number, taskName: string): Promise<void> {
    await this.withCardLock(cardId, async () => {
      await this.getOpenTaskId(cardId, taskName);
      await this.markTaskDone(cardId, taskName);
    });
  }

  async updateAndCompleteTaskForWorkflow(
    _workflow: 'WF-01' | 'WF-02',
    cardId: string | number,
    taskName: string,
    fields: Record<string, unknown>,
    options: TaskLookupOptions = {}
  ): Promise<void> {
    await this.withCardLock(cardId, async () => {
      await this.getOpenTaskId(cardId, taskName, _workflow, options);
      this.taskEvents.push({ operation: 'PUT', cardId: String(cardId), taskName });
      await this.updateFields(String(cardId), fields);
      await this.markTaskDone(cardId, taskName);
    });
  }

  getItemByRequestNo(requestNo: string) {
    const itemId = this.requestNoIndex.get(requestNo);
    if (!itemId) return undefined;
    return this.items.get(itemId);
  }

  setOpenTask(cardId: string, taskName: string) {
    const item = this.items.get(cardId);
    if (!item) throw new Error(`Card ${cardId} not found`);
    item.taskName = taskName;
    item.taskId = `fake-task-${this.nextTaskSequence++}`;
    item.openTask = { taskId: item.taskId, stepId: taskName };
  }
}
