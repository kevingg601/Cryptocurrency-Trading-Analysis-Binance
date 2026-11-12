import type { DuckDBClient } from './duckdb.ts';

export interface StoredAggTrade {
  market: 'spot' | 'futures';
  symbol: string;
  agg_id: number;
  price: number;
  qty: number;
  first_id?: number | null;
  last_id?: number | null;
  trade_time: number;
  recv_time: number;
  is_buyer_maker: boolean;
  source: 'ws' | 'rest' | 'vision';
}

export interface StoredKline1m {
  market: 'spot' | 'futures';
  symbol: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  trades?: number | null;
  taker_buy_base?: number | null;
  taker_buy_quote?: number | null;
  is_final: boolean;
  source: 'ws' | 'rest' | 'vision';
}

export interface WriterStats {
  queueDepthTrades: number;
  queueDepthKlines: number;
  totalTradesWritten: number;
  totalKlinesWritten: number;
  writeRatePerSec: number;
  queueOverflows: number;
}

const MAX_QUEUED_ITEMS = 50_000;

export class StorageWriter {
  private tradeQueue: StoredAggTrade[] = [];
  private klineQueue: StoredKline1m[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private activeFlush: Promise<{ tradesWritten: number; klinesWritten: number }> | null = null;
  private totalTradesWritten = 0;
  private totalKlinesWritten = 0;
  private tradesWrittenInWindow = 0;
  private lastRateCheck = Date.now();
  private currentRate = 0;
  private queueOverflows = 0;
  private overflowed = false;
  private onOverflow: ((kind: 'trades' | 'klines', depth: number) => void) | null = null;

  private client: DuckDBClient;
  private maxBatchSize: number;
  private flushIntervalMs: number;

  constructor(
    client: DuckDBClient,
    maxBatchSize = 5000,
    flushIntervalMs = 1000
  ) {
    this.client = client;
    this.maxBatchSize = maxBatchSize;
    this.flushIntervalMs = flushIntervalMs;
  }

  setOverflowHandler(handler: (kind: 'trades' | 'klines', depth: number) => void): void {
    this.onOverflow = handler;
  }

  isOverflowed(): boolean {
    return this.overflowed;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => console.error('Auto flush error:', err));
      const now = Date.now();
      const elapsed = (now - this.lastRateCheck) / 1000;
      if (elapsed >= 1) {
        this.currentRate = this.tradesWrittenInWindow / elapsed;
        this.tradesWrittenInWindow = 0;
        this.lastRateCheck = now;
      }
    }, this.flushIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Drain both the in-flight batch and trades queued while it was writing.
    do {
      await this.flush();
    } while (this.tradeQueue.length || this.klineQueue.length);
  }

  pushAggTrade(trade: StoredAggTrade): boolean {
    if (this.overflowed || this.tradeQueue.length >= MAX_QUEUED_ITEMS) {
      this.signalOverflow('trades', this.tradeQueue.length);
      return false;
    }
    this.tradeQueue.push(trade);
    if (this.tradeQueue.length >= this.maxBatchSize && !this.isFlushing) {
      this.flush().catch((err) => console.error('Batch size flush error:', err));
    }
    return true;
  }

  pushKline(kline: StoredKline1m): boolean {
    if (this.overflowed || this.klineQueue.length >= MAX_QUEUED_ITEMS) {
      this.signalOverflow('klines', this.klineQueue.length);
      return false;
    }
    this.klineQueue.push(kline);
    if (this.klineQueue.length >= this.maxBatchSize && !this.isFlushing) {
      this.flush().catch((err) => console.error('Batch size flush error:', err));
    }
    return true;
  }

  private signalOverflow(kind: 'trades' | 'klines', depth: number): void {
    if (this.overflowed) return;
    this.overflowed = true;
    this.queueOverflows += 1;
    const message = `[Collector] Storage ${kind} queue exceeded ${MAX_QUEUED_ITEMS} items; stopping ingestion for recovery`;
    console.error(message);
    if (this.onOverflow) this.onOverflow(kind, depth);
    else throw new Error(message);
  }

  flush(): Promise<{ tradesWritten: number; klinesWritten: number }> {
    if (this.activeFlush) return this.activeFlush;
    this.activeFlush = (async () => {
      const total = { tradesWritten: 0, klinesWritten: 0 };
      do {
        const batch = await this.flushBatch();
        total.tradesWritten += batch.tradesWritten;
        total.klinesWritten += batch.klinesWritten;
      } while (this.tradeQueue.length > 0 || this.klineQueue.length > 0);
      return total;
    })().finally(() => { this.activeFlush = null; });
    return this.activeFlush;
  }

  private async flushBatch(): Promise<{ tradesWritten: number; klinesWritten: number }> {
    this.isFlushing = true;

    const tradesToFlush = this.tradeQueue;
    this.tradeQueue = [];

    const klinesToFlush = this.klineQueue;
    this.klineQueue = [];

    let tradesWritten = 0;
    let klinesWritten = 0;

    try {
      if (tradesToFlush.length > 0) {
        tradesWritten = await this.insertAggTrades(tradesToFlush);
        this.totalTradesWritten += tradesWritten;
        this.tradesWrittenInWindow += tradesWritten;
        tradesToFlush.length = 0;
      }

      if (klinesToFlush.length > 0) {
        klinesWritten = await this.insertKlines(klinesToFlush);
        this.totalKlinesWritten += klinesWritten;
      }
    } catch (err) {
      // Re-queue on failure so data isn't lost
      this.tradeQueue = tradesToFlush.concat(this.tradeQueue);
      this.klineQueue = klinesToFlush.concat(this.klineQueue);
      throw err;
    } finally {
      this.isFlushing = false;
    }

    return { tradesWritten, klinesWritten };
  }

  private async insertAggTrades(batch: StoredAggTrade[]): Promise<number> {
    const CHUNK_SIZE = 1000;
    let written = 0;

    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      const placeholders: string[] = [];
      const values: any[] = [];

      for (const t of chunk) {
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        values.push(
          t.market,
          t.symbol,
          t.agg_id,
          t.price,
          t.qty,
          t.first_id ?? null,
          t.last_id ?? null,
          t.trade_time,
          t.recv_time,
          t.is_buyer_maker,
          t.source
        );
      }

      const sql = `INSERT INTO agg_trades (market, symbol, agg_id, price, qty, first_id, last_id, trade_time, recv_time, is_buyer_maker, source)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT DO NOTHING RETURNING agg_id;`;

      const inserted = await this.client.all(sql, ...values);
      written += inserted.length;
    }

    return written;
  }

  private async insertKlines(batch: StoredKline1m[]): Promise<number> {
    const CHUNK_SIZE = 1000;
    let written = 0;

    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      const placeholders: string[] = [];
      const values: any[] = [];

      for (const k of chunk) {
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        values.push(
          k.market,
          k.symbol,
          k.open_time,
          k.open,
          k.high,
          k.low,
          k.close,
          k.volume,
          k.quote_volume,
          k.trades ?? null,
          k.taker_buy_base ?? null,
          k.taker_buy_quote ?? null,
          k.is_final,
          k.source
        );
      }

      const sql = `INSERT INTO klines_1m (market, symbol, open_time, open, high, low, close, volume, quote_volume, trades, taker_buy_base, taker_buy_quote, is_final, source)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (market, symbol, open_time) DO UPDATE SET
          high = GREATEST(klines_1m.high, excluded.high),
          low = LEAST(klines_1m.low, excluded.low),
          close = excluded.close,
          volume = excluded.volume,
          quote_volume = excluded.quote_volume,
          trades = excluded.trades,
          taker_buy_base = excluded.taker_buy_base,
          taker_buy_quote = excluded.taker_buy_quote,
          is_final = excluded.is_final,
          source = excluded.source
        WHERE NOT klines_1m.is_final
          AND (excluded.is_final OR excluded.volume >= klines_1m.volume);`;

      await this.client.run(sql, ...values);
      written += chunk.length;
    }

    return written;
  }

  getStats(): WriterStats {
    return {
      queueDepthTrades: this.tradeQueue.length,
      queueDepthKlines: this.klineQueue.length,
      totalTradesWritten: this.totalTradesWritten,
      totalKlinesWritten: this.totalKlinesWritten,
      writeRatePerSec: Math.round(this.currentRate),
      queueOverflows: this.queueOverflows,
    };
  }
}
