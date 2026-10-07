import { ArrowDownRight, ArrowUpRight, Clock3, ShieldAlert, X } from 'lucide-react';
import type { FollowPlan } from '../services/followPlans';
import { FOLLOW_PLAN_LABELS, isFollowPlanActive } from '../services/followPlans';
import { formatCryptoPrice } from '../services/utils';
import './FollowPlan.css';
import { useEffect, useState } from 'react';

export default function FollowPlanSummary({ plan, compact = false, now: suppliedNow, onClose }: {
  plan: FollowPlan; compact?: boolean; now?: number; onClose?: () => void;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (suppliedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [suppliedNow]);
  const now = suppliedNow ?? clock;
  const anchor = plan.confirmedEntry ?? plan.observationPrice;
  const locked = plan.confirmedEntry !== undefined;
  const active = isFollowPlanActive(plan);
  const seconds = Math.max(0, Math.ceil((plan.expiresAt - now) / 1000));
  const threshold = plan.extreme !== undefined ? plan.extreme + (plan.side === 'LONG' ? 1 : -1) * plan.impulse * 0.1 : undefined;
  const levels = [
    { name: '保守觀察', value: plan.observationPrice },
    { name: '確認參考', value: plan.confirmedEntry },
    { name: `TP1 · ${locked ? '已鎖定' : '預估'}`, value: plan.takeProfit1, tone: 'trend-up' },
    { name: `TP2 · ${locked ? '已鎖定' : '預估'}`, value: plan.takeProfit2, tone: 'trend-up' },
    { name: `SL · ${locked ? '已鎖定' : '預估'}`, value: plan.stopLoss, tone: 'trend-down' },
  ];
  return <section className={`follow-plan-summary ${compact ? 'compact' : ''} ${plan.side.toLowerCase()}`} aria-label={`${plan.symbol} 保守跟進計畫`}>
    <div className="follow-plan-heading">
      <strong>{plan.side === 'LONG' ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}保守跟進 · {plan.side === 'LONG' ? '做多' : '做空'}</strong>
      <span className={`follow-plan-state ${active && plan.stale ? 'stale' : ''}`} role="status">{FOLLOW_PLAN_LABELS[plan.state]}{active && plan.stale ? locked ? ' · 資料延遲，暫停觸及判定' : ' · 資料延遲，暫停確認' : ''}</span>
      {onClose && <button className="icon-button" onClick={onClose} aria-label="隱藏跟進計畫" title="隱藏跟進計畫"><X size={15} /></button>}
    </div>
    <div className="follow-plan-levels">
      {levels.map(level => <div key={level.name}>
        <span>{level.name}</span><strong className={level.tone}>{level.value !== undefined ? `$${formatCryptoPrice(level.value)}` : '尚未確認'}</strong>
        {level.value !== undefined && level.value !== anchor && <small>價格 {((level.value / anchor - 1) * 100).toFixed(2)}%</small>}
      </div>)}
    </div>
    {!compact && <div className="follow-plan-condition">
      <span>觀察區 ${formatCryptoPrice(plan.zoneLow)} – ${formatCryptoPrice(plan.zoneHigh)}</span>
      {!locked && <span>{threshold !== undefined ? `${plan.side === 'LONG' ? '反彈維持 ≥' : '回落維持 ≤'} $${formatCryptoPrice(threshold)} · 3 秒成交確認` : plan.side === 'LONG' ? '等待回踩後止穩確認' : '等待反彈後受阻確認'}</span>}
      {active && <span><Clock3 size={12} /> 剩餘 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>}
      {plan.reason && <span>{plan.reason}</span>}
    </div>}
    {!compact && <p className="follow-plan-risk"><ShieldAlert size={12} />條件觀察，未下單；回撤確認不代表低風險，點位未驗證獲利能力。</p>}
  </section>;
}
