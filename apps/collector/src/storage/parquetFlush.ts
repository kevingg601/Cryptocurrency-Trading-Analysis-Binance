import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DuckDBClient } from './duckdb.ts';

export interface ParquetFlushResult {
  flushedCount: number;
  parquetDir: string;
}

export function sqlPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replaceAll("'", "''");
}

export function tradeSource(dataDir: string): string {
  const directory = path.join(dataDir, 'parquet', 'aggtrades');
  const hasParquet = (dir: string): boolean => fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true })
    .some(entry => entry.isDirectory() ? hasParquet(path.join(dir, entry.name)) : entry.name.endsWith('.parquet'));
  if (!hasParquet(directory)) return 'agg_trades';
  const glob = sqlPath(path.join(directory, '**', '*.parquet'));
  // Retries and a crash after COPY can leave the same ID in multiple tiers.
  return `(SELECT * EXCLUDE (tier) FROM (
    SELECT market, symbol, agg_id, price, qty, first_id, last_id, trade_time, recv_time, is_buyer_maker, source, 0 AS tier
      FROM read_parquet('${glob}', hive_partitioning = true)
    UNION ALL
    SELECT *, 1 AS tier FROM agg_trades
  ) QUALIFY row_number() OVER (PARTITION BY market, symbol, agg_id ORDER BY tier, recv_time) = 1)`;
}

const flushes = new WeakMap<DuckDBClient, Promise<ParquetFlushResult>>();

export function flushAggTradesToParquet(
  client: DuckDBClient,
  baseDir: string,
  olderThanMs: number = Date.now()
): Promise<ParquetFlushResult> {
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    return Promise.reject(new RangeError('Invalid Parquet cutoff'));
  }
  const previous = flushes.get(client) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => flushSnapshot(client, baseDir, olderThanMs));
  flushes.set(client, pending);
  void pending.finally(() => {
    if (flushes.get(client) === pending) flushes.delete(client);
  }).catch(() => {});
  return pending;
}

async function flushSnapshot(client: DuckDBClient, baseDir: string, olderThanMs: number): Promise<ParquetFlushResult> {
  const parquetDir = path.join(baseDir, 'parquet', 'aggtrades');
  fs.mkdirSync(parquetDir, { recursive: true });
  const snapshot = `flush_${randomUUID().replaceAll('-', '')}`;
  const stagingDir = path.resolve(baseDir, 'parquet', '.staging', snapshot);
  await client.run(`CREATE TEMP TABLE ${snapshot} AS SELECT * FROM agg_trades WHERE trade_time < ?;`, olderThanMs);
  try {
    const [row] = await client.all<{ cnt: number }>(`SELECT count(*) AS cnt FROM ${snapshot};`);
    const flushedCount = Number(row.cnt);
    if (!flushedCount) return { flushedCount, parquetDir };
    fs.mkdirSync(stagingDir, { recursive: true });
    await client.exec(`COPY (
      SELECT *, strftime(to_timestamp(trade_time / 1000), '%Y-%m-%d') AS dt FROM ${snapshot}
    ) TO '${sqlPath(stagingDir)}' (
      FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (market, dt, symbol),
      APPEND, FILENAME_PATTERN 'part_{uuid}'
    );`);
    // Publish only closed files. Readers must never glob a partially written COPY.
    const publish = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const source = path.join(directory, entry.name);
        if (entry.isDirectory()) publish(source);
        else {
          const destination = path.join(parquetDir, path.relative(stagingDir, source));
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.renameSync(source, destination);
        }
      }
    };
    publish(stagingDir);
    // Delete exported IDs only; late arrivals can share the time cutoff.
    await client.exec(`DELETE FROM agg_trades USING ${snapshot} AS exported
      WHERE agg_trades.market = exported.market AND agg_trades.symbol = exported.symbol
        AND agg_trades.agg_id = exported.agg_id;`);
    return { flushedCount, parquetDir };
  } finally {
    await client.exec(`DROP TABLE ${snapshot};`);
    // The generated staging directory must remain inside this data directory.
    if (stagingDir.startsWith(path.resolve(baseDir) + path.sep)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}
