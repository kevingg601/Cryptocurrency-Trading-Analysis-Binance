import { useState } from 'react';
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
} from 'lucide-react';
import type { MarketAlert, MarketAlertSettings, MarketAlertType } from '../services/marketAlerts';
import { formatCryptoPrice } from '../services/utils';

interface MarketAlertCenterProps {
  alerts: MarketAlert[];
  unreadCount: number;
  activeToast: MarketAlert | null;
  notificationPermission: NotificationPermission;
  settings: MarketAlertSettings;
  onEnableDesktopAlerts: () => Promise<boolean>;
  onSettingsChange: (settings: MarketAlertSettings) => void;
  onMarkAllRead: () => void;
  onClearAlerts: () => void;
  onDismissToast: () => void;
  onSelectSymbol: (symbol: string) => void;
}

const alertLabels: Record<MarketAlertType, string> = {
  pump: '急漲',
  dump: '急跌',
  'whale-buy': '大額買盤',
  'whale-sell': '大額賣盤',
};

function AlertIcon({ type, size = 18 }: { type: MarketAlertType; size?: number }) {
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
  notificationPermission,
  settings,
  onEnableDesktopAlerts,
  onSettingsChange,
  onMarkAllRead,
  onClearAlerts,
  onDismissToast,
  onSelectSymbol,
}: MarketAlertCenterProps) {
  const [isOpen, setIsOpen] = useState(false);

  const togglePanel = () => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) onMarkAllRead();
  };

  const selectAlert = (alert: MarketAlert) => {
    onSelectSymbol(alert.symbol);
    setIsOpen(false);
  };

  return (
    <>
      <div className="market-alert-control">
        <button
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
          <div className="market-alert-panel">
            <div className="market-alert-panel-header">
              <div>
                <strong>市場即時警報</strong>
                <span>監控前 60 名流動性交易對</span>
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

            <div className="market-alert-settings">
              <div className="market-alert-settings-title">
                <Gauge size={14} />
                <span>警報靈敏度</span>
              </div>
              <label>
                <span>急漲跌門檻</span>
                <strong>{settings.priceMovePercent.toFixed(1)}%</strong>
                <input
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
                  type="range"
                  min="5"
                  max="30"
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

            <div className="market-alert-list">
              {alerts.length === 0 ? (
                <div className="market-alert-empty">
                  <Bell size={24} />
                  <span>尚未偵測到明顯異動</span>
                </div>
              ) : (
                alerts.map((alert) => (
                  <button
                    key={alert.id}
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
                    </span>
                  </button>
                ))
              )}
            </div>

            {alerts.length > 0 && (
              <button className="market-alert-clear" onClick={onClearAlerts}>
                <Trash2 size={14} />
                <span>清除全部警報</span>
              </button>
            )}
          </div>
        )}
      </div>

      {activeToast && (
        <div className={`market-alert-toast ${activeToast.type}`} role="alert">
          <span className="market-alert-toast-icon">
            <AlertIcon type={activeToast.type} size={22} />
          </span>
          <button className="market-alert-toast-content" onClick={() => selectAlert(activeToast)}>
            <strong>{activeToast.title}</strong>
            <span>{activeToast.message}</span>
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
