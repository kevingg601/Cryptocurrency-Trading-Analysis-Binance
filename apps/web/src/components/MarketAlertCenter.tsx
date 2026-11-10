import { useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  ChevronDown,
  CircleDollarSign,
  Gauge,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
  Target,
  ShieldAlert,
} from 'lucide-react';
import type { MarketAlert, MarketAlertSettings, MarketAlertType } from '../services/marketAlerts';
import { formatCryptoPrice } from '../services/utils';
import type { TickerData } from '../services/binance';
import type { FollowPlan, FollowPlanEvent, MarketNotification } from '../services/followPlans';
import { FOLLOW_PLAN_LABELS } from '../services/followPlans';
import FollowPlanSummary from './FollowPlanSummary';

interface MarketAlertCenterProps {
  alerts: MarketAlert[];
  unreadCount: number;
  activeToast: MarketNotification | null;
  followPlans: FollowPlan[];
  followEvents: FollowPlanEvent[];
  notificationPermission: NotificationPermission;
  settings: MarketAlertSettings;
  settingsLocked?: boolean;
  tickers: Record<string, TickerData>;
  monitoredCount: number;
  onEnableDesktopAlerts: () => Promise<boolean>;
  onSettingsChange: (settings: MarketAlertSettings) => void;
  onMarkAllRead: () => void;
  onClearAlerts: () => void;
  onDismissToast: () => void;
  onSelectSymbol: (symbol: string, planId?: string) => void;
}

const alertLabels: Record<MarketAlertType, string> = {
  pump: '急漲',
  dump: '急跌',
  'whale-buy': '大額買盤',
  'whale-sell': '大額賣盤',
};

function AlertIcon({ type, size = 18 }: { type: MarketNotification['type']; size?: number }) {
  if (type === 'follow-stop') return <ShieldAlert size={size} />;
  if (type.startsWith('follow-')) return <Target size={size} />;
  if (type === 'pump') return <TrendingUp size={size} />;
  if (type === 'dump') return <TrendingDown size={size} />;
  return <CircleDollarSign size={size} />;
}

function getPermissionLabel(permission: NotificationPermission): string {
  if (permission === 'granted') return '桌面通知已開啟';
  if (permission === 'denied') return '桌面通知被封鎖';
  return '開啟桌面通知與提示音';
}

