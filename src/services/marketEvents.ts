import type { AggregateTradeData, MarketType } from './binance';
import type { FollowPlan, FollowPlanEvent } from './followPlans';
import type { MarketAlert } from './marketAlerts';

export interface MarketTradeFrame {
  trade: AggregateTradeData;
  marketType: MarketType;
  receivedAt: number;
  alert: MarketAlert | null;
  confirmations: Array<{ event: FollowPlanEvent; plan: FollowPlan }>;
}
