import type { AggregateTradeData, MarketType, TickerData } from './binance';
import { formatCryptoPrice } from './utils.ts';

export type MarketAlertType = 'pump' | 'dump' | 'whale-buy' | 'whale-sell';

export interface MarketAlert {
  id: string;
  type: MarketAlertType;
  symbol: string;
  marketType: MarketType;
  title: string;
  message: string;
  price: number;
  changePercent?: number;
  quoteValue?: number;
  timestamp: number;
  referencePrice?: number;
  referenceTimestamp?: number;
  followPlanId?: string;
}

export interface MarketAlertSettings {
  priceMovePercent: number;
  priceWindowMs: number;
  whaleMultiplier: number;
}

interface PricePoint {
  price: number;
  timestamp: number;
}

export const DEFAULT_MARKET_ALERT_SETTINGS: MarketAlertSettings = {
  priceMovePercent: 1.5,
  priceWindowMs: 5_000,
  whaleMultiplier: 1,
};

export function normalizeMarketAlertSettings(settings: Partial<MarketAlertSettings>): MarketAlertSettings {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : fallback;
  return {
    priceMovePercent: clamp(settings.priceMovePercent, DEFAULT_MARKET_ALERT_SETTINGS.priceMovePercent, 0.3, 8),
    priceWindowMs: clamp(settings.priceWindowMs, DEFAULT_MARKET_ALERT_SETTINGS.priceWindowMs, 1_000, 5_000),
    whaleMultiplier: clamp(settings.whaleMultiplier, DEFAULT_MARKET_ALERT_SETTINGS.whaleMultiplier, 0.25, 5),
  };
}

const WHALE_ALERT_COOLDOWN_MS = 20_000;
const STABLE_OR_FIAT_ASSETS = new Set([
  'USDC', 'FDUSD', 'USD1', 'USDE', 'USDP', 'TUSD', 'DAI', 'EUR', 'AEUR',
]);

function getWhaleThreshold(symbol: string, multiplier: number): number {
  const baseAsset = symbol.replace(/USDT$/, '');
  if (STABLE_OR_FIAT_ASSETS.has(baseAsset)) return Number.POSITIVE_INFINITY;
  const baseThreshold = baseAsset === 'BTC' || baseAsset === 'ETH'
    ? 500_000
    : baseAsset === 'SOL' || baseAsset === 'BNB'
    ? 250_000
    : 100_000;
  return baseThreshold * multiplier;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export class MarketAlertDetector {
  private readonly priceHistory = new Map<string, PricePoint[]>();
  private readonly cooldowns = new Map<string, number>();
  private readonly episodes = new Map<string, { active: boolean; level: number; lastAlertAt: number }>();
  private sequence = 0;
  private settings: MarketAlertSettings;

  constructor(settings: MarketAlertSettings = DEFAULT_MARKET_ALERT_SETTINGS) {
    this.settings = normalizeMarketAlertSettings(settings);
  }

  setSettings(settings: MarketAlertSettings): void {
    this.settings = normalizeMarketAlertSettings(settings);
    this.reset();
  }

  reset(): void {
    this.priceHistory.clear();
    this.cooldowns.clear();
    this.episodes.clear();
  }

  processTicker(
    ticker: Partial<TickerData> & { symbol: string },
    marketType: MarketType,
    now = Date.now()
  ): MarketAlert | null {
    const price = ticker.price;
    if (!price || price <= 0 || !Number.isFinite(price) || !Number.isFinite(now)) return null;

    const history = this.priceHistory.get(ticker.symbol) ?? [];
    const lastPoint = history.at(-1);
    if (lastPoint && now < lastPoint.timestamp) return null;
    const recent = history.filter(point => point.timestamp >= now - this.settings.priceWindowMs);
    const minimum = recent.reduce<PricePoint>((best, point) => point.price < best.price ? point : best, { price, timestamp: now });
    const maximum = recent.reduce<PricePoint>((best, point) => point.price > best.price ? point : best, { price, timestamp: now });
    if (!lastPoint || price !== lastPoint.price || now - lastPoint.timestamp >= 100) recent.push({ price, timestamp: now });
    this.priceHistory.set(ticker.symbol, recent);
    const pumpChange = (price - minimum.price) / minimum.price * 100;
    const dumpChange = (price - maximum.price) / maximum.price * 100;
    for (const [direction, magnitude] of [['pump', pumpChange], ['dump', -dumpChange]] as const) {
      if (magnitude < this.settings.priceMovePercent * 0.5) this.episodes.delete(`${direction}:${ticker.symbol}`);
    }
    const rising = !lastPoint || price >= lastPoint.price;
    const reference = rising && pumpChange >= this.settings.priceMovePercent ? minimum : maximum;
    const changePercent = ((price - reference.price) / reference.price) * 100;
    if (Math.abs(changePercent) < this.settings.priceMovePercent) return null;
    const type: MarketAlertType = changePercent > 0 ? 'pump' : 'dump';
    const key = `${type}:${ticker.symbol}`;
    const episode = this.episodes.get(key);
    const level = Math.floor((Math.abs(changePercent) + 1e-9) / this.settings.priceMovePercent);
    if (episode?.active && (level <= episode.level || now - episode.lastAlertAt < 250)) return null;
    if (!this.canAlert(`price:${key}`, now, 250)) return null;
    this.episodes.set(key, { active: true, level, lastAlertAt: now });
    const direction = changePercent > 0 ? '暴漲' : '暴跌';
    const elapsed = Math.max(0, (now - reference.timestamp) / 1000);

    return {
      id: `${marketType}-${now}-${ticker.symbol}-${type}-${++this.sequence}`,
      type,
      symbol: ticker.symbol,
      marketType,
      title: `${ticker.symbol.replace('USDT', '')} 短線${direction}`,
      message: `${elapsed.toFixed(1)} 秒內${changePercent > 0 ? '上漲' : '下跌'} ${Math.abs(changePercent).toFixed(2)}%，觸發價 $${formatCryptoPrice(price)}`,
      price,
      changePercent,
      timestamp: now,
      referencePrice: reference.price,
      referenceTimestamp: reference.timestamp,
    };
  }

  processTrade(
    trade: AggregateTradeData,
    marketType: MarketType,
    now = Date.now()
  ): MarketAlert | null {
    if (trade.quoteValue < getWhaleThreshold(trade.symbol, this.settings.whaleMultiplier)) return null;

    const type: MarketAlertType = trade.side === 'buy' ? 'whale-buy' : 'whale-sell';
    const cooldownKey = `${type}:${trade.symbol}`;
    if (!this.canAlert(cooldownKey, now, WHALE_ALERT_COOLDOWN_MS)) return null;

    const baseAsset = trade.symbol.replace('USDT', '');
    const action = trade.side === 'buy' ? '主動買入' : '主動賣出';

    return {
      id: `${marketType}-${now}-${trade.symbol}-${type}-${++this.sequence}`,
      type,
      symbol: trade.symbol,
      marketType,
      title: `${baseAsset} 巨鯨${trade.side === 'buy' ? '買盤' : '賣盤'}推估`,
      message: `偵測到單筆約 ${formatUsd(trade.quoteValue)} 的${action}，成交點位 $${formatCryptoPrice(trade.price)}`,
      price: trade.price,
      quoteValue: trade.quoteValue,
      timestamp: trade.timestamp,
    };
  }

  private canAlert(key: string, now: number, cooldown: number): boolean {
    const previous = this.cooldowns.get(key) ?? 0;
    if (now - previous < cooldown) return false;
    this.cooldowns.set(key, now);
    return true;
  }
}
