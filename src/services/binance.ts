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
}

export interface AggregateTradeData {
  symbol: string;
  price: number;
  quantity: number;
  quoteValue: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

export interface KlineData {
  time: number; // unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

interface BinanceAggregateTradePayload {
  e?: string;
  s?: string;
  p?: string;
  q?: string;
  m?: boolean;
  T?: number;
}

// Subscribe to aggregate trades for the most liquid symbols. Binance's `m`
// flag identifies whether the buyer was the maker, allowing taker-side inference.
export function connectAggregateTradeWebSocket(
  marketType: MarketType,
  symbols: string[],
  onTrade: (trade: AggregateTradeData) => void
): WsConnection {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let active = true;

  const monitoredSymbols = Array.from(new Set(symbols)).slice(0, 60);

  const connect = () => {
    if (!active || monitoredSymbols.length === 0) return;

    ws?.close();
    attempts += 1;

    const host = marketType === 'spot'
      ? 'wss://stream.binance.com:9443'
      : 'wss://fstream.binance.com';
    const streams = monitoredSymbols
      .map((symbol) => `${symbol.toLowerCase()}@aggTrade`)
      .join('/');

    ws = new WebSocket(`${host}/stream?streams=${streams}`);

    ws.onopen = () => {
      attempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as {
          data?: BinanceAggregateTradePayload;
        } & BinanceAggregateTradePayload;
        const data = parsed.data ?? parsed;
        const price = Number(data.p);
        const quantity = Number(data.q);

        if (
          data.e !== 'aggTrade' ||
          !data.s?.endsWith('USDT') ||
          !Number.isFinite(price) ||
          !Number.isFinite(quantity)
        ) {
          return;
        }

        onTrade({
          symbol: data.s,
          price,
          quantity,
          quoteValue: price * quantity,
          side: data.m ? 'sell' : 'buy',
          timestamp: data.T ?? Date.now(),
        });
      } catch (error) {
        console.error(`Error parsing ${marketType} aggregate trade:`, error);
      }
    };

    ws.onclose = () => {
      if (!active) return;
      const delay = Math.min(1000 * (2 ** Math.max(attempts - 1, 0)), 30000);
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    close: () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
    reconnect: () => {
      attempts = 0;
      connect();
    },
  };
}

// Connect to Binance All Tickers WebSocket Stream (Spot or Futures) with auto-reconnect
export function connectTickerWebSocket(
  marketType: MarketType = 'spot',
  onUpdate: (data: Array<Partial<TickerData> & { symbol: string }>) => void,
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected', attempts: number) => void,
  symbols: string[] = []
): WsConnection {
  let ws: WebSocket | null = null;
  let reconnectTimer: any = null;
  let attempts = 0;
  let active = true;

  const connect = () => {
    if (!active) return;
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        // Ignore
      }
    }

    attempts++;
    if (onStatusChange) {
      onStatusChange('connecting', attempts);
    }
    
    let wsUrl = '';
    if (marketType === 'futures') {
      // Futures: /market/ws/!ticker@arr works perfectly
      wsUrl = `wss://fstream.binance.com/market/ws/!ticker@arr`;
    } else {
      // Spot: /ws/!ticker@arr is silent/blocked. Use combined streams for specified symbols
      const list = symbols.length > 0 ? symbols : FALLBACK_COINS.map(c => c.symbol);
      const streams = list.map(s => `${s.toLowerCase()}@ticker`).join('/');
      wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    }

    console.log(`Connecting to ${marketType} WebSocket: ${wsUrl} (Attempt ${attempts})...`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (!active) {
        ws?.close();
        return;
      }
      attempts = 0;
      console.log(`Successfully connected to ${marketType} WebSocket.`);
      if (onStatusChange) {
        onStatusChange('connected', 0);
      }
    };

    ws.onmessage = (event) => {
      if (!active) return;
      try {
        const payload = JSON.parse(event.data);
        let rawUpdates: any[] = [];

        if (Array.isArray(payload)) {
          // Futures raw array
          rawUpdates = payload;
        } else if (payload.data) {
          // Spot combined stream wrapper
          rawUpdates = [payload.data];
        } else if (payload.s) {
          // Raw single ticker fallback
          rawUpdates = [payload];
        }

        if (rawUpdates.length > 0) {
          // Filter tickers for USDT symbols
          const usdtUpdates = rawUpdates.filter((item: any) => item.s && item.s.endsWith('USDT'));
          
          const mapped = usdtUpdates.map((d: any) => ({
            symbol: d.s, // Symbol name e.g. BTCUSDT
            price: parseFloat(d.c),
            priceChangePercent: parseFloat(d.P),
            high: parseFloat(d.h),
            low: parseFloat(d.l),
            volume: parseFloat(d.v),
            quoteVolume: parseFloat(d.q),
          }));

          if (mapped.length > 0) {
            onUpdate(mapped);
          }
        }
      } catch (e) {
        console.error(`Error parsing ${marketType} WebSocket message:`, e);
      }
    };

    ws.onerror = (err) => {
      console.error(`${marketType} WebSocket error:`, err);
    };

    ws.onclose = (event) => {
      if (!active) return;
      console.log(`${marketType} WebSocket closed (code: ${event.code}).`);
      if (onStatusChange) {
        onStatusChange('disconnected', attempts);
      }
      
      // Reconnect with exponential backoff (max 30s)
      const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
      console.log(`Reconnecting to ${marketType} WebSocket in ${delay}ms...`);
      
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connect();
      }, delay);
    };
  };

  connect();

  return {
    close: () => {
      active = false;
      clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          // Ignore
        }
      }
    },
    reconnect: () => {
      attempts = 0;
      connect();
    }
  };
}
