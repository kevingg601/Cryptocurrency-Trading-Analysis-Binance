import type { AggregateTradeData, MarketType } from '../market/types.ts';
import { MarketAlertDetector, normalizeMarketAlertSettings } from '../alerts/marketAlerts.ts';
import type { MarketAlert, MarketAlertSettings } from '../alerts/marketAlerts.ts';
import { FollowPlanTracker } from '../follow/followPlans.ts';
import type { FollowPlan } from '../follow/followPlans.ts';
import {
  AutoTradingEngine,
  calculateAutoMetrics,
  defaultAutoTradingConfig,
} from '../auto/autoTrading.ts';
import type {
  AutoClosedTrade,
  AutoTradingConfig,
} from '../auto/autoTrading.ts';
import type { AutoSymbolRules } from '../auto/autoTradingMarket.ts';
import type { MarketTradeFrame } from '../market/marketEvents.ts';

export interface ReplayGap {
  symbol: string;
  from: number;
  to: number;
}

export interface ReplayInput {
  market: MarketType;
  trades: AsyncIterable<AggregateTradeData> | Iterable<AggregateTradeData>;
  gaps?: ReplayGap[];
  alertSettings?: Partial<MarketAlertSettings>;
  autoConfig?: Partial<AutoTradingConfig>;
  symbolRules?: Record<string, AutoSymbolRules>;
}

export interface ReplayResult {
  alerts: MarketAlert[];
  plans: FollowPlan[];
  closedTrades: AutoClosedTrade[];
  metrics: ReturnType<typeof calculateAutoMetrics>;
  skippedByGap: number;
  totalTrades: number;
  durationMs: number;
}

export async function runTradeReplay(input: ReplayInput): Promise<ReplayResult> {
  const { market, trades, gaps = [], alertSettings, autoConfig, symbolRules = {} } = input;

  const normalizedSettings = normalizeMarketAlertSettings(alertSettings ?? {});
  const detector = new MarketAlertDetector(normalizedSettings);

  const plansMap = new Map<string, FollowPlan>();
  const tracker = new FollowPlanTracker();

  const mergedConfig: AutoTradingConfig = {
    ...defaultAutoTradingConfig(market),
    ...(autoConfig ?? {}),
  };

  const defaultRule: AutoSymbolRules = {
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 100000,
    minNotional: 5,
  };

  const engine = new AutoTradingEngine(market);
  engine.setRules(symbolRules);
  engine.setStreamHealthy(true, 0);

  // Start engine if auto trading is enabled
  if (autoConfig) {
    const rulesToSet = { ...symbolRules };
    if (!Object.keys(rulesToSet).length) {
      rulesToSet['BTCUSDT'] = defaultRule;
      rulesToSet['ETHUSDT'] = defaultRule;
    }
    engine.setRules(rulesToSet);
    engine.start(mergedConfig, 0);
  }

  const alerts: MarketAlert[] = [];
  let skippedByGap = 0;
  let totalTrades = 0;
  let minTime = Infinity;
  let maxTime = -Infinity;

  function isInGap(symbol: string, time: number): boolean {
    return gaps.some(g => g.symbol === symbol && time >= g.from && time <= g.to);
  }

  for await (const trade of trades) {
    totalTrades++;
    if (trade.timestamp < minTime) minTime = trade.timestamp;
    if (trade.timestamp > maxTime) maxTime = trade.timestamp;

    if (isInGap(trade.symbol, trade.timestamp)) {
      skippedByGap++;
      continue;
    }

    const tradeTime = trade.timestamp;
    const priceAlert = detector.processTicker({ symbol: trade.symbol, price: trade.price }, market, tradeTime);
    const whaleAlert = detector.processTrade(trade, market, tradeTime);
    const alert = priceAlert ?? whaleAlert;

    if (alert) {
      alerts.push(alert);
      const newPlan = tracker.observeAlert(alert, tradeTime);
      if (newPlan) plansMap.set(newPlan.id, newPlan);
    }

    const events = tracker.processTrade(trade, market, tradeTime);
    for (const p of tracker.getPlans()) {
      plansMap.set(p.id, p);
    }

    const confirmations = events
      .filter(e => e.type === 'follow-confirmed')
      .map(e => {
        const plan = tracker.getPlans().find(p => p.id === e.planId) ?? plansMap.get(e.planId)!;
        return { event: e, plan };
      })
      .filter((c): c is { event: any; plan: FollowPlan } => Boolean(c.plan));

    if (autoConfig) {
      const frame: MarketTradeFrame = {
        trade,
        marketType: market,
        receivedAt: tradeTime,
        alert,
        confirmations,
      };
      engine.processFrame(frame);
    }
  }

  const snapshot = engine.snapshot();
  const metrics = calculateAutoMetrics(snapshot);
  const allPlans = Array.from(plansMap.values());

  return {
    alerts,
    plans: allPlans.length ? allPlans : tracker.getPlans(),
    closedTrades: snapshot.trades,
    metrics,
    skippedByGap,
    totalTrades,
    durationMs: totalTrades > 0 && maxTime >= minTime ? maxTime - minTime : 0,
  };
}
