import { useCallback, useEffect, useRef, useState } from 'react';
import type { AggregateTradeData, MarketType, TickerData } from '../services/binance';
import { DEFAULT_MARKET_ALERT_SETTINGS, MarketAlertDetector } from '../services/marketAlerts';
import type { MarketAlert, MarketAlertSettings } from '../services/marketAlerts';

const MAX_ALERTS = 50;
const TOAST_DURATION_MS = 8_000;
const SETTINGS_KEY = 'crypto_market_alert_settings';

function readSavedSettings(): MarketAlertSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_MARKET_ALERT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<MarketAlertSettings>;
    return {
      priceMovePercent: Number.isFinite(parsed.priceMovePercent) ? parsed.priceMovePercent! : DEFAULT_MARKET_ALERT_SETTINGS.priceMovePercent,
      priceWindowMs: Number.isFinite(parsed.priceWindowMs) ? parsed.priceWindowMs! : DEFAULT_MARKET_ALERT_SETTINGS.priceWindowMs,
      whaleMultiplier: Number.isFinite(parsed.whaleMultiplier) ? parsed.whaleMultiplier! : DEFAULT_MARKET_ALERT_SETTINGS.whaleMultiplier,
    };
  } catch {
    return DEFAULT_MARKET_ALERT_SETTINGS;
  }
}

export function useMarketAlerts(marketType: MarketType) {
  const [alerts, setAlerts] = useState<MarketAlert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeToast, setActiveToast] = useState<MarketAlert | null>(null);
  const [settings, setSettingsState] = useState<MarketAlertSettings>(() => readSavedSettings());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission
  );

  const detectorRef = useRef(new MarketAlertDetector(settings));
  const marketTypeRef = useRef(marketType);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const desktopEnabledRef = useRef(
    localStorage.getItem('crypto_market_desktop_alerts') === 'true'
  );

  useEffect(() => {
    marketTypeRef.current = marketType;
    detectorRef.current.reset();
  }, [marketType]);

  useEffect(() => {
    detectorRef.current.setSettings(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    void audioContextRef.current?.close();
  }, []);

  const playAlertTone = useCallback((type: MarketAlert['type']) => {
    const context = audioContextRef.current;
    if (!context || context.state !== 'running') return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = type === 'dump' || type === 'whale-sell' ? 440 : 760;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
  }, []);

  const publishAlert = useCallback((alert: MarketAlert) => {
    setAlerts((current) => [alert, ...current].slice(0, MAX_ALERTS));
    setUnreadCount((count) => count + 1);
    setActiveToast(alert);

    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setActiveToast(null), TOAST_DURATION_MS);

    playAlertTone(alert.type);

    if (
      desktopEnabledRef.current &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      const notification = new Notification(alert.title, {
        body: alert.message,
        tag: `${alert.type}-${alert.symbol}`,
      });
      notification.onclick = () => window.focus();
    }
  }, [playAlertTone]);

  const processTickerBatch = useCallback((batch: Array<Partial<TickerData> & { symbol: string }>) => {
    const now = Date.now();
    batch.forEach((ticker) => {
      const alert = detectorRef.current.processTicker(ticker, marketTypeRef.current, now);
      if (alert) publishAlert(alert);
    });
  }, [publishAlert]);

  const processAggregateTrade = useCallback((trade: AggregateTradeData) => {
    const alert = detectorRef.current.processTrade(trade, marketTypeRef.current);
    if (alert) publishAlert(alert);
  }, [publishAlert]);

  const enableDesktopAlerts = useCallback(async () => {
    if (typeof Notification === 'undefined') return false;

    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
    setNotificationPermission(permission);

    const enabled = permission === 'granted';
    desktopEnabledRef.current = enabled;
    localStorage.setItem('crypto_market_desktop_alerts', String(enabled));

    if (enabled) {
      audioContextRef.current ??= new AudioContext();
      await audioContextRef.current.resume();
    }

    return enabled;
  }, []);

  const markAllRead = useCallback(() => setUnreadCount(0), []);
  const clearAlerts = useCallback(() => {
    setAlerts([]);
    setUnreadCount(0);
    setActiveToast(null);
  }, []);
  const dismissToast = useCallback(() => setActiveToast(null), []);
  const setAlertSettings = useCallback((next: MarketAlertSettings) => {
    setSettingsState({
      priceMovePercent: Math.max(0.3, Math.min(8, next.priceMovePercent)),
      priceWindowMs: Math.max(3_000, Math.min(60_000, next.priceWindowMs)),
      whaleMultiplier: Math.max(0.25, Math.min(5, next.whaleMultiplier)),
    });
  }, []);

  return {
    alerts,
    unreadCount,
    activeToast,
    notificationPermission,
    settings,
    processTickerBatch,
    processAggregateTrade,
    enableDesktopAlerts,
    setAlertSettings,
    markAllRead,
    clearAlerts,
    dismissToast,
  };
}
