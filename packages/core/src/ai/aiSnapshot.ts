import type { AIDataSnapshot, AIDataSourceHealth } from './aiTypes.ts';
import type { MarketType, KlineData } from '../market/types.ts';

// Lightweight, pure TypeScript SHA-256 implementation for synchronous hashing in Node and browser
export function sha256(input: string): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const bytes = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(input)
    : (typeof (globalThis as any).Buffer !== 'undefined'
      ? (globalThis as any).Buffer.from(input, 'utf-8')
      : new Uint8Array([...input].map(c => c.charCodeAt(0))));

  const byteLength = bytes.length;
  const bitLength = byteLength * 8;

  // 64-byte (16 32-bit words) blocks. Need 1 byte for 0x80 and 8 bytes for length
  const wordCount = (((byteLength + 9) + 63) >>> 6) << 4;
  const words = new Uint32Array(wordCount);

  for (let i = 0; i < byteLength; i++) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8);
  }
  words[byteLength >>> 2] |= 0x80 << (24 - (byteLength % 4) * 8);
  words[wordCount - 1] = bitLength >>> 0;
  words[wordCount - 2] = Math.floor(bitLength / 0x100000000) >>> 0;

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const w = new Uint32Array(64);

  for (let i = 0; i < words.length; i += 16) {
    const oldHash = [...hash];
    for (let j = 0; j < 64; j++) {
      if (j < 16) {
        w[j] = words[i + j];
      } else {
        const s0 = rightRotate(w[j - 15], 7) ^ rightRotate(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        const s1 = rightRotate(w[j - 2], 17) ^ rightRotate(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }

      const s1 = rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const temp1 = (hash[7] + s1 + ch + k[j] + w[j]) | 0;
      const s0 = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const temp2 = (s0 + maj) | 0;

      hash[7] = hash[6];
      hash[6] = hash[5];
      hash[5] = hash[4];
      hash[4] = (hash[3] + temp1) | 0;
      hash[3] = hash[2];
      hash[2] = hash[1];
      hash[1] = hash[0];
      hash[0] = (temp1 + temp2) | 0;
    }

    for (let j = 0; j < 8; j++) {
      hash[j] = (hash[j] + oldHash[j]) | 0;
    }
  }

  let result = '';
  for (let i = 0; i < 8; i++) {
    result += (hash[i] >>> 0).toString(16).padStart(8, '0');
  }

  return result;
}

export const SNAPSHOT_VALIDITY_MS = 20 * 60 * 1000; // 20 minutes

export interface CreateSnapshotInput {
  symbol: string;
  marketType: MarketType;
  cutoffTime: number;
  now?: number;
  sourceHealth?: Record<string, AIDataSourceHealth>;
  market: {
    price: number;
    priceChangePercent: number;
    volume: number;
    quoteVolume: number;
    high: number;
    low: number;
    open: number;
    priceTimestamp?: number;
  };
  klines: KlineData[];
  indicators: {
    sma20?: number;
    ema20?: number;
    rsi14?: number;
    macd?: { macd: number; signal: number; histogram: number };
    bollinger?: { upper: number; middle: number; lower: number };
  };
  derivatives?: {
    openInterest?: number | null;
    fundingRate?: number | null;
    liquidations?: Array<{
      price: number;
      quantity: number;
      side: 'buy' | 'sell';
      timestamp: number;
    }>;
  };
  news?: Array<{
    id: string;
    title: string;
    summary: string;
    link: string;
    source: string;
    publishedAt: number;
    receivedAt: number;
  }>;
  onChain?: {
    asset: string;
    activeAddresses?: number;
    txCount?: number;
    date?: string;
    isDaily: true;
    note: string;
  } | null;
}

export function createAIDataSnapshot(input: CreateSnapshotInput): AIDataSnapshot {
  const { symbol, marketType, cutoffTime, market, klines, indicators } = input;
  const createdAt = input.now ?? Date.now();
  const validUntil = cutoffTime + SNAPSHOT_VALIDITY_MS;

  const missingData: string[] = [];
  const openInterest = input.derivatives?.openInterest ?? null;
  const fundingRate = input.derivatives?.fundingRate ?? null;
  const liquidations = input.derivatives?.liquidations ?? [];
  const news = input.news ?? [];
  const onChain = input.onChain ?? null;

  // Check essential market & technical data completeness
  const marketHealth = input.sourceHealth?.market;
  const klineHealth = input.sourceHealth?.klines;
  const validHealthTime = (value: number | undefined) => value === undefined
    || (Number.isFinite(value) && value <= cutoffTime);
  const marketTimestampValid = market.priceTimestamp !== undefined
    ? Number.isFinite(market.priceTimestamp) && market.priceTimestamp <= cutoffTime
      && cutoffTime - market.priceTimestamp <= 120_000
    : marketHealth?.dataAsOf !== undefined && validHealthTime(marketHealth.dataAsOf)
      && cutoffTime - marketHealth.dataAsOf <= 120_000;
  const hasValidPrice = Number.isFinite(market.price) && market.price > 0
    && Number.isFinite(market.priceChangePercent) && Number.isFinite(market.volume) && market.volume >= 0
    && Number.isFinite(market.quoteVolume) && market.quoteVolume >= 0 && Number.isFinite(market.high)
    && Number.isFinite(market.low) && Number.isFinite(market.open) && market.low > 0
    && market.high >= Math.max(market.open, market.price, market.low)
    && market.low <= Math.min(market.open, market.price) && marketTimestampValid
    && (!marketHealth || marketHealth.status === 'healthy');
  const intervalSeconds = 60;
  const latestClosedOpen = Math.floor(cutoffTime / 60_000) * intervalSeconds - intervalSeconds;
  const validCandles = Array.isArray(klines) && klines.every((k, index) => {
    const values = [k.time, k.open, k.high, k.low, k.close, k.volume];
    return values.every(Number.isFinite) && Number.isInteger(k.time) && k.time >= 0
      && k.open > 0 && k.high > 0 && k.low > 0 && k.close > 0 && k.volume >= 0
      && k.high >= Math.max(k.open, k.close, k.low) && k.low <= Math.min(k.open, k.close)
      && k.time * 1000 + 60_000 <= cutoffTime
      && (index === 0 || (klines[index - 1].time < k.time
        && k.time - klines[index - 1].time === intervalSeconds));
  });
  const requiredCandleStart = latestClosedOpen - 19 * intervalSeconds;
  const hasRecentWindow = Array.isArray(klines) && klines.length >= 20
    && klines.at(-1)?.time === latestClosedOpen
    && klines.findIndex(k => k.time === requiredCandleStart) >= 0
    && klines.slice(klines.findIndex(k => k.time === requiredCandleStart)).length >= 20;
  const dataAsOf = klineHealth?.dataAsOf;
  const candleHealthTimeValid = dataAsOf === undefined
    ? validHealthTime(klines.at(-1) ? klines.at(-1)!.time * 1000 + 60_000 : undefined)
    : validHealthTime(dataAsOf) && cutoffTime - dataAsOf <= 120_000;
  const hasValidKlines = validCandles && hasRecentWindow && candleHealthTimeValid
    && (!klineHealth || klineHealth.status === 'healthy');
  const hasBasicIndicators = [indicators.sma20, indicators.ema20].some(value => Number.isFinite(value) && value! > 0);

  if (!hasValidPrice) missingData.push('market_price');
  if (!hasValidKlines) missingData.push('klines_sufficient');
  if (!hasBasicIndicators) missingData.push('indicators_basic');

  const sourceHealth = input.sourceHealth ? structuredClone(input.sourceHealth) : undefined;
  const sourceFreshnessMs: Record<string, number> = {
    market: 120_000, klines: 120_000, indicators: 120_000,
    liquidations: 15 * 60_000, derivatives: 15 * 60_000,
    news: 24 * 60 * 60_000, onChain: 48 * 60 * 60_000,
  };
  const contentTimestamp = (source: string): number | undefined => {
    if (source === 'market') return market.priceTimestamp;
    if (source === 'klines' || source === 'indicators') {
      const last = klines.at(-1);
      return last ? last.time * 1000 + 60_000 : undefined;
    }
    if (source === 'news') return news.length ? Math.max(...news.map(item => item.receivedAt)) : undefined;
    if (source === 'onChain' && onChain?.date) {
      const timestamp = Date.parse(`${onChain.date}T00:00:00.000Z`);
      return Number.isFinite(timestamp) ? timestamp : undefined;
    }
    if (source === 'liquidations' && liquidations.length) return Math.max(...liquidations.map(item => item.timestamp));
    return undefined;
  };
  for (const [source, health] of Object.entries(sourceHealth ?? {})) {
    const hasInvalidTime = !validHealthTime(health.lastSuccessAt) || !validHealthTime(health.lastAttemptAt)
      || !validHealthTime(health.dataAsOf);
    if (hasInvalidTime) {
      health.status = 'error';
      missingData.push(`${source}_source_invalid_time`);
    }
    if (health.status === 'healthy') {
      const asOf = health.dataAsOf ?? contentTimestamp(source) ?? health.lastSuccessAt;
      const maxAge = sourceFreshnessMs[source];
      if (asOf === undefined) health.status = 'missing';
      else if (maxAge !== undefined && cutoffTime - asOf > maxAge) health.status = 'stale';
    }
    if (health.status !== 'healthy') missingData.push(`${source}_source_${health.status}`);
  }

  if (sourceHealth) {
    for (const source of ['openInterest', 'fundingRate', 'liquidations', 'news', 'onChain']) {
      const hasHealth = sourceHealth[source] !== undefined
        || (['openInterest', 'fundingRate', 'liquidations'].includes(source) && sourceHealth.derivatives !== undefined);
      if (!hasHealth && contentTimestamp(source) === undefined) missingData.push(`${source}_source_unverified`);
    }
  }

  const essentialDataValid = hasValidPrice && hasValidKlines && Boolean(hasBasicIndicators)
    && !missingData.some(key => ['market', 'klines', 'indicators'].some(source => key.startsWith(`${source}_source_`)));

  if (marketType === 'futures') {
    if (openInterest === null) missingData.push('open_interest');
    if (fundingRate === null) missingData.push('funding_rate');
    const liquidationFeedHealthy = sourceHealth?.liquidations?.status === 'healthy'
      || sourceHealth?.derivatives?.status === 'healthy';
    if (liquidations.length === 0 && !liquidationFeedHealthy) missingData.push('liquidations_stream');
  }

  // Check optional news
  if (news.length === 0) missingData.push('news_feed');

  // Check optional on-chain
  if (!onChain) missingData.push('onchain_metrics');

  const degraded = missingData.length > 0;
  const sourceIsHealthy = (name: string, present: boolean, allowHealthyEmpty = false) => {
    const health = sourceHealth?.[name]?.status
      ?? (['openInterest', 'fundingRate', 'liquidations'].includes(name) ? sourceHealth?.derivatives?.status : undefined);
    if (health !== undefined) {
      const metadata = sourceHealth?.[name]
        ?? (['openInterest', 'fundingRate', 'liquidations'].includes(name) ? sourceHealth?.derivatives : undefined);
      const timesValid = metadata && [metadata.lastSuccessAt, metadata.lastAttemptAt, metadata.dataAsOf]
        .every(validHealthTime);
      return health === 'healthy' && Boolean(timesValid) && (present || allowHealthyEmpty);
    }
    if (!sourceHealth) return present;
    const asOf = contentTimestamp(name);
    const maxAge = sourceFreshnessMs[name];
    return present && asOf !== undefined && validHealthTime(asOf)
      && (maxAge === undefined || cutoffTime - asOf <= maxAge);
  };

  // Build canonical payload for deterministic hashing
  const canonicalPayload = JSON.stringify({
    symbol,
    marketType,
    cutoffTime,
    market,
    klines,
    indicators,
    openInterest,
    fundingRate,
    liquidations,
    news,
    onChain,
    sourceHealth,
  });

  const hash = sha256(canonicalPayload);

  return structuredClone({
    schemaVersion: 1,
    id: `snap-${marketType}-${symbol}-${cutoffTime}-${hash.slice(0, 16)}`,
    symbol,
    marketType,
    cutoffTime,
    validUntil,
    createdAt,
    hash,
    essentialDataValid,
    degraded,
    missingData,
    sourceHealth,
    sources: {
      market: hasValidPrice,
      klines: hasValidKlines,
      indicators: sourceIsHealthy('indicators', Boolean(hasBasicIndicators)),
      openInterest: sourceIsHealthy('openInterest', openInterest !== null),
      fundingRate: sourceIsHealthy('fundingRate', fundingRate !== null),
      liquidations: sourceIsHealthy('liquidations', liquidations.length > 0, true),
      news: sourceIsHealthy('news', news.length > 0),
      onChain: sourceIsHealthy('onChain', Boolean(onChain)),
    },
    market: { ...market },
    klines: [...klines],
    indicators: { ...indicators },
    derivatives: {
      openInterest,
      fundingRate,
      liquidations: [...liquidations],
    },
    news: [...news],
    onChain: onChain ? { ...onChain } : null,
  });
}

export function isSnapshotValid(snapshot: AIDataSnapshot, now: number): boolean {
  const essentialSources = ['market', 'klines', 'indicators'];
  const healthValid = Object.entries(snapshot.sourceHealth ?? {}).every(([name, source]) => {
    const timesValid = [source.lastSuccessAt, source.lastAttemptAt, source.dataAsOf].every(time => time === undefined
      || (Number.isFinite(time) && time <= snapshot.cutoffTime));
    return timesValid && (!essentialSources.includes(name) || source.status === 'healthy');
  });
  return snapshot.essentialDataValid && healthValid && now <= snapshot.validUntil && now >= snapshot.cutoffTime;
}
