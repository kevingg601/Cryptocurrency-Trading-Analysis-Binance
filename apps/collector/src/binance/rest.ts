import type { MarketType } from './streams.ts';

const SPOT_REST_BASE = 'https://api.binance.com/api/v3';
const FUTURES_REST_BASE = 'https://fapi.binance.com/fapi/v1';

export interface BinanceRateLimitInfo {
  usedWeight1m: number;
}

let lastUsedWeight1m = 0;

export function getLastUsedWeight(): number {
  return lastUsedWeight1m;
}

function getBase(market: MarketType): string {
  return market === 'spot' ? SPOT_REST_BASE : FUTURES_REST_BASE;
}

async function requestWithRateLimit(url: string, timeoutMs = 5000, signal?: AbortSignal): Promise<any> {
  // If used weight is high (> 800 out of 1200), delay slightly
  if (lastUsedWeight1m > 800) {
    await new Promise(r => setTimeout(r, 200));
  }

  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const weightHeader = res.headers.get('x-mbx-used-weight-1m');
  if (weightHeader) {
    lastUsedWeight1m = parseInt(weightHeader, 10);
  }

  if (!res.ok) {
    throw new Error(`Binance REST request failed: ${res.status} ${res.statusText}`);
  }

  return await res.json();
}

export async function fetchExchangeInfo(market: MarketType = 'futures'): Promise<any> {
  const url = `${getBase(market)}/exchangeInfo`;
  return requestWithRateLimit(url, 10000);
}

export async function fetch24hTickers(market: MarketType = 'futures'): Promise<any[]> {
  const url = `${getBase(market)}/ticker/24hr`;
  return requestWithRateLimit(url, 10000);
}

export async function fetchHistoricalKlines(
  market: MarketType,
  symbol: string,
  interval: string,
  startTime?: number,
  endTime?: number,
  limit: number = 500,
  signal?: AbortSignal
): Promise<any[]> {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });

  if (startTime !== undefined) params.set('startTime', String(startTime));
  if (endTime !== undefined) params.set('endTime', String(endTime));

  const url = `${getBase(market)}/klines?${params.toString()}`;
  return requestWithRateLimit(url, 5000, signal);
}

export async function fetchHistoricalAggTrades(
  market: MarketType,
  symbol: string,
  fromId?: number,
  startTime?: number,
  endTime?: number,
  limit: number = 500,
  signal?: AbortSignal
): Promise<any[]> {
  const params = new URLSearchParams({
    symbol,
    limit: String(limit),
  });

  if (fromId !== undefined) params.set('fromId', String(fromId));
  if (startTime !== undefined) params.set('startTime', String(startTime));
  if (endTime !== undefined) params.set('endTime', String(endTime));

  const url = `${getBase(market)}/aggTrades?${params.toString()}`;
  return requestWithRateLimit(url, 5000, signal);
}
