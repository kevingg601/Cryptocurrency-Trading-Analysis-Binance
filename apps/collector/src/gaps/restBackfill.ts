import type { DetectedGap, GapDetector } from './gapDetector.ts';
import type { StorageWriter } from '../storage/writer.ts';
import { fetchHistoricalAggTrades, fetchHistoricalKlines } from '../binance/rest.ts';

const MAX_CONCURRENT_BACKFILLS = 2;
const BACKFILL_HIGH_WATER_MARK = 15_000;

interface LimiterState {
  running: number;
  waiters: Array<() => void>;
}

const active = new WeakMap<StorageWriter, Map<string, Promise<boolean>>>();
const limiters = new WeakMap<StorageWriter, LimiterState>();

function getLimiter(writer: StorageWriter): LimiterState {
  let state = limiters.get(writer);
  if (!state) {
    state = { running: 0, waiters: [] };
    limiters.set(writer, state);
  }
  return state;
}

function releaseSlot(state: LimiterState): void {
  const next = state.waiters.shift();
  if (next) {
    next();
  } else {
    state.running = Math.max(0, state.running - 1);
  }
}

function acquireSlot(state: LimiterState, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (state.running < MAX_CONCURRENT_BACKFILLS) {
    state.running += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const idx = state.waiters.indexOf(grant);
      if (idx >= 0) state.waiters.splice(idx, 1);
      resolve(false);
    };
    const grant = () => {
      if (settled) {
        releaseSlot(state);
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    state.waiters.push(grant);
  });
}

function getQueuedDepth(writer: StorageWriter): number {
  const stats = typeof writer.getStats === 'function' ? writer.getStats() : null;
  return stats ? stats.queueDepthTrades + stats.queueDepthKlines : 0;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForWriterHeadroom(
  writer: StorageWriter,
  highWaterMark: number,
  signal?: AbortSignal,
): Promise<boolean> {
  while (getQueuedDepth(writer) >= highWaterMark) {
    if (signal?.aborted) return false;
    if (typeof writer.isOverflowed === 'function' && writer.isOverflowed()) return false;
    await writer.flush();
    if (getQueuedDepth(writer) < highWaterMark) break;
    await abortableDelay(50, signal);
  }
  return !signal?.aborted && !(typeof writer.isOverflowed === 'function' && writer.isOverflowed());
}

export function backfillGap(gap: DetectedGap, writer: StorageWriter, detector: GapDetector, signal?: AbortSignal): Promise<boolean> {
  if (gap.status === 'backfilled') return Promise.resolve(true);
  let jobs = active.get(writer);
  if (!jobs) { jobs = new Map(); active.set(writer, jobs); }
  const existing = jobs.get(gap.id);
  if (existing) return existing;
  const limiter = getLimiter(writer);
  const job = (async () => {
    const acquired = await acquireSlot(limiter, signal);
    if (!acquired) return false;
    try {
      return await fill(gap, writer, detector, signal);
    } finally {
      releaseSlot(limiter);
    }
  })().finally(() => jobs.delete(gap.id));
  jobs.set(gap.id, job);
  return job;
}

async function fill(gap: DetectedGap, writer: StorageWriter, detector: GapDetector, signal?: AbortSignal): Promise<boolean> {
  try {
    if (gap.dataset === 'aggtrades') {
      let next = Number(gap.from_id);
      const end = Number(gap.to_id);
      if (gap.from_id == null || gap.to_id == null || !Number.isSafeInteger(next) || !Number.isSafeInteger(end) || next < 0 || next > end) return false;
      while (next <= end) {
        signal?.throwIfAborted();
        if (!(await waitForWriterHeadroom(writer, BACKFILL_HIGH_WATER_MARK, signal))) return false;
        const trades = await fetchHistoricalAggTrades(gap.market, gap.symbol, next, undefined, undefined, Math.min(1000, end - next + 1), signal);
        if (!Array.isArray(trades) || !trades.length) return false;
        if (!(await waitForWriterHeadroom(writer, BACKFILL_HIGH_WATER_MARK, signal))) return false;
        const before = next;
        for (const t of trades) {
          const id = Number(t.a);
          if (id < next || id > end) continue;
          if (id !== next || !Number.isSafeInteger(id) || !Number.isSafeInteger(Number(t.T)) || !(Number(t.p) > 0) || !(Number(t.q) > 0)
              || !Number.isFinite(Number(t.p)) || !Number.isFinite(Number(t.q))) return false;
          if (!writer.pushAggTrade({
            market: gap.market, symbol: gap.symbol, agg_id: id,
            price: Number(t.p), qty: Number(t.q), first_id: t.f, last_id: t.l,
            trade_time: Number(t.T), recv_time: Date.now(), is_buyer_maker: Boolean(t.m), source: 'rest',
          })) return false;
          next++;
        }
        await writer.flush();
        if (next === before) return false;
      }
    } else if (gap.dataset === 'klines_1m') {
      let next = Math.ceil(Number(gap.from_time) / 60000) * 60000;
      const end = Number(gap.to_time);
      if (!Number.isSafeInteger(next) || !Number.isSafeInteger(end) || next > end) return false;
      while (next <= end) {
        signal?.throwIfAborted();
        if (!(await waitForWriterHeadroom(writer, BACKFILL_HIGH_WATER_MARK, signal))) return false;
        const klines = await fetchHistoricalKlines(gap.market, gap.symbol, '1m', next, end, 1000, signal);
        if (!Array.isArray(klines) || !klines.length) return false;
        if (!(await waitForWriterHeadroom(writer, BACKFILL_HIGH_WATER_MARK, signal))) return false;
        const before = next;
        for (const k of klines) {
          if (Number(k[0]) < next || Number(k[0]) > end) continue;
          if (Number(k[0]) !== next) return false;
          if (!writer.pushKline({
            market: gap.market, symbol: gap.symbol, open_time: next,
            open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
            volume: Number(k[5]), quote_volume: Number(k[7]), trades: k[8],
            taker_buy_base: Number(k[9]), taker_buy_quote: Number(k[10]), is_final: true, source: 'rest',
          })) return false;
          next += 60000;
        }
        await writer.flush();
        if (next === before) return false;
      }
    } else return false;
    signal?.throwIfAborted();
    await detector.markResolved(gap.id, 'backfilled');
    return true;
  } catch (err) {
    console.warn(`Failed to backfill gap ${gap.id}:`, err);
    // Timeouts, rate limits and partial pages do not prove unrecoverability.
    return false;
  }
}
