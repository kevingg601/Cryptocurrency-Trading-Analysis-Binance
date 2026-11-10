import type { AutoEquityPoint, AutoTradingSnapshot } from './autoTrading';

const DATABASE = 'crypto-auto-trading';
const STORE = 'batches';
type StoredAutoTradingSnapshot = Omit<AutoTradingSnapshot, 'riskExtrema' | 'peakTimestamp'>
  & Partial<Pick<AutoTradingSnapshot, 'riskExtrema' | 'peakTimestamp'>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const isString = (value: unknown) => typeof value === 'string';
const isIdentifier = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const isBoolean = (value: unknown) => typeof value === 'boolean';
const isPositive = (value: unknown) => isFiniteNumber(value) && value > 0;
const isNonnegative = (value: unknown) => isFiniteNumber(value) && value >= 0;
const isSide = (value: unknown) => value === 'LONG' || value === 'SHORT';

function invalid(path: string): never {
  throw new Error(`Invalid auto-trading snapshot at ${path}; stored records were not removed`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path);
  return value;
}

function validateFields(
  record: Record<string, unknown>, path: string, fields: readonly string[],
  predicate: (value: unknown) => boolean, optional = false,
) {
  for (const key of fields) {
    if (optional && record[key] === undefined) continue;
    if (!predicate(record[key])) invalid(`${path}.${key}`);
  }
}

function validateList(
  record: Record<string, unknown>, key: string,
  validateItem: (item: Record<string, unknown>, path: string) => void,
) {
  const items = record[key];
  if (!Array.isArray(items)) invalid(`snapshot.${key}`);
  for (let index = 0; index < items.length; index++) {
    const path = `snapshot.${key}[${index}]`;
    validateItem(requireRecord(items[index], path), path);
  }
}

function validatePlan(plan: Record<string, unknown>, path: string, market: unknown) {
  validateFields(plan, path, ['id', 'alertId', 'symbol'], isIdentifier);
  if (plan.marketType !== market) invalid(`${path}.marketType`);
  validateFields(plan, path, ['side'], isSide);
  if (!['WAIT_PULLBACK', 'WAIT_CONFIRMATION', 'CONFIRMED', 'TP1', 'TP2', 'STOPPED', 'INVALID', 'MISSED', 'EXPIRED'].includes(plan.state as string)) {
    invalid(`${path}.state`);
  }
  validateFields(plan, path, ['referencePrice', 'triggerPrice', 'impulse', 'observationPrice', 'zoneLow', 'zoneHigh',
    'stopLoss', 'takeProfit1', 'takeProfit2', 'currentPrice'], isPositive);
  validateFields(plan, path, ['triggerTimestamp', 'createdAt', 'expiresAt'], isNonnegative);
  validateFields(plan, path, ['confirmedEntry', 'extreme'], isPositive, true);
  validateFields(plan, path, ['confirmedAt', 'confirmationSince', 'confirmationReceivedSince',
    'lastTradeTimestamp', 'lastTradeId', 'lastReceivedAt'], isNonnegative, true);
  validateFields(plan, path, ['stale'], isBoolean);
  validateFields(plan, path, ['reason'], isString, true);
}

function validateEquityPoint(point: Record<string, unknown>, path: string) {
  validateFields(point, path, ['timestamp'], isNonnegative);
  validateFields(point, path, ['value'], isFiniteNumber);
}

