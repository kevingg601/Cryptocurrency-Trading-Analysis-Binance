import duckdb from 'duckdb';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeIntegers } from './duckdb.ts';

export interface NativeDuckDBClient {
  all<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  run(sql: string, ...params: any[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  db: duckdb.Database;
  conn: duckdb.Connection;
}

export function createNativeDuckDBClient(dbPath: string = ':memory:'): Promise<NativeDuckDBClient> {
  return new Promise((resolve, reject) => {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const db = new duckdb.Database(dbPath, (err) => {
      if (err) return reject(err);

      const conn = db.connect();
      let closing: Promise<void> | undefined;

      const client: NativeDuckDBClient = {
        db,
        conn,
        all<T = any>(sql: string, ...params: any[]): Promise<T[]> {
          const sanitized = params.map(p => typeof p === 'bigint' ? p.toString() : p);
          return new Promise((res, rej) => {
            const statement = conn.prepare(sql);
            statement.all(...sanitized, (err, rows) => {
              statement.finalize((finalizeError) => {
                if (err || finalizeError) return rej(err || finalizeError);
                res(normalizeIntegers(rows) as T[]);
              });
            });
          });
        },
        run(sql: string, ...params: any[]): Promise<void> {
          const sanitized = params.map(p => typeof p === 'bigint' ? p.toString() : p);
          return new Promise((res, rej) => {
            const statement = conn.prepare(sql);
            statement.run(...sanitized, (err) => {
              statement.finalize((finalizeError) => {
                if (err || finalizeError) return rej(err || finalizeError);
                res();
              });
            });
          });
        },
        exec(sql: string): Promise<void> {
          return new Promise((res, rej) => {
            conn.exec(sql, (err) => {
              if (err) return rej(err);
              res();
            });
          });
        },
        close(): Promise<void> {
          closing ??= new Promise((res, rej) => {
            conn.close((connectionError) => {
              db.close((err) => {
                if (connectionError || err) return rej(connectionError || err);
                res();
              });
            });
          });
          return closing;
        },
      };

      resolve(client);
    });
  });
}

