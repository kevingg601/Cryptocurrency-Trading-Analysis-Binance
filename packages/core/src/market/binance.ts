import { connectMarketStreams } from './marketStream.ts';
import type { StreamStatusCallback } from './marketStream';
// Binance API and WebSocket integration service supporting Spot and Futures dynamically

export type MarketType = 'spot' | 'futures';

export interface CoinMetadata {
  symbol: string;
  name: string;
  baseAsset: string;
  quoteAsset: string;
  logo: string;
}

export interface TickerData {
  symbol: string;
  price: number;
  priceChange: number;
  priceChangePercent: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  open: number;
  priceTimestamp?: number;
  receivedAt?: number;
  priceSource?: 'trade' | 'ticker' | 'rest';
  tradeId?: number;
}

export interface AggregateTradeData {
  symbol: string;
  price: number;
  quantity: number;
  quoteValue: number;
  side: 'buy' | 'sell';
  timestamp: number;
  lastTradeId?: number;
}

export interface KlineData {
  time: number; // unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  lastTradeId?: number;
}

// Popular coin metadata lookup for high-quality names and logos
const POPULAR_LOGOS: Record<string, { name: string; logo: string }> = {
  'BTCUSDT': { name: 'Bitcoin', logo: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png' },
  'ETHUSDT': { name: 'Ethereum', logo: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png' },
  'SOLUSDT': { name: 'Solana', logo: 'https://assets.coingecko.com/coins/images/4128/large/solana.png' },
  'BNBUSDT': { name: 'BNB', logo: 'https://assets.coingecko.com/coins/images/825/large/binance-coin-logo.png' },
  'XRPUSDT': { name: 'Ripple', logo: 'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png' },
  'ADAUSDT': { name: 'Cardano', logo: 'https://assets.coingecko.com/coins/images/975/large/cardano.png' },
  'DOGEUSDT': { name: 'Dogecoin', logo: 'https://assets.coingecko.com/coins/images/325/large/dogecoin.png' },
  'AVAXUSDT': { name: 'Avalanche', logo: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedCardback_TransBg.png' },
  'LINKUSDT': { name: 'Chainlink', logo: 'https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png' },
  'DOTUSDT': { name: 'Polkadot', logo: 'https://assets.coingecko.com/coins/images/12171/large/polkadot.png' },
  'MATICUSDT': { name: 'Polygon', logo: 'https://assets.coingecko.com/coins/images/4713/large/polygon.png' },
  'LTCUSDT': { name: 'Litecoin', logo: 'https://assets.coingecko.com/coins/images/2/large/litecoin.png' },
  'TRXUSDT': { name: 'TRON', logo: 'https://assets.coingecko.com/coins/images/1094/large/tron.png' },
  'NEARUSDT': { name: 'NEAR Protocol', logo: 'https://assets.coingecko.com/coins/images/10365/large/near.png' },
  'APTUSDT': { name: 'Aptos', logo: 'https://assets.coingecko.com/coins/images/26455/large/aptos_round.png' },
  'OPUSDT': { name: 'Optimism', logo: 'https://assets.coingecko.com/coins/images/25244/large/Optimism.png' },
  'ARBUSDT': { name: 'Arbitrum', logo: 'https://assets.coingecko.com/coins/images/16547/large/photo_2023-03-29_21.47.00.jpeg' },
  'SUIUSDT': { name: 'Sui', logo: 'https://assets.coingecko.com/coins/images/26375/large/sui_logo.png' },
  'PEPEUSDT': { name: 'Pepe', logo: 'https://assets.coingecko.com/coins/images/29850/large/pepe-token.jpeg' },
  'SHIBUSDT': { name: 'Shiba Inu', logo: 'https://assets.coingecko.com/coins/images/11939/large/shiba.jpeg' }
};

// Fallback coins list
export const FALLBACK_COINS: CoinMetadata[] = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', baseAsset: 'BTC', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png' },
  { symbol: 'ETHUSDT', name: 'Ethereum', baseAsset: 'ETH', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png' },
  { symbol: 'SOLUSDT', name: 'Solana', baseAsset: 'SOL', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/4128/large/solana.png' },
  { symbol: 'BNBUSDT', name: 'BNB', baseAsset: 'BNB', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/825/large/binance-coin-logo.png' },
  { symbol: 'XRPUSDT', name: 'Ripple', baseAsset: 'XRP', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/44/large/xrp-symbol-white-128.png' },
  { symbol: 'ADAUSDT', name: 'Cardano', baseAsset: 'ADA', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/975/large/cardano.png' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', baseAsset: 'DOGE', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/325/large/dogecoin.png' },
  { symbol: 'AVAXUSDT', name: 'Avalanche', baseAsset: 'AVAX', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedCardback_TransBg.png' },
  { symbol: 'LINKUSDT', name: 'Chainlink', baseAsset: 'LINK', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/877/large/chainlink-new-logo.png' },
  { symbol: 'DOTUSDT', name: 'Polkadot', baseAsset: 'DOT', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/12171/large/polkadot.png' },
  { symbol: 'MATICUSDT', name: 'Polygon', baseAsset: 'MATIC', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/4713/large/polygon.png' },
  { symbol: 'LTCUSDT', name: 'Litecoin', baseAsset: 'LTC', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/2/large/litecoin.png' },
  { symbol: 'TRXUSDT', name: 'TRON', baseAsset: 'TRX', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/1094/large/tron.png' },
  { symbol: 'NEARUSDT', name: 'NEAR Protocol', baseAsset: 'NEAR', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/10365/large/near.png' },
  { symbol: 'APTUSDT', name: 'Aptos', baseAsset: 'APT', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/26455/large/aptos_round.png' },
  { symbol: 'OPUSDT', name: 'Optimism', baseAsset: 'OP', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/25244/large/Optimism.png' },
  { symbol: 'ARBUSDT', name: 'Arbitrum', baseAsset: 'ARB', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/16547/large/photo_2023-03-29_21.47.00.jpeg' },
  { symbol: 'SUIUSDT', name: 'Sui', baseAsset: 'SUI', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/26375/large/sui_logo.png' },
  { symbol: 'PEPEUSDT', name: 'Pepe', baseAsset: 'PEPE', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/29850/large/pepe-token.jpeg' },
  { symbol: 'SHIBUSDT', name: 'Shiba Inu', baseAsset: 'SHIB', quoteAsset: 'USDT', logo: 'https://assets.coingecko.com/coins/images/11939/large/shiba.jpeg' }
];

// Utility functions to resolve base URLs dynamically
function getRestBase(market: MarketType): string {
  return market === 'spot' 
    ? 'https://api.binance.com/api/v3' 
    : 'https://fapi.binance.com/fapi/v1';
}


// Fetch helper with timeout capability
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = 3000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Fetch trading pairs dynamically (Spot vs. Perpetual Futures)
export async function fetchSupportedCoins(marketType: MarketType = 'spot'): Promise<CoinMetadata[]> {
  try {
    const response = await fetchWithTimeout(`${getRestBase(marketType)}/exchangeInfo`, {}, 3000);
    if (!response.ok) {
      throw new Error(`Failed to fetch exchange info: ${response.statusText}`);
    }
    const data = await response.json();
    
    // Filter active pairs paired with USDT
    // For futures, we also verify contractType is PERPETUAL
    const tradingUSDT = data.symbols.filter((sym: any) => {
      const isTrading = sym.status === 'TRADING';
      const isUSDT = sym.quoteAsset === 'USDT';
      if (marketType === 'spot') {
        return isTrading && isUSDT;
      } else {
        return isTrading && isUSDT && sym.contractType === 'PERPETUAL';
      }
    });

    if (tradingUSDT.length === 0) {
      console.warn('No active trading pairs found in API response, using fallback.');
      return FALLBACK_COINS;
    }

    return tradingUSDT.map((sym: any) => {
      const popular = POPULAR_LOGOS[sym.symbol];
      return {
        symbol: sym.symbol,
        baseAsset: sym.baseAsset,
        quoteAsset: sym.quoteAsset,
        name: popular ? popular.name : sym.baseAsset,
        logo: popular ? popular.logo : ''
      };
    });
  } catch (error) {
    console.warn(`Failed to fetch dynamic ${marketType} exchange info, falling back to static coin list:`, error);
    return FALLBACK_COINS;
  }
}

// Fetch all symbols' tickers in a single request
export async function fetchTickers(marketType: MarketType = 'spot'): Promise<TickerData[]> {
  const requestedAt = Date.now();
  try {
    const response = await fetchWithTimeout(`${getRestBase(marketType)}/ticker/24hr`, {}, 3000);
    if (!response.ok) {
      throw new Error(`Failed to fetch tickers: ${response.statusText}`);
    }
    const data = await response.json();
    
    // Filter results for USDT pairs only
    const usdtTickers = data.filter((item: any) => item.symbol.endsWith('USDT'));
    
    return usdtTickers.map((item: any) => ({
      symbol: item.symbol,
      price: parseFloat(item.lastPrice),
      priceChange: parseFloat(item.priceChange),
      priceChangePercent: parseFloat(item.priceChangePercent),
      high: parseFloat(item.highPrice || item.high), // fapi uses high/low or highPrice/lowPrice depending on version
      low: parseFloat(item.lowPrice || item.low),
      volume: parseFloat(item.volume),
      quoteVolume: parseFloat(item.quoteVolume),
      open: parseFloat(item.openPrice || item.open),
      priceSource: 'rest' as const,
      receivedAt: requestedAt,
    }));
  } catch (error) {
    console.warn(`Failed to fetch initial 24h ${marketType} tickers, waiting for WebSocket ticks:`, error);
    return [];
  }
}

// Fetch historical candlestick data
export async function fetchKlines(
  symbol: string, 
  interval: string = '1h', 
  limit: number = 200, 
  marketType: MarketType = 'spot'
): Promise<KlineData[]> {
  try {
    const response = await fetchWithTimeout(`${getRestBase(marketType)}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {}, 3000);
    if (!response.ok) {
      throw new Error(`Failed to fetch klines for ${symbol}: ${response.statusText}`);
    }
    const data = await response.json();
    return data.map((item: any[]) => ({
      time: Math.floor(item[0] / 1000), // Open time in seconds
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      volume: parseFloat(item[5]),
    }));
  } catch (error) {
    console.error(`Error fetching klines for ${symbol} in ${marketType} market:`, error);
    throw error;
  }
}

// Fetch all U-Margin Perpetual Futures Funding Rates
export async function fetchFundingRates(): Promise<Record<string, number>> {
  try {
    const response = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/premiumIndex', {}, 3000);
    if (!response.ok) {
      throw new Error(`Failed to fetch funding rates: ${response.statusText}`);
    }
    const data = await response.json();
    const rates: Record<string, number> = {};
    data.forEach((item: any) => {
      if (item.symbol.endsWith('USDT') && item.lastFundingRate !== undefined) {
        rates[item.symbol] = parseFloat(item.lastFundingRate);
      }
    });
    return rates;
  } catch (error) {
    console.warn('Failed to fetch futures funding rates:', error);
    return {};
  }
}

// Fetch current Open Interest for a specific perpetual symbol
export async function fetchOpenInterest(symbol: string, marketType: MarketType): Promise<number | null> {
  if (marketType === 'spot') return null;
  try {
    const response = await fetchWithTimeout(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, {}, 3000);
    if (!response.ok) {
      throw new Error(`Failed to fetch open interest for ${symbol}: ${response.statusText}`);
    }
    const data = await response.json();
    return parseFloat(data.openInterest);
  } catch (error) {
    console.warn(`Failed to fetch open interest for ${symbol}:`, error);
    return null;
  }
}

// Connect to Binance All Tickers WebSocket Stream (Spot or Futures)
export interface WsConnection {
  close: () => void;
  reconnect: () => void;
}

interface StreamPayload {
  e?: string; s?: string; p?: string; q?: string; m?: boolean; T?: number; E?: number;
  l?: number; c?: string; P?: string; h?: string; v?: string; o?: string; C?: number; st?: number;
  k?: { t: number; o: string; h: string; l: string; c: string; v: string; L?: number };
}

function unwrapPayload(payload: unknown): StreamPayload[] {
  const wrapped = payload as { data?: unknown };
  const data = wrapped?.data ?? payload;
  return (Array.isArray(data) ? data : [data]).filter(item => item && typeof item === 'object');
}

// Stream subscriptions are sharded, not truncated to the first 60 symbols.
export function connectAggregateTradeWebSocket(
  marketType: MarketType,
  symbols: string[],
  onTrade: (trade: AggregateTradeData) => void,
  onStatus?: StreamStatusCallback,
): WsConnection {
  return connectMarketStreams(marketType, symbols.map(symbol => `${symbol.toLowerCase()}@aggTrade`), payload => {
    let valid = false;
    for (const data of unwrapPayload(payload)) {
      const price = Number(data.p), quantity = Number(data.q);
      if (data.e !== 'aggTrade' || data.st === 2 || !data.s?.endsWith('USDT') || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(data.T)) continue;
      valid = true;
      onTrade({ symbol: data.s, price, quantity, quoteValue: price * quantity, side: data.m ? 'sell' : 'buy', timestamp: data.T!, lastTradeId: data.l });
    }
    return valid;
  }, onStatus);
}

// Connect to Binance All Tickers WebSocket Stream (Spot or Futures) with auto-reconnect
export function connectTickerWebSocket(
  marketType: MarketType = 'spot',
  onUpdate: (data: Array<Partial<TickerData> & { symbol: string }>) => void,
  onStatusChange?: StreamStatusCallback,
  symbols: string[] = []
): WsConnection {
  const list = symbols.length ? symbols : FALLBACK_COINS.map(coin => coin.symbol);
  const streams = marketType === 'futures' ? ['!ticker@arr'] : list.map(symbol => `${symbol.toLowerCase()}@ticker`);
  return connectMarketStreams(marketType, streams, payload => {
    const receivedAt = Date.now();
    const batch = unwrapPayload(payload).filter(data => data.e === '24hrTicker' && data.st !== 2 && data.s?.endsWith('USDT') && Number(data.c) > 0)
      .map(data => ({
        symbol: data.s!, price: Number(data.c), priceChangePercent: Number(data.P),
        high: Number(data.h), low: Number(data.l), volume: Number(data.v), quoteVolume: Number(data.q), open: Number(data.o),
        priceTimestamp: data.C ?? data.E, receivedAt, priceSource: 'ticker' as const,
      }));
    if (!batch.length) return false;
    onUpdate(batch);
    return true;
  }, onStatusChange);
}

export function connectKlineWebSocket(market: MarketType, symbol: string, interval: string, onCandle: (candle: KlineData) => void, onStatus?: StreamStatusCallback, onResume?: () => void): WsConnection {
  return connectMarketStreams(market, [`${symbol.toLowerCase()}@kline_${interval}`], payload => {
    let valid = false;
    for (const data of unwrapPayload(payload)) {
      const k = data.k;
      if (data.e !== 'kline' || data.st === 2 || data.s !== symbol || !k || ![k.t, Number(k.o), Number(k.h), Number(k.l), Number(k.c), Number(k.v)].every(Number.isFinite) || Number(k.c) <= 0) continue;
      onCandle({ time: Math.floor(k.t / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v), lastTradeId: k.L });
      valid = true;
    }
    return valid;
  }, onStatus, onResume);
}

export async function fetchLatestPrice(symbol: string, market: MarketType): Promise<Partial<TickerData> & { symbol: string }> {
  const receivedAt = Date.now();
  const response = await fetchWithTimeout(`${getRestBase(market)}/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new Error(`Price request failed: ${response.status}`);
  const data = await response.json();
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price response');
  return { symbol, price, receivedAt, priceSource: 'rest' };
}