function validateSnapshot(value: unknown): asserts value is StoredAutoTradingSnapshot {
  const record = requireRecord(value, 'snapshot');
  if (record.schemaVersion !== 1) invalid('snapshot.schemaVersion');
  if (record.strategyVersion !== 'conservative-follow-v1') invalid('snapshot.strategyVersion');
  validateFields(record, 'snapshot', ['id'], isIdentifier);
  if (record.marketType !== 'spot' && record.marketType !== 'futures') invalid('snapshot.marketType');
  if (!['IDLE', 'RUNNING', 'PAUSED', 'DRAINING', 'COMPLETED', 'INTERRUPTED'].includes(record.status as string)) invalid('snapshot.status');
  if (!['NOT_REQUIRED', 'PENDING', 'SETTLED', 'ERROR'].includes(record.fundingStatus as string)) invalid('snapshot.fundingStatus');
  const config = requireRecord(record.config, 'snapshot.config');
  if (config.marketType !== record.marketType) invalid('snapshot.config.marketType');
  validateFields(config, 'snapshot.config', ['initialCapital', 'riskPct', 'maxNotionalPct'], isPositive);
  validateFields(config, 'snapshot.config', ['feeBps', 'slippageBps', 'latencyMs'], isNonnegative);
  validateFields(config, 'snapshot.config', ['maxPositions'], value => isPositive(value) && Number.isInteger(value));
  validateFields(record, 'snapshot', ['startedAt', 'maxDrawdownPct'], isNonnegative);
  validateFields(record, 'snapshot', ['endedAt', 'fundingThrough', 'peakTimestamp'], isNonnegative, true);
  validateFields(record, 'snapshot', ['cash', 'lastEquity'], isFiniteNumber);
  validateFields(record, 'snapshot', ['equityPeak'], isPositive);
  validateFields(record, 'snapshot', ['reason'], isString, true);
  if (record.signalSettings !== undefined) {
    const settings = requireRecord(record.signalSettings, 'snapshot.signalSettings');
    validateFields(settings, 'snapshot.signalSettings', Object.keys(settings), isFiniteNumber);
  }

  validateList(record, 'plans', (plan, path) => validatePlan(plan, path, record.marketType));
  validateList(record, 'positions', (position, path) => {
    validateFields(position, path, ['id', 'planId', 'symbol'], isIdentifier);
    validateFields(position, path, ['side'], isSide);
    validateFields(position, path, ['entryPrice', 'quantity', 'stopLoss', 'takeProfit1', 'takeProfit2', 'currentPrice'], isPositive);
    validateFields(position, path, ['remainingQuantity', 'entryFee', 'exitNotional', 'exitFees', 'openedAt', 'lastReceivedAt'], isNonnegative);
    if ((position.remainingQuantity as number) > (position.quantity as number)) invalid(`${path}.remainingQuantity`);
    validateFields(position, path, ['realizedPnl', 'funding'], isFiniteNumber);
    validateFields(position, path, ['tp1Hit'], isBoolean);
    validateFields(position, path, ['incomplete'], isBoolean, true);
  });
  validateList(record, 'orders', (order, path) => {
    validateFields(order, path, ['id', 'planId', 'symbol'], isIdentifier);
    validateFields(order, path, ['side'], isSide);
    if (order.kind !== 'ENTRY' && order.kind !== 'EXIT') invalid(`${path}.kind`);
    validateFields(order, path, ['reason'], isString);
    validateFields(order, path, ['createdAt', 'eligibleAt', 'signalTimestamp'], isNonnegative);
    // Pending exits intentionally have no expiry; no other field accepts Infinity.
    if (!(order.kind === 'EXIT' && order.expiresAt === Infinity) && !isNonnegative(order.expiresAt)) invalid(`${path}.expiresAt`);
    validateFields(order, path, ['signalTradeId'], isNonnegative, true);
    validateFields(order, path, ['quantity'], isPositive, order.kind !== 'EXIT');
    validateFields(order, path, ['positionId'], isIdentifier, order.kind !== 'EXIT');
    if (order.kind === 'ENTRY' || order.plan !== undefined) {
      validatePlan(requireRecord(order.plan, `${path}.plan`), `${path}.plan`, record.marketType);
    }
  });
  validateList(record, 'fills', (fill, path) => {
    validateFields(fill, path, ['id', 'positionId', 'symbol'], isIdentifier);
    validateFields(fill, path, ['side'], isSide);
    if (fill.action !== 'ENTRY' && fill.action !== 'EXIT') invalid(`${path}.action`);
    validateFields(fill, path, ['reason'], isString);
    validateFields(fill, path, ['price', 'quantity'], isPositive);
    validateFields(fill, path, ['fee', 'timestamp', 'tradeTimestamp'], isNonnegative);
    validateFields(fill, path, ['grossPnl'], isFiniteNumber);
    validateFields(fill, path, ['tradeId'], isNonnegative, true);
  });
  validateList(record, 'trades', (trade, path) => {
    validateFields(trade, path, ['id', 'planId', 'symbol'], isIdentifier);
    validateFields(trade, path, ['side'], isSide);
    validateFields(trade, path, ['reason'], isString);
    validateFields(trade, path, ['entryPrice', 'exitPrice', 'quantity'], isPositive);
    validateFields(trade, path, ['fees', 'openedAt', 'closedAt'], isNonnegative);
    validateFields(trade, path, ['grossPnl', 'funding', 'netPnl'], isFiniteNumber);
    validateFields(trade, path, ['incomplete'], isBoolean, true);
  });
  validateList(record, 'events', (event, path) => {
    validateFields(event, path, ['id', 'type'], isIdentifier);
    validateFields(event, path, ['message'], isString);
    validateFields(event, path, ['symbol'], isIdentifier, true);
    validateFields(event, path, ['timestamp'], isNonnegative);
  });
  validateList(record, 'equity', validateEquityPoint);
  if (record.riskExtrema !== undefined) validateList(record, 'riskExtrema', validateEquityPoint);
  validateList(record, 'fundingCharges', (charge, path) => {
    validateFields(charge, path, ['id', 'positionId', 'symbol'], isIdentifier);
    validateFields(charge, path, ['timestamp'], isNonnegative);
    validateFields(charge, path, ['amount'], isFiniteNumber);
  });
}

function normalizeSnapshot(value: unknown): AutoTradingSnapshot {
  validateSnapshot(value);
  // Development v1 batches predate extrema tracking; use recorded samples only.
  const observedPeak = value.equity.reduce<AutoEquityPoint | undefined>(
    (peak, point) => !peak || point.value > peak.value ? point : peak, undefined,
  );
  return {
    ...value,
    riskExtrema: value.riskExtrema ?? structuredClone(value.equity),
    peakTimestamp: value.peakTimestamp ?? observedPeak?.timestamp ?? value.startedAt,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable; auto-trading batches cannot be persisted'));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => {
      if (failed) {
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open auto-trading storage'));
    request.onblocked = () => {
      failed = true;
      reject(new Error('Auto-trading storage is blocked by another open database connection'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        reject(new Error('Invalid auto-trading storage: batches object store is missing'));
        return;
      }
      resolve(db);
    };
  });
}

export async function loadAutoTradingBatches(): Promise<AutoTradingSnapshot[]> {
  const db = await openDatabase();
  try {
    return await new Promise<AutoTradingSnapshot[]>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).getAll();
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Failed to load auto-trading batches'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Loading auto-trading batches was aborted'));
      transaction.oncomplete = () => {
        try {
          const batches: unknown[] = request.result;
          resolve(batches.map(normalizeSnapshot).sort((a, b) => b.startedAt - a.startedAt));
        } catch (error) {
          reject(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

export async function saveAutoTradingBatch(snapshot: AutoTradingSnapshot): Promise<void> {
  const batch = normalizeSnapshot(structuredClone(snapshot));
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Failed to save auto-trading batch'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving auto-trading batch was aborted'));
      transaction.objectStore(STORE).put(batch);
    });
  } finally {
    db.close();
  }
}
