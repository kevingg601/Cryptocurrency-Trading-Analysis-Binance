import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';

export interface DuckDBClient {
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  run(sql: string, ...params: any[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function normalizeIntegers(value: any): any {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (Array.isArray(value)) return value.map(normalizeIntegers);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeIntegers(item)]));
  }
  return value;
}

export function createDuckDBClient(dbPath = ':memory:'): Promise<DuckDBClient> {
  // The legacy native binding keeps prepared contexts until GC, even after
  // finalize/close. Terminating a dedicated worker releases Windows file locks
  // deterministically without exposing GC or changing third-party code.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './duckdbWorker.ts' : './duckdbWorker.js', import.meta.url), { workerData: dbPath });
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let sequence = 0;
    let closing: Promise<void> | undefined;
    let stopped: Error | undefined;
    const fail = (error: Error) => {
      stopped = error;
      reject(error);
      for (const job of pending.values()) job.reject(error);
      pending.clear();
    };
    const request = (method: string, sql?: string, params: any[] = []): Promise<any> => {
      if (stopped) return Promise.reject(stopped);
      const id = ++sequence;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        try { worker.postMessage({ id, method, sql, params }); }
        catch (error) { pending.delete(id); rej(error); }
      });
    };
    const client: DuckDBClient = {
      all: (sql, ...params) => closing ? Promise.reject(new Error('DuckDB client is closing')) : request('all', sql, params),
      run: (sql, ...params) => closing ? Promise.reject(new Error('DuckDB client is closing')) : request('run', sql, params),
      exec: sql => closing ? Promise.reject(new Error('DuckDB client is closing')) : request('exec', sql),
      close() {
        closing ??= request('close').finally(async () => { await worker.terminate(); });
        return closing;
      },
    };
    worker.on('message', (message) => {
      if (message.ready) { resolve(client); return; }
      if (message.startupError) { fail(new Error(message.startupError)); void worker.terminate(); return; }
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.value);
    });
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`DuckDB worker exited (${code})`)));
  });
}

export async function initDatabase(client: DuckDBClient, schemaPath?: string): Promise<void> {
  await client.exec(fs.readFileSync(schemaPath ?? path.join(import.meta.dirname, 'schema.sql'), 'utf-8'));
}
