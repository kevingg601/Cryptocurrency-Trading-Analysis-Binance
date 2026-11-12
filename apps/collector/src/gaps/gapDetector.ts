import type { DuckDBClient } from '../storage/duckdb.ts';
import type { MarketType } from '../binance/streams.ts';
import { tradeSource } from '../storage/parquetFlush.ts';

export interface DetectedGap {
  id: string;
  market: MarketType;
  symbol: string;
  dataset: 'aggtrades' | 'klines_1m';
  from_time: number;
  to_time: number;
  from_id?: number | null;
  to_id?: number | null;
  status: 'open' | 'backfilled' | 'unrecoverable';
  detected_at: number;
  resolved_at?: number | null;
}

export class GapDetector {
  private lastTradePerSymbol: Map<string, { agg_id: number; trade_time: number }> = new Map();
  private openGaps: DetectedGap[] = [];
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private checks = new Map<string, Promise<DetectedGap | null>>();
  private dataDir: string;

  private client: DuckDBClient;
  private market: MarketType;

  constructor(
    client: DuckDBClient,
    market: MarketType,
    dataDir = ':memory:'
  ) {
    this.client = client;
    this.market = market;
    this.dataDir = dataDir;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initializing ??= this.loadState().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  private async loadState(): Promise<void> {
      const rows = await this.client.all<{ symbol: string; max_id: number; max_t: number }>(
        `SELECT symbol, max(agg_id)::BIGINT as max_id, max(trade_time)::BIGINT as max_t
         FROM ${tradeSource(this.dataDir)} WHERE market = ? GROUP BY symbol;`,
        this.market
      );
      for (const r of rows) {
        if (!Number.isSafeInteger(Number(r.max_id)) || !Number.isSafeInteger(Number(r.max_t))) {
          throw new RangeError('Stored trade cursor exceeds safe integer range');
        }
        this.lastTradePerSymbol.set(r.symbol, { agg_id: Number(r.max_id), trade_time: Number(r.max_t) });
      }
    this.openGaps = await this.client.all<DetectedGap>("SELECT * FROM gaps WHERE market = ? AND status = 'open';", this.market);
    this.initialized = true;
  }

  checkAggTrade(symbol: string, aggId: number, tradeTime: number): Promise<DetectedGap | null> {
    if (
      this.initialized &&
      !this.checks.has(symbol) &&
      Number.isSafeInteger(aggId) &&
      aggId >= 0 &&
      Number.isSafeInteger(tradeTime) &&
      tradeTime >= 0
    ) {
      const last = this.lastTradePerSymbol.get(symbol);
      if (last) {
        if (aggId <= last.agg_id) return Promise.resolve(null);
        if (aggId === last.agg_id + 1) {
          this.lastTradePerSymbol.set(symbol, { agg_id: aggId, trade_time: tradeTime });
          return Promise.resolve(null);
        }
      }
    }
    const previous = this.checks.get(symbol) ?? Promise.resolve();
    const checking = previous.catch(() => {}).then(() => this.inspectTrade(symbol, aggId, tradeTime));
    this.checks.set(symbol, checking);
    void checking.finally(() => {
      if (this.checks.get(symbol) === checking) this.checks.delete(symbol);
    }).catch(() => {});
    return checking;
  }

  private async inspectTrade(symbol: string, aggId: number, tradeTime: number): Promise<DetectedGap | null> {
    if (!Number.isSafeInteger(aggId) || aggId < 0 || !Number.isSafeInteger(tradeTime) || tradeTime < 0) {
      throw new RangeError('Invalid aggregate trade ID or time');
    }
    if (!this.initialized) {
      await this.init();
    }

    const last = this.lastTradePerSymbol.get(symbol);
    if (last && aggId <= last.agg_id) return null;
    if (!last) {
      this.lastTradePerSymbol.set(symbol, { agg_id: aggId, trade_time: tradeTime });
      return null;
    }

    // Check if ID jumped
    if (aggId > last.agg_id + 1) {
      const now = Date.now();
      const gapId = `gap-${this.market}-${symbol}-${now}-${Math.random().toString(36).slice(2, 8)}`;
      const gap: DetectedGap = {
        id: gapId,
        market: this.market,
        symbol,
        dataset: 'aggtrades',
        from_time: last.trade_time,
        to_time: tradeTime,
        from_id: last.agg_id + 1,
        to_id: aggId - 1,
        status: 'open',
        detected_at: now,
      };

      await this.client.run(
        `INSERT INTO gaps (id, market, symbol, dataset, from_time, to_time, from_id, to_id, status, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        gap.id,
        gap.market,
        gap.symbol,
        gap.dataset,
        gap.from_time,
        gap.to_time,
        gap.from_id ?? null,
        gap.to_id ?? null,
        gap.status,
        gap.detected_at
      );

      this.openGaps.push(gap);
      this.lastTradePerSymbol.set(symbol, { agg_id: aggId, trade_time: tradeTime });

      return gap;
    }

    this.lastTradePerSymbol.set(symbol, { agg_id: aggId, trade_time: tradeTime });
    return null;
  }

  getOpenGaps(): DetectedGap[] {
    return [...this.openGaps];
  }

  async markResolved(gapId: string, status: 'backfilled' | 'unrecoverable') {
    const now = Date.now();
    await this.client.run(
      'UPDATE gaps SET status = ?, resolved_at = ? WHERE id = ?;',
      status,
      now,
      gapId
    );
    this.openGaps = this.openGaps.filter(g => g.id !== gapId);
  }
}
