import { randomUUID } from 'node:crypto';
import type { DuckDBClient } from '../storage/duckdb.ts';

export const AB_SERVICE_GENERATION = randomUUID();
export type ABLease = { batchId: string; ownerToken: string; generation: string; expiresAt: number };
export type ABClaim = { owner: true; lease: ABLease } | { owner: false; expiresAt: number };

export async function ensureABOwnership(connection: DuckDBClient): Promise<void> {
  await connection.exec(`
    CREATE TABLE IF NOT EXISTS ab_ownership_meta (
      key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ab_batch_leases (
      batch_id VARCHAR PRIMARY KEY, owner_token VARCHAR NOT NULL,
      generation VARCHAR NOT NULL, expires_at BIGINT NOT NULL
    );
  `);
}

export async function activateABOwnershipGeneration(connection: DuckDBClient, generation: string): Promise<void> {
  await ensureABOwnership(connection);
  await connection.run(
    `INSERT INTO ab_ownership_meta (key, value) VALUES ('service_generation', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value;`, generation
  );
}

export async function isABGenerationCurrent(connection: DuckDBClient, generation: string): Promise<boolean> {
  const rows = await connection.all("SELECT value FROM ab_ownership_meta WHERE key = 'service_generation';");
  return Boolean(rows.length && rows[0].value === generation);
}

export async function getABLease(connection: DuckDBClient, batchId: string): Promise<ABLease | null> {
  const rows = await connection.all('SELECT batch_id, owner_token, generation, expires_at FROM ab_batch_leases WHERE batch_id = ?;', batchId);
  if (!rows.length) return null;
  return { batchId: rows[0].batch_id, ownerToken: rows[0].owner_token, generation: rows[0].generation, expiresAt: Number(rows[0].expires_at) };
}

export async function claimABLease(connection: DuckDBClient, batchId: string, generation: string, now: number): Promise<ABClaim> {
  if (!await isABGenerationCurrent(connection, generation)) throw new Error('Collector generation was superseded');
  const existing = await getABLease(connection, batchId);
  if (existing && existing.generation === generation && existing.expiresAt > now) {
    return { owner: false, expiresAt: existing.expiresAt };
  }
  const lease = { batchId, ownerToken: randomUUID(), generation, expiresAt: now + 15_000 };
  await connection.run(
    `INSERT INTO ab_batch_leases (batch_id, owner_token, generation, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (batch_id) DO UPDATE SET owner_token = excluded.owner_token,
       generation = excluded.generation, expires_at = excluded.expires_at;`,
    lease.batchId, lease.ownerToken, lease.generation, lease.expiresAt
  );
  return { owner: true, lease };
}

export async function renewABLease(connection: DuckDBClient, batchId: string, ownerToken: string, generation: string, now: number): Promise<boolean> {
  if (!await isABGenerationCurrent(connection, generation)) return false;
  const rows = await connection.all(
    `SELECT owner_token, generation, expires_at FROM ab_batch_leases WHERE batch_id = ?;`, batchId
  );
  if (!rows.length || rows[0].owner_token !== ownerToken || rows[0].generation !== generation
    || Number(rows[0].expires_at) <= now) return false;
  await connection.run('UPDATE ab_batch_leases SET expires_at = ? WHERE batch_id = ?;', now + 15_000, batchId);
  return true;
}

export async function ownsABLease(connection: DuckDBClient, batchId: string, ownerToken: string, generation: string, now: number): Promise<boolean> {
  if (!await isABGenerationCurrent(connection, generation)) return false;
  const rows = await connection.all(
    `SELECT owner_token, generation, expires_at FROM ab_batch_leases WHERE batch_id = ?;`, batchId
  );
  return Boolean(rows.length && rows[0].owner_token === ownerToken && rows[0].generation === generation
    && Number(rows[0].expires_at) > now);
}