export default function MarketAlertCenter({
  alerts,
  unreadCount,
  activeToast,
  followPlans,
  followEvents,
  notificationPermission,
  settings,
  settingsLocked = false,
  tickers,
  monitoredCount,
  onEnableDesktopAlerts,
  onSettingsChange,
  onMarkAllRead,
  onClearAlerts,
  onDismissToast,
  onSelectSymbol,
}: MarketAlertCenterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [listMode, setListMode] = useState<'alerts' | 'plans' | 'events'>('alerts');
  const getPlan = (notification: MarketNotification) => followPlans.find(plan => plan.id === ('planId' in notification ? notification.planId : notification.followPlanId));
  const toastPlan = activeToast ? getPlan(activeToast) : undefined;

  const togglePanel = () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) onMarkAllRead();
  };

  const selectAlert = (alert: MarketNotification) => {
    onSelectSymbol(alert.symbol, getPlan(alert)?.id);
    setIsOpen(false);
  };

  return (
    <>
      <div className="market-alert-control">
        <button
          ref={triggerRef}
          className={`market-alert-trigger ${unreadCount > 0 ? 'has-alerts' : ''}`}
          onClick={togglePanel}
          title="市場異動警報"
          aria-label="開啟市場異動警報"
          aria-expanded={isOpen}
        >
          {unreadCount > 0 ? <BellRing size={17} /> : <Bell size={17} />}
          <span>異動警報</span>
          {unreadCount > 0 && (
            <span className="market-alert-count">{Math.min(unreadCount, 99)}</span>
          )}
          <ChevronDown size={14} className={isOpen ? 'is-open' : ''} />
        </button>

        {isOpen && (
          <div className="market-alert-panel" onKeyDown={event => {
            if (event.key === 'Escape') { event.stopPropagation(); setIsOpen(false); triggerRef.current?.focus(); }
          }}>
            <div className="market-alert-panel-header">
              <div>
                <strong>市場即時警報</strong>
                <span>快速監控 {monitoredCount} 個交易對 · 最長 5 秒窗口</span>
              </div>
              <button
                className="icon-button"
                onClick={() => setIsOpen(false)}
                title="關閉"
                aria-label="關閉警報中心"
              >
                <X size={16} />
              </button>
            </div>

            <button
              className={`desktop-alert-button ${notificationPermission === 'granted' ? 'enabled' : ''}`}
              onClick={() => void onEnableDesktopAlerts()}
              disabled={notificationPermission === 'denied'}
            >
              <BellRing size={15} />
              <span>{getPermissionLabel(notificationPermission)}</span>
            </button>

            <details className="market-alert-settings-disclosure">
            <summary>警報靈敏度{settingsLocked ? ' · 自動評估期間鎖定' : ''}</summary>
            <div className="market-alert-settings">
              <div className="market-alert-settings-title">
                <Gauge size={14} />
                <span>警報靈敏度</span>
              </div>
              <label>
                <span>急漲跌門檻</span>
                <strong>{settings.priceMovePercent.toFixed(1)}%</strong>
                <input
                  disabled={settingsLocked}
                  type="range"
                  min="0.5"
                  max="5"
                  step="0.1"
                  value={settings.priceMovePercent}
                  onChange={(event) => onSettingsChange({
                    ...settings,
                    priceMovePercent: Number(event.target.value),
                  })}
                />
              </label>
              <label>
                <span>觀察窗口</span>
                <strong>{Math.round(settings.priceWindowMs / 1000)} 秒</strong>
                <input
                  disabled={settingsLocked}
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={Math.round(settings.priceWindowMs / 1000)}
                  onChange={(event) => onSettingsChange({
                    ...settings,
                    priceWindowMs: Number(event.target.value) * 1000,
                  })}
                />
              </label>
              <label>
                <span>巨鯨金額倍率</span>
                <strong>{settings.whaleMultiplier.toFixed(2)}x</strong>
                <input
                  disabled={settingsLocked}
                  type="range"
                  min="0.5"
                  max="3"
                  step="0.25"
                  value={settings.whaleMultiplier}
                  onChange={(event) => onSettingsChange({
                    ...settings,
                    whaleMultiplier: Number(event.target.value),
                  })}
                />
              </label>
            </div>

            </details>
            <div className="follow-plan-tabs" role="tablist" aria-label="警報內容">
              {([{ id: 'alerts', label: '異動警報' }, { id: 'plans', label: `跟進計畫 ${followPlans.length}` }, { id: 'events', label: `條件通知 ${followEvents.length}` }] as const).map((tab, index) => <button key={tab.id} id={`alert-tab-${tab.id}`} role="tab" aria-controls="alert-content-panel" tabIndex={listMode === tab.id ? 0 : -1} aria-selected={listMode === tab.id} onClick={() => setListMode(tab.id)} onKeyDown={event => {
                const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
                if (next === null) return;
                event.preventDefault();
                setListMode((['alerts', 'plans', 'events'] as const)[next]);
                (event.currentTarget.parentElement?.querySelectorAll('button')[next] as HTMLButtonElement | undefined)?.focus();
              }}>{tab.label}</button>)}
            </div>
            <div className="market-alert-list" id="alert-content-panel" role="tabpanel" aria-labelledby={`alert-tab-${listMode}`}>
              {listMode === 'plans' ? (followPlans.length ? followPlans.map(plan => <article className="follow-plan-list-item" key={plan.id}>
                <button className="follow-plan-select" onClick={() => { onSelectSymbol(plan.symbol, plan.id); setIsOpen(false); }}><strong>{plan.symbol.replace(/USDT$/, '')} / USDT</strong><span>查看 K 線</span></button>
                <FollowPlanSummary plan={plan} />
              </article>) : <div className="market-alert-empty">尚無保守跟進計畫</div>) : listMode === 'events' ? (followEvents.length ? followEvents.map(event => <button className="market-alert-item" key={event.id} onClick={() => selectAlert(event)}>
                <span className="market-alert-item-icon"><AlertIcon type={event.type} /></span><span className="market-alert-item-content"><strong>{event.title}</strong><span>{event.message}</span><small>{new Date(event.timestamp).toLocaleTimeString('zh-TW')} · 觸及行情 ${formatCryptoPrice(event.price)}</small></span>
              </button>) : <div className="market-alert-empty">尚無條件通知</div>) : alerts.length === 0 ? (
                <div className="market-alert-empty">
                  <Bell size={24} />
                  <span>尚未偵測到明顯異動</span>
                </div>
              ) : (
                alerts.map((alert) => (
                  <article key={alert.id}>
                  <button
                    className={`market-alert-item ${alert.type}`}
                    onClick={() => selectAlert(alert)}
                  >
                    <span className="market-alert-item-icon">
                      <AlertIcon type={alert.type} />
                    </span>
                    <span className="market-alert-item-content">
                      <span className="market-alert-item-topline">
                        <strong>{alert.title}</strong>
                        <time>{new Date(alert.timestamp).toLocaleTimeString('zh-TW', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}</time>
                      </span>
                      <span>{alert.message}</span>
                      <small>
                        {alert.marketType === 'spot' ? '現貨' : '合約'} · {alertLabels[alert.type]} · 點位 ${formatCryptoPrice(alert.price)}
                        {alert.quoteValue ? ` · ${Math.round(alert.quoteValue).toLocaleString('en-US')} USDT` : ''}
                      </small>
                      {alert.type === 'dump' && alert.marketType === 'spot' && <small>急跌風險：現貨不提供放空跟進計畫</small>}
                    </span>
                  </button>
                  {getPlan(alert) && <details className="follow-plan-details"><summary>保守跟進 · {FOLLOW_PLAN_LABELS[getPlan(alert)!.state]}</summary><FollowPlanSummary plan={getPlan(alert)!} /><button className="follow-plan-select" onClick={() => selectAlert(alert)}>查看計畫 K 線</button></details>}
                  </article>
                ))
              )}
            </div>

            {alerts.length > 0 && (
              <button className="market-alert-clear" onClick={onClearAlerts}>
                <Trash2 size={14} />
                <span>清除警報紀錄</span>
              </button>
            )}
          </div>
        )}
      </div>

      {activeToast && (
        <div className={`market-alert-toast ${activeToast.type} ${'side' in activeToast ? activeToast.side === 'LONG' ? 'pump' : 'dump' : ''}`} role="alert">
          <span className="market-alert-toast-icon">
            <AlertIcon type={activeToast.type} size={22} />
          </span>
          <button className="market-alert-toast-content" onClick={() => selectAlert(activeToast)}>
            <strong>{activeToast.title}</strong>
            <span>{activeToast.message}</span>
            {toastPlan && <small className="follow-plan-toast-level">保守觀察 ${formatCryptoPrice(toastPlan.observationPrice)} · {FOLLOW_PLAN_LABELS[toastPlan.state]}{toastPlan.stale ? ' · 待即時成交' : ''}</small>}
            {activeToast.type === 'dump' && activeToast.marketType === 'spot' && <small>現貨急跌風險，不提供放空跟進</small>}
            <small className="market-alert-live-price">目前 ${formatCryptoPrice(tickers[activeToast.symbol]?.price)} · 觸發於 {new Date(activeToast.timestamp).toLocaleTimeString('zh-TW', { hour12: false })}</small>
          </button>
          <button
            className="icon-button"
            onClick={onDismissToast}
            title="關閉"
            aria-label="關閉即時警報"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
