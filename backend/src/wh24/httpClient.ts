import { config } from '../config.js';
import { FIELD_MAP, fieldId, fieldKey } from './fields.js';
import { ApiError } from '../errors.js';
import type { WorkHub24Card, WorkHub24Client } from './client.js';

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

type Workflow = 'WF-01' | 'WF-02';

const VIEW_IDS: Record<string, string> = {
  ds_finance_user: config.WH24_VIEW_FINANCE_USERS,
  ds_insurer_user: config.WH24_VIEW_INSURER_USERS,
  ds_insurer: config.WH24_VIEW_INSURERS,
  ds_finance_partner: config.WH24_VIEW_FINANCE_PARTNERS,
  ds_package: config.WH24_VIEW_PACKAGES,
  ds_vehicle_category: config.WH24_VIEW_VEHICLE_CATEGORIES
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCard(raw: Record<string, unknown>, fallbackId?: number): WorkHub24Card {
  const rawId = raw.id ?? fallbackId;
  if (typeof rawId !== 'number' && typeof rawId !== 'string') {
    throw new Error('WorkHub24 card response did not contain a numeric id.');
  }
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('WorkHub24 card response did not contain a valid numeric id.');
  }

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    fields[fieldId(key)] = value;
  }

  return {
    id,
    itemId: String(id),
    taskID: typeof raw.taskID === 'string' && raw.taskID ? raw.taskID : null,
    lastUpdatedDate: typeof raw.lastUpdatedDate === 'string' ? raw.lastUpdatedDate : null,
    fields,
    tables: {
      F1: Array.isArray(raw.selectedInsurers) ? raw.selectedInsurers as Record<string, unknown>[] : []
    }
  };
}

export class HttpWorkHub24Client implements WorkHub24Client {
  private cachedToken?: CachedToken;
  private readonly viewCache = new Map<string, { expiresAt: number; rows: Record<string, unknown>[] }>();
  private readonly cardQueues = new Map<string, Promise<void>>();

  private baseUrl(): string {
    const base = config.WH24_BASE_URL.replace(/\/+$/, '');
    if (!base) throw new Error('WH24_BASE_URL must be configured.');
    return base;
  }

  private workflowId(workflow: Workflow): string {
    const id = workflow === 'WF-01' ? config.WH24_WF01_ID : config.WH24_WF02_ID;
    if (!config.WH24_TENANT_ID || !id) {
      throw new Error(`WH24_TENANT_ID and ${workflow === 'WF-01' ? 'WH24_WF01_ID' : 'WH24_WF02_ID'} must be configured.`);
    }
    return id;
  }

  private workflowPath(workflow: Workflow): string {
    return `/api/workflows/${encodeURIComponent(config.WH24_TENANT_ID)}/${encodeURIComponent(this.workflowId(workflow))}`;
  }

