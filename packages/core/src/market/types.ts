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

export interface WsConnection {
  close: () => void;
  reconnect: () => void;
}

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
