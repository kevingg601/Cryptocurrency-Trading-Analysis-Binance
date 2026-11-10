import type { AggregateTradeData, MarketType } from './types.ts';
import type { FollowPlan, FollowPlanEvent } from '../follow/followPlans.ts';
import type { MarketAlert } from '../alerts/marketAlerts.ts';

export interface MarketTradeFrame {
  trade: AggregateTradeData;
  marketType: MarketType;
  receivedAt: number;
  alert: MarketAlert | null;
  confirmations: Array<{ event: FollowPlanEvent; plan: FollowPlan }>;
}
