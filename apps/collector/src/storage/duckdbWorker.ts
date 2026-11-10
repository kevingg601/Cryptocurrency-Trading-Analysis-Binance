import { parentPort, workerData } from 'node:worker_threads';
import { createNativeDuckDBClient } from './duckdbNative.ts';

try {
  const client = await createNativeDuckDBClient(workerData);
  // Serialize whole operations (including statement finalizers) before close.
  let operations = Promise.resolve();
  parentPort!.on('message', ({ id, method, sql, params }) => {
    operations = operations.then(async () => {
      try {
        let value: unknown;
        if (method === 'close') value = await client.close();
        else if (method === 'all') value = await client.all(sql, ...params);
        else if (method === 'run') value = await client.run(sql, ...params);
        else if (method === 'exec') value = await client.exec(sql);
        else throw new Error('Unknown database operation');
        parentPort!.postMessage({ id, value });
      } catch (error) {
        parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  parentPort!.postMessage({ ready: true });
} catch (error) {
  parentPort!.postMessage({ startupError: error instanceof Error ? error.message : String(error) });
}