  private async parseJson(response: Response, description: string): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`WH24 ${description} failed: ${response.status} ${response.statusText}: ${body}`);
    }
    if (!contentType.toLowerCase().includes('json')) {
      throw new Error(`WH24 ${description} returned non-JSON content (${contentType || 'unknown content type'}).`);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error(`WH24 ${description} returned invalid JSON.`, { cause: error });
    }
  }

  private async authenticate(): Promise<CachedToken> {
    const response = await fetch(`${this.baseUrl()}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.WH24_CLIENT_ID,
        client_secret: config.WH24_CLIENT_SECRET,
        grant_type: config.WH24_GRANT_TYPE
      })
    });
    const payload = await this.parseJson(response, 'authentication');
    if (!isRecord(payload)) throw new Error('WH24 authentication response was not a JSON object.');
    const accessToken = payload.access_token ?? payload.token;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('WH24 authentication response did not contain a token.');
    }
    const rawTokenType = typeof payload.token_type === 'string' ? payload.token_type.trim() : 'Bearer';
    const tokenType = rawTokenType.toLowerCase() === 'bearer' ? 'Bearer' : rawTokenType;
    const expiresIn = payload.expires_in === undefined ? undefined : Number(payload.expires_in);
    if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn <= 0)) {
      throw new Error('WH24 authentication response contained an invalid expires_in value.');
    }
    this.cachedToken = {
      accessToken,
      tokenType: tokenType || 'Bearer',
      expiresAt: expiresIn === undefined ? Number.POSITIVE_INFINITY : Date.now() + expiresIn * 1000
    };
    return this.cachedToken;
  }

  private async apiRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const send = async (refresh: boolean) => {
      const token = refresh || !this.cachedToken || this.cachedToken.expiresAt - Date.now() <= 60_000
        ? await this.authenticate()
        : this.cachedToken;
      const headers = new Headers(init.headers);
      headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return fetch(`${this.baseUrl()}${path}`, { ...init, headers });
    };

    let response = await send(false);
    if (response.status === 401) {
      this.cachedToken = undefined;
      response = await send(true);
    }
    return this.parseJson(response, path);
  }

  private cardPath(cardId: number): string {
    if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new Error('WorkHub24 card ID must be numeric.');
    return `${this.workflowPath('WF-01')}/cards/${cardId}`;
  }

  private cardNumber(cardId: string | number): number {
    const id = Number(cardId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('WorkHub24 card ID must be numeric.');
    return id;
  }

  private async withCardLock<T>(cardId: string | number, action: () => Promise<T>): Promise<T> {
    const key = String(this.cardNumber(cardId));
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

  async getView(viewId: string): Promise<Record<string, unknown>[]> {
    if (!viewId) throw new Error('A WorkHub24 view ID must be configured.');
    const cached = this.viewCache.get(viewId);
    if (viewId !== config.WH24_VIEW_PACKAGES && cached && cached.expiresAt > Date.now()) return cached.rows;
    const payload = await this.apiRequest(`/api/view/${encodeURIComponent(config.WH24_TENANT_ID)}/${encodeURIComponent(viewId)}`);
    if (!Array.isArray(payload) || !payload.every(isRecord)) {
      throw new Error('WorkHub24 view response did not contain a JSON array of rows.');
    }
    if (viewId !== config.WH24_VIEW_PACKAGES) {
      this.viewCache.set(viewId, { rows: payload, expiresAt: Date.now() + 60_000 });
    }
    return payload;
  }

  async queryDatastore(table: string, filter: Record<string, string | number | boolean>): Promise<Record<string, unknown>[]> {
    const viewId = VIEW_IDS[table];
    if (!viewId) throw new Error(`No WorkHub24 view is configured for ${table}.`);
    const rows = await this.getView(viewId);
    return rows.filter((row) => Object.entries(filter).every(([key, value]) => String(row[key] ?? '') === String(value)));
  }

  async createItem(workflow: Workflow, fields: Record<string, unknown>): Promise<{ itemId: string; requestNo?: string; title?: string | null }> {
    const mappedFields = Object.fromEntries(
      Object.entries(fields).filter(([key]) => key !== 'title').map(([key, value]) => [fieldKey(key), value])
    );
    const payload = await this.apiRequest(`${this.workflowPath(workflow)}/cards`, {
      method: 'POST',
      body: JSON.stringify({ ...mappedFields, ...(typeof fields.title === 'string' ? { title: fields.title } : {}) })
    });
    if (!isRecord(payload)) throw new Error('WorkHub24 create-card response was not a JSON object.');
    const card = normalizeCard(payload);
    return {
      itemId: card.itemId,
      requestNo: card.fields.A1 === undefined ? undefined : String(card.fields.A1),
      title: typeof payload.title === 'string' ? payload.title : null
    };
  }

  async listCards(filterTokens: Record<string, unknown>[]): Promise<WorkHub24Card[]> {
    const payload = await this.apiRequest(`${this.workflowPath('WF-01')}/cards/list`, {
      method: 'POST',
      body: JSON.stringify({
        fields: [...new Set(Object.values(FIELD_MAP))],
        filters: JSON.stringify(filterTokens),
        limit: 50,
        offset: 0,
        orderBy: 'lastUpdatedDate DESC',
        showArchived: false
      })
    });
    if (!Array.isArray(payload) || !payload.every(isRecord)) {
      throw new Error('WorkHub24 cards/list response did not contain a JSON array of cards.');
    }
    return payload.map((card) => normalizeCard(card));
  }

  async findItemByField(workflow: 'WF-01', field: string, value: string): Promise<{ itemId: string } | null> {
    const matches = await this.findItemsByField(workflow, field, value);
    return matches[0] ? { itemId: matches[0].itemId } : null;
  }

  async findItemsByField(_workflow: 'WF-01', field: string, value: string): Promise<{ itemId: string; fields: Record<string, unknown> }[]> {
    const filterTokens = [
      { type: 'field', value: fieldKey(field) },
      { type: 'operator', value: 'IS_EQUAL_TO' },
      { type: 'text', value },
      { type: 'operator', value: 'AND' },
      { type: 'field', value: 'deleted' },
      { type: 'operator', value: 'IS_EQUAL_TO' },
      { type: 'boolean', value: false }
    ];
    const cards = await this.listCards(filterTokens);
    return cards.map((card) => ({ itemId: card.itemId, fields: card.fields }));
  }

  async getCard(cardId: number): Promise<WorkHub24Card> {
    const payload = await this.apiRequest(this.cardPath(cardId));
    if (!isRecord(payload)) throw new Error('WorkHub24 card response was not a JSON object.');
    return normalizeCard(payload, cardId);
  }

  async getItem(itemId: string): Promise<WorkHub24Card> {
    const cardId = Number(itemId);
    return this.getCard(cardId);
  }

  async updateFields(itemId: string, fields: Record<string, unknown>): Promise<void> {
    const cardId = Number(itemId);
    const mappedFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [fieldKey(key), value]));
    await this.apiRequest(this.cardPath(cardId), { method: 'PUT', body: JSON.stringify(mappedFields) });
  }

  async addTableRow(itemId: string, tableId: string, row: Record<string, unknown>): Promise<void> {
    const card = await this.getItem(itemId);
    const existing = card.fields[tableId];
    if (existing !== undefined && existing !== null && !Array.isArray(existing)) {
      throw new Error(`WorkHub24 table field ${fieldKey(tableId)} is not an array.`);
    }
    await this.updateFields(itemId, { [tableId]: [...(Array.isArray(existing) ? existing as Record<string, unknown>[] : []), row] });
  }

  async getOpenTaskId(cardId: string | number, taskName: string): Promise<string> {
    const id = this.cardNumber(cardId);
    if (!config.WH24_VIEW_TASKS) throw new Error('WH24_VIEW_TASKS must be configured to look up open tasks.');
    const deadline = Date.now() + 20_000;

    while (true) {
      const params = new URLSearchParams({ Task_Name: taskName, Card_id: String(id) });
      const payload = await this.apiRequest(
        `/api/view/${encodeURIComponent(config.WH24_TENANT_ID)}/${encodeURIComponent(config.WH24_VIEW_TASKS)}?${params.toString()}`
      );
      if (!Array.isArray(payload) || !payload.every(isRecord)) {
        throw new Error('WorkHub24 task-history view response did not contain a JSON array of rows.');
      }
      if (payload.length > 0) {
        const taskId = payload[0].iD;
        if ((typeof taskId === 'string' && taskId.trim()) || (typeof taskId === 'number' && Number.isFinite(taskId))) {
          return String(taskId);
        }
        throw new Error('WorkHub24 task-history view row did not contain a valid iD.');
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ApiError('ALREADY_SUBMITTED', 'This step has already been submitted.');
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, remaining)));
    }
  }

  private async postTask(taskId: string, taskName: string): Promise<void> {
    await this.apiRequest(`/api/tasks/${encodeURIComponent(config.WH24_TENANT_ID)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'DONE', comment: `${taskName} via webform` })
    });
  }

  async updateAndCompleteTask(
    cardId: string | number,
    taskName: string,
    prepareFields: () => Promise<Record<string, unknown>> | Record<string, unknown>
  ): Promise<void> {
    await this.withCardLock(cardId, async () => {
      const id = this.cardNumber(cardId);
      const taskId = await this.getOpenTaskId(id, taskName);
      const fields = await prepareFields();
      await this.updateFields(String(id), fields);
      await this.postTask(taskId, taskName);
    });
  }

  async completeTask(cardId: string | number, taskName: string): Promise<void> {
    await this.withCardLock(cardId, async () => {
      const id = this.cardNumber(cardId);
      const taskId = await this.getOpenTaskId(id, taskName);
      await this.postTask(taskId, taskName);
    });
  }
}
