import type { DuckDBClient } from '../storage/duckdb.ts';

type Transaction = <T>(work: (connection: DuckDBClient) => Promise<T>) => Promise<T>;
const transactions = new WeakMap<DuckDBClient, Transaction>();

/** Reserve the shared connection for the whole transaction, including rollback.
 * All existing holders use the same client, so writer/AI/API operations cannot
 * accidentally enter this transaction or observe a partially saved pair.
 */
export function abStorageTransaction(client: DuckDBClient): Transaction {
  const existing = transactions.get(client);
  if (existing) return existing;
  const connection: DuckDBClient = {
    all: client.all.bind(client), run: client.run.bind(client),
    exec: client.exec.bind(client), close: client.close.bind(client),
  };
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const job = queue.then(work);
    queue = job.catch(() => {});
    return job;
  };
  client.all = (sql, ...params) => enqueue(() => connection.all(sql, ...params));
  client.run = (sql, ...params) => enqueue(() => connection.run(sql, ...params));
  client.exec = sql => enqueue(() => connection.exec(sql));
  client.close = () => enqueue(() => connection.close());
  const transaction: Transaction = work => enqueue(async () => {
    await connection.exec('BEGIN TRANSACTION;');
    try {
      const result = await work(connection);
      await connection.exec('COMMIT;');
      return result;
    } catch (error) {
      await connection.exec('ROLLBACK;');
      throw error;
    }
  });
  transactions.set(client, transaction);
  return transaction;
}
