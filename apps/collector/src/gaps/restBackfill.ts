import type { DetectedGap, GapDetector } from './gapDetector.ts';
import type { StorageWriter } from '../storage/writer.ts';
import { fetchHistoricalAggTrades, fetchHistoricalKlines } from '../binance/rest.ts';

const active = new WeakMap<StorageWriter, Map<string, Promise<boolean>>>();

export function backfillGap(gap: DetectedGap, writer: StorageWriter, detector: GapDetector, signal?: AbortSignal): Promise<boolean> {
  if (gap.status === 'backfilled') return Promise.resolve(true);
  let jobs = active.get(writer);
  if (!jobs) { jobs = new Map(); active.set(writer, jobs); }
  const existing = jobs.get(gap.id);
  if (existing) return existing;
  const job = fill(gap, writer, detector, signal).finally(() => jobs.delete(gap.id));
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
        const trades = await fetchHistoricalAggTrades(gap.market, gap.symbol, next, undefined, undefined, Math.min(1000, end - next + 1), signal);
        if (!Array.isArray(trades) || !trades.length) return false;
        const before = next;
        for (const t of trades) {
          const id = Number(t.a);
          if (id < next || id > end) continue;
          if (id !== next || !Number.isSafeInteger(id) || !Number.isSafeInteger(Number(t.T)) || !(Number(t.p) > 0) || !(Number(t.q) > 0)
              || !Number.isFinite(Number(t.p)) || !Number.isFinite(Number(t.q))) return false;
          writer.pushAggTrade({
            market: gap.market, symbol: gap.symbol, agg_id: id,
            price: Number(t.p), qty: Number(t.q), first_id: t.f, last_id: t.l,
            trade_time: Number(t.T), recv_time: Date.now(), is_buyer_maker: Boolean(t.m), source: 'rest',
          });
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
        const klines = await fetchHistoricalKlines(gap.market, gap.symbol, '1m', next, end, 1000, signal);
        if (!Array.isArray(klines) || !klines.length) return false;
        const before = next;
        for (const k of klines) {
          if (Number(k[0]) < next || Number(k[0]) > end) continue;
          if (Number(k[0]) !== next) return false;
          writer.pushKline({
            market: gap.market, symbol: gap.symbol, open_time: next,
            open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
            volume: Number(k[5]), quote_volume: Number(k[7]), trades: k[8],
            taker_buy_base: Number(k[9]), taker_buy_quote: Number(k[10]), is_final: true, source: 'rest',
          });
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
