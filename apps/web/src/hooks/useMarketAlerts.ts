import { useCallback, useEffect, useRef, useState } from 'react';
import type { AggregateTradeData, MarketType, TickerData } from '../services/binance';
import { DEFAULT_MARKET_ALERT_SETTINGS, MarketAlertDetector, normalizeMarketAlertSettings } from '../services/marketAlerts';
import type { MarketAlert, MarketAlertSettings } from '../services/marketAlerts';
import { FollowPlanTracker } from '../services/followPlans';
import type { FollowPlan, FollowPlanEvent, MarketNotification } from '../services/followPlans';
import { formatCryptoPrice } from '../services/utils';
import type { MarketTradeFrame } from '../services/marketEvents';

const MAX_ALERTS = 50;
const TOAST_DURATION_MS = 8_000;
const SETTINGS_KEY = 'crypto_market_alert_settings';

function readSavedSettings(): MarketAlertSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_MARKET_ALERT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<MarketAlertSettings>;
    return normalizeMarketAlertSettings(parsed);
  } catch {
    return DEFAULT_MARKET_ALERT_SETTINGS;
  }
}

export function useMarketAlerts(marketType: MarketType, onTradeFrame?: (frame: MarketTradeFrame) => void) {
  const [alerts, setAlerts] = useState<MarketAlert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeToast, setActiveToast] = useState<MarketNotification | null>(null);
  const [followPlans, setFollowPlans] = useState<FollowPlan[]>([]);
  const [followEvents, setFollowEvents] = useState<FollowPlanEvent[]>([]);
  const [settings, setSettingsState] = useState<MarketAlertSettings>(() => readSavedSettings());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof Notification === 'undefined' ? 'denied' : Notification.permission
  );

  const detectorRef = useRef(new MarketAlertDetector(settings));
  const followTrackerRef = useRef(new FollowPlanTracker());
  const marketTypeRef = useRef(marketType);
  const onTradeFrameRef = useRef(onTradeFrame);
  useEffect(() => { onTradeFrameRef.current = onTradeFrame; }, [onTradeFrame]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const desktopEnabledRef = useRef(
    localStorage.getItem('crypto_market_desktop_alerts') === 'true'
  );

  useEffect(() => {
    marketTypeRef.current = marketType;
    detectorRef.current.reset();
    followTrackerRef.current.reset();
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const timer = setTimeout(() => {
      setActiveToast(null);
      setAlerts([]);
      setUnreadCount(0);
      setFollowPlans([]);
      setFollowEvents([]);
    }, 0);
    return () => clearTimeout(timer);
  }, [marketType]);

  useEffect(() => {
    const timer = setInterval(() => {
      followTrackerRef.current.tick();
      setFollowPlans(followTrackerRef.current.getPlans());
    }, 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    detectorRef.current.setSettings(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    void audioContextRef.current?.close();
  }, []);

  const playAlertTone = useCallback((type: MarketNotification['type']) => {
    const context = audioContextRef.current;
    if (!context || context.state !== 'running') return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = type === 'dump' || type === 'whale-sell' || type === 'follow-stop' ? 440 : 760;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
  }, []);

  const publishNotification = useCallback((alert: MarketNotification, body = alert.message) => {
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
        body,
        tag: `${alert.type}-${alert.symbol}`,
      });
      notification.onclick = () => window.focus();
    }
  }, [playAlertTone]);

  const publishAlert = useCallback((alert: MarketAlert, existingPlan?: FollowPlan | null) => {
    const plan = existingPlan === undefined ? followTrackerRef.current.observeAlert(alert) : existingPlan;
    const notification = { ...alert, followPlanId: plan?.id };
    setAlerts(current => [notification, ...current].slice(0, MAX_ALERTS));
    if (plan) setFollowPlans(followTrackerRef.current.getPlans());
    const body = plan ? `${alert.message} · 保守觀察 $${formatCryptoPrice(plan.observationPrice)}，等待回撤後確認；預估 TP1 $${formatCryptoPrice(plan.takeProfit1)} / TP2 $${formatCryptoPrice(plan.takeProfit2)} / SL $${formatCryptoPrice(plan.stopLoss)}` : alert.message;
    publishNotification(notification, body);
  }, [publishNotification]);

  const processTickerBatch = useCallback((batch: Array<Partial<TickerData> & { symbol: string }>) => {
    batch.forEach((ticker) => {
      const alert = detectorRef.current.processTicker(ticker, marketTypeRef.current, ticker.priceTimestamp ?? Date.now());
      if (alert) publishAlert(alert);
    });
  }, [publishAlert]);

  const processAggregateTrade = useCallback((trade: AggregateTradeData) => {
    const receivedAt = Date.now();
    const priceAlert = detectorRef.current.processTicker({ symbol: trade.symbol, price: trade.price }, marketTypeRef.current, trade.timestamp);
    const { plan, events } = followTrackerRef.current.processMarketTrade(trade, marketTypeRef.current, priceAlert, receivedAt);
    if (priceAlert) publishAlert(priceAlert, plan);
    if (events.length) {
      setFollowPlans(followTrackerRef.current.getPlans());
      setFollowEvents(current => [...events].reverse().concat(current).slice(0, MAX_ALERTS));
      events.forEach(event => publishNotification(event));
    }
    const alert = detectorRef.current.processTrade(trade, marketTypeRef.current);
    if (alert) publishAlert(alert);
    const plans = events.some(event => event.type === 'follow-confirmed') ? followTrackerRef.current.getPlans() : [];
    onTradeFrameRef.current?.({ trade, marketType: marketTypeRef.current, receivedAt, alert: priceAlert,
      confirmations: events.filter(event => event.type === 'follow-confirmed').flatMap(event => {
        const confirmedPlan = plans.find(item => item.id === event.planId);
        return confirmedPlan ? [{ event, plan: confirmedPlan }] : [];
      }) });
  }, [publishAlert, publishNotification]);

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
    setFollowEvents([]);
  }, []);
  const dismissToast = useCallback(() => setActiveToast(null), []);
  const setAlertSettings = useCallback((next: MarketAlertSettings) => {
    setSettingsState(normalizeMarketAlertSettings(next));
  }, []);

  return {
    alerts,
    unreadCount,
    activeToast,
    followPlans,
    followEvents,
    notificationPermission,
    settings,
    processTickerBatch,
    processAggregateTrade,
    publishExternalNotification: publishNotification,
    enableDesktopAlerts,
    setAlertSettings,
    markAllRead,
    clearAlerts,
    dismissToast,
  };
}
