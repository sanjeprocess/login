import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const defaultOffersFile = resolve(process.cwd(), 'data', 'offers.json');
const defaultOtpAttemptsFile = resolve(process.cwd(), 'data', 'customer-otp-attempts.json');

export interface StoredOffer {
  requestNo: string;
  insurer: string;
  packageRef: string;
  respondedBy: string;
  respondedAt: string;
}

export interface OffersRepository {
  get(requestNo: string): Promise<StoredOffer[]>;
  add(offer: StoredOffer): Promise<{ offers: StoredOffer[]; added: boolean }>;
}

export interface OtpAttemptsRepository {
  get(requestNo: string): Promise<number>;
  increment(requestNo: string): Promise<number>;
  clear(requestNo: string): Promise<void>;
}

async function readJson(path: string, missingValue: Record<string, unknown> | unknown[] = {}): Promise<Record<string, unknown> | unknown[]> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof data !== 'object' || data === null) throw new Error(`Data file ${path} must contain a JSON object or array.`);
    return data as Record<string, unknown> | unknown[];
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return missingValue;
    throw error;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function normalizeStoredOffer(value: unknown): StoredOffer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.requestNo !== 'string' ||
      typeof row.insurer !== 'string' ||
      typeof row.packageRef !== 'string' ||
      typeof row.respondedBy !== 'string' ||
      typeof row.respondedAt !== 'string') return null;
  return {
    requestNo: row.requestNo,
    insurer: row.insurer,
    packageRef: row.packageRef,
    respondedBy: row.respondedBy,
    respondedAt: row.respondedAt
  };
}

function parseStoredOffers(data: Record<string, unknown> | unknown[], path: string): StoredOffer[] {
  if (!Array.isArray(data)) {
    throw new Error(`Offers data file ${path} must contain an array of response references.`);
  }
  const offers: StoredOffer[] = [];
  for (const row of data) {
    const offer = normalizeStoredOffer(row);
    if (!offer) throw new Error(`Offers data file ${path} must contain an array of response references.`);
    offers.push(offer);
  }
  return offers;
}

export class JsonOffersRepository implements OffersRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path = defaultOffersFile) {}

  async get(requestNo: string): Promise<StoredOffer[]> {
    const offers = parseStoredOffers(await readJson(this.path, []), this.path);
    return offers.filter((offer) => offer.requestNo === requestNo);
  }

  async add(offer: StoredOffer): Promise<{ offers: StoredOffer[]; added: boolean }> {
    return this.runExclusive(async () => {
      const current = parseStoredOffers(await readJson(this.path, []), this.path);
      const offers = current.filter((existing) => existing.requestNo === offer.requestNo);
      if (offers.length > 0) return { offers, added: false };
      const updated = [...current, {
        requestNo: offer.requestNo,
        insurer: offer.insurer,
        packageRef: offer.packageRef,
        respondedBy: offer.respondedBy,
        respondedAt: offer.respondedAt
      }];
      await writeJson(this.path, updated);
      return { offers: [...offers, offer], added: true };
    });
  }

  private runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class JsonOtpAttemptsRepository implements OtpAttemptsRepository {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path = defaultOtpAttemptsFile) {}

  async get(requestNo: string): Promise<number> {
    const data = await readJson(this.path);
    if (Array.isArray(data)) throw new Error(`OTP attempts data file ${this.path} must contain a JSON object.`);
    const attempts = data[requestNo] ?? 0;
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error(`OTP attempts data for ${requestNo} is invalid.`);
    }
    return attempts;
  }

  async increment(requestNo: string): Promise<number> {
    return this.runExclusive(async () => {
      const data = await readJson(this.path);
      if (Array.isArray(data)) throw new Error(`OTP attempts data file ${this.path} must contain a JSON object.`);
      const attempts = data[requestNo] ?? 0;
      if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) {
        throw new Error(`OTP attempts data for ${requestNo} is invalid.`);
      }
      const updatedAttempts = attempts + 1;
      data[requestNo] = updatedAttempts;
      await writeJson(this.path, data);
      return updatedAttempts;
    });
  }

  async clear(requestNo: string): Promise<void> {
    await this.runExclusive(async () => {
      const data = await readJson(this.path);
      if (Array.isArray(data)) throw new Error(`OTP attempts data file ${this.path} must contain a JSON object.`);
      delete data[requestNo];
      await writeJson(this.path, data);
    });
  }

  private runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class MemoryOffersRepository implements OffersRepository {
  private data: StoredOffer[] = [];

  async get(requestNo: string): Promise<StoredOffer[]> {
    return this.data.filter((offer) => offer.requestNo === requestNo);
  }

  async add(offer: StoredOffer): Promise<{ offers: StoredOffer[]; added: boolean }> {
    const offers = await this.get(offer.requestNo);
    if (offers.length > 0) return { offers, added: false };
    const stored = {
      requestNo: offer.requestNo,
      insurer: offer.insurer,
      packageRef: offer.packageRef,
      respondedBy: offer.respondedBy,
      respondedAt: offer.respondedAt
    };
    this.data.push(stored);
    return { offers: [...offers, stored], added: true };
  }
}

export class MemoryOtpAttemptsRepository implements OtpAttemptsRepository {
  private data = new Map<string, number>();

  async get(requestNo: string): Promise<number> {
    return this.data.get(requestNo) ?? 0;
  }

  async increment(requestNo: string): Promise<number> {
    const attempts = (this.data.get(requestNo) ?? 0) + 1;
    this.data.set(requestNo, attempts);
    return attempts;
  }

  async clear(requestNo: string): Promise<void> {
    this.data.delete(requestNo);
  }
}
