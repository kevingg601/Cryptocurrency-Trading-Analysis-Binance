import type { FollowPlan } from './followPlans';
import { isFollowPlanActive } from './followPlans.ts';

export function followPlanLines(plan: FollowPlan) {
  const color = isFollowPlanActive(plan) ? '#0ba99b' : '#87928f';
  const prefix = plan.confirmedEntry === undefined ? '預估 ' : '';
  return [
    { price: plan.zoneLow, color, title: '回撤區下界' },
    { price: plan.zoneHigh, color, title: '回撤區上界' },
    { price: plan.observationPrice, color, title: '保守觀察' },
    ...(plan.confirmedEntry !== undefined ? [{ price: plan.confirmedEntry, color: '#e5b331', title: '確認參考' }] : []),
    { price: plan.takeProfit1, color: '#30b889', title: `${prefix}TP1` },
    { price: plan.takeProfit2, color: '#30b889', title: `${prefix}TP2` },
    { price: plan.stopLoss, color: '#ed6378', title: `${prefix}SL / 失效` },
  ];
}
