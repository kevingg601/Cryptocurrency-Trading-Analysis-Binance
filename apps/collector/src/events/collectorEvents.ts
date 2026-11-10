import type { DuckDBClient } from '../storage/duckdb.ts';
import type { MarketType } from '../binance/streams.ts';
import { MarketAlertDetector, DEFAULT_MARKET_ALERT_SETTINGS } from '@fadachi/core';
import type { MarketAlert } from '@fadachi/core';
import { FollowPlanTracker } from '@fadachi/core';
import type { AggregateTradeData } from '@fadachi/core';

export class CollectorEventsManager {
  private detector: MarketAlertDetector;
  private tracker: FollowPlanTracker;

  private client: DuckDBClient;
  private market: MarketType;
  private onAlert?: (alert: MarketAlert) => void;

  constructor(
    client: DuckDBClient,
    market: MarketType,
    onAlert?: (alert: MarketAlert) => void
  ) {
    this.client = client;
    this.market = market;
    this.onAlert = onAlert;
    this.detector = new MarketAlertDetector(DEFAULT_MARKET_ALERT_SETTINGS);
    this.tracker = new FollowPlanTracker();
  }

  async processTrade(trade: AggregateTradeData, receivedAt = Date.now()) {
    const priceAlert = this.detector.processTicker(
      { symbol: trade.symbol, price: trade.price },
      this.market,
      receivedAt
    );
    const whaleAlert = this.detector.processTrade(trade, this.market, receivedAt);
    const alert = priceAlert ?? whaleAlert;

    if (alert) {
      this.onAlert?.(alert);
      await this.saveAlert(alert);
      const newPlan = this.tracker.observeAlert(alert, receivedAt);
      if (newPlan) {
        await this.savePlanEvent(newPlan.id, this.market, newPlan.symbol, newPlan.state, receivedAt, newPlan);
      }
    }

    const events = this.tracker.processTrade(trade, this.market, receivedAt);
    for (const event of events) {
      await this.savePlanEvent(
        event.planId,
        this.market,
        event.symbol,
        event.type,
        receivedAt,
        event
      );
    }
  }

  private async saveAlert(alert: MarketAlert) {
    try {
      await this.client.run(
        `INSERT INTO alert_events (id, market, symbol, type, detected_at, settings_hash, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING;`,
        alert.id,
        this.market,
        alert.symbol,
        alert.type,
        alert.timestamp,
        'default',
        JSON.stringify(alert)
      );
    } catch (err) {
      console.warn('Failed to save alert event:', err);
    }
  }

  private async savePlanEvent(
    planId: string,
    market: MarketType,
    symbol: string,
    state: string,
    at: number,
    payload: any
  ) {
    try {
      const id = `fpe-${planId}-${state}-${at}-${Math.random().toString(36).slice(2, 6)}`;
      await this.client.run(
        `INSERT INTO follow_plan_events (id, plan_id, market, symbol, state, event_time, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING;`,
        id,
        planId,
        market,
        symbol,
        state,
        at,
        JSON.stringify(payload)
      );
    } catch (err) {
      console.warn('Failed to save follow plan event:', err);
    }
  }

  getPlans() {
    return this.tracker.getPlans();
  }
}
