import type { AggregateTradeData, MarketType, TickerData } from './binance';

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
  priceWindowMs: 10_000,
  whaleMultiplier: 1,
};

const PRICE_HISTORY_PADDING_MS = 2_000;
const PRICE_ALERT_COOLDOWN_MS = 60_000;
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
  private settings: MarketAlertSettings;

  constructor(settings: MarketAlertSettings = DEFAULT_MARKET_ALERT_SETTINGS) {
    this.settings = settings;
  }

  setSettings(settings: MarketAlertSettings): void {
    this.settings = settings;
  }

  reset(): void {
    this.priceHistory.clear();
    this.cooldowns.clear();
  }

  processTicker(
    ticker: Partial<TickerData> & { symbol: string },
    marketType: MarketType,
    now = Date.now()
  ): MarketAlert | null {
    const price = ticker.price;
    if (!price || !Number.isFinite(price)) return null;

    const history = this.priceHistory.get(ticker.symbol) ?? [];
    const recent = history.filter((point) => point.timestamp >= now - this.settings.priceWindowMs - PRICE_HISTORY_PADDING_MS);
    const lastPoint = recent.at(-1);
    if (!lastPoint || now - lastPoint.timestamp >= 800) {
      recent.push({ price, timestamp: now });
    }
    this.priceHistory.set(ticker.symbol, recent);

    const reference = recent[0];
    if (!reference || now - reference.timestamp < this.settings.priceWindowMs * 0.8) return null;

    const changePercent = ((price - reference.price) / reference.price) * 100;
    if (Math.abs(changePercent) < this.settings.priceMovePercent) return null;

    const type: MarketAlertType = changePercent > 0 ? 'pump' : 'dump';
    const cooldownKey = `${type}:${ticker.symbol}`;
    if (!this.canAlert(cooldownKey, now, PRICE_ALERT_COOLDOWN_MS)) return null;

    // Restart the comparison window after an alert to avoid reporting one move repeatedly.
    this.priceHistory.set(ticker.symbol, [{ price, timestamp: now }]);
    const direction = changePercent > 0 ? '暴漲' : '暴跌';

    return {
      id: `${now}-${ticker.symbol}-${type}`,
      type,
      symbol: ticker.symbol,
      marketType,
      title: `${ticker.symbol.replace('USDT', '')} 短線${direction}`,
      message: `約 ${Math.round(this.settings.priceWindowMs / 1000)} 秒內${changePercent > 0 ? '上漲' : '下跌'} ${Math.abs(changePercent).toFixed(2)}%，點位 $${price.toLocaleString('en-US')}`,
      price,
      changePercent,
      timestamp: now,
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
      id: `${now}-${trade.symbol}-${type}`,
      type,
      symbol: trade.symbol,
      marketType,
      title: `${baseAsset} 巨鯨${trade.side === 'buy' ? '買盤' : '賣盤'}推估`,
      message: `偵測到單筆約 ${formatUsd(trade.quoteValue)} 的${action}，成交點位 $${trade.price.toLocaleString('en-US')}`,
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
