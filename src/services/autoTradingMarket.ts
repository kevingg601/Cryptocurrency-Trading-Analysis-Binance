import type { MarketType } from './binance';

export interface AutoSymbolRules {
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
  maxNotional?: number;
}

export interface AutoFundingRecord {
  symbol: string;
  fundingTime: number;
  fundingRate: number;
  markPrice: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAutoSymbol(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}]+USDT$/u.test(value) && !/[a-z]/.test(value);
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return NaN;
  const result = Number(value);
  return Number.isFinite(result) ? result : NaN;
}

function restBase(market: MarketType): string {
  if (market === 'spot') return 'https://api.binance.com/api/v3';
  if (market === 'futures') return 'https://fapi.binance.com/fapi/v1';
  throw new Error('Invalid auto-trading market');
}

async function fetchPublicJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Binance public market request failed: HTTP ${response.status}`);
  return response.json();
}

function commonStepSize(first: number, second: number): number {
  // Intersect decimal quantity grids using integer LCM, without float modulo.
  const decimal = (value: number) => {
    const [mantissa, exponent] = value.toExponential().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { coefficient: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
  };
  const a = decimal(first);
  const b = decimal(second);
  const exponent = Math.min(a.exponent, b.exponent);
  const left = a.coefficient * 10n ** BigInt(a.exponent - exponent);
  const right = b.coefficient * 10n ** BigInt(b.exponent - exponent);
  let divisor = left;
  let remainder = right;
  while (remainder !== 0n) [divisor, remainder] = [remainder, divisor % remainder];
  return Number(`${left / divisor * right}e${exponent}`);
}

function parseRules(filters: unknown[], market: MarketType): AutoSymbolRules | null {
  const byType = new Map<string, Record<string, unknown>>();
  for (const filter of filters) {
    if (!isRecord(filter) || typeof filter.filterType !== 'string' || byType.has(filter.filterType)) return null;
    byType.set(filter.filterType, filter);
  }
  const lot = byType.get('LOT_SIZE');
  const marketLot = byType.get('MARKET_LOT_SIZE');
  if (!lot && !marketLot) return null;
  let stepSize = 0;
  let minQty = 0;
  let maxQty = Infinity;
  for (const filter of [lot, marketLot]) {
    if (!filter) continue;
    const step = numeric(filter.stepSize);
    const min = numeric(filter.minQty);
    const max = numeric(filter.maxQty);
    if (![step, min, max].every(value => Number.isFinite(value) && value >= 0)
      || (filter === lot && (step === 0 || max === 0)) || (max > 0 && max < min)) return null;
    // Zero market fields add no constraint; LOT_SIZE still governs quantity.
    if (step > 0) stepSize = stepSize > 0 ? commonStepSize(stepSize, step) : step;
    minQty = Math.max(minQty, min);
    if (max > 0) maxQty = Math.min(maxQty, max);
  }
  if (![stepSize, minQty, maxQty].every(Number.isFinite)
    || !(stepSize > 0 && minQty >= 0 && maxQty > 0 && maxQty >= minQty && maxQty >= stepSize)) return null;

  const minimum = byType.get('MIN_NOTIONAL');
  const notional = byType.get('NOTIONAL');
  if (!minimum && !notional) return null;
  let minNotional = 0;
  let maxNotional: number | undefined;
  if (minimum) {
    const value = numeric(market === 'futures' ? minimum.notional : minimum.minNotional);
    if (!(value >= 0) || (market === 'spot' && typeof minimum.applyToMarket !== 'boolean')) return null;
    if (market === 'futures' || minimum.applyToMarket === true) minNotional = value;
  }
  if (notional) {
    const min = numeric(notional.minNotional);
    const max = numeric(notional.maxNotional);
    if (!(min >= 0 && max > 0 && max >= min)
      || typeof notional.applyMinToMarket !== 'boolean'
      || typeof notional.applyMaxToMarket !== 'boolean') return null;
    if (notional.applyMinToMarket) minNotional = Math.max(minNotional, min);
    if (notional.applyMaxToMarket) maxNotional = max;
  }
  if (maxNotional !== undefined && maxNotional < minNotional) return null;
  return { stepSize, minQty, maxQty, minNotional, ...(maxNotional === undefined ? {} : { maxNotional }) };
}

export function parseAutoSymbolRules(payload: unknown, market: MarketType): Record<string, AutoSymbolRules> {
  restBase(market);
  if (!isRecord(payload) || !Array.isArray(payload.symbols)) throw new Error('Malformed Binance exchangeInfo response');
  const result: Record<string, AutoSymbolRules> = {};
  const seen = new Set<string>();
  for (const entry of payload.symbols) {
    if (!isRecord(entry) || !isAutoSymbol(entry.symbol)
      || entry.status !== 'TRADING' || entry.quoteAsset !== 'USDT'
      || (market === 'futures' && entry.contractType !== 'PERPETUAL')
      || (market === 'spot' && entry.isSpotTradingAllowed === false)) continue;
    if (seen.has(entry.symbol)) {
      delete result[entry.symbol];
      continue;
    }
    seen.add(entry.symbol);
    if (!Array.isArray(entry.filters)) continue;
    const rules = parseRules(entry.filters, market);
    if (rules) result[entry.symbol] = rules;
  }
  return result;
}

export async function fetchAutoSymbolRules(market: MarketType): Promise<Record<string, AutoSymbolRules>> {
  return parseAutoSymbolRules(await fetchPublicJson(`${restBase(market)}/exchangeInfo`), market);
}

export function parseAutoFundingHistory(payload: unknown): AutoFundingRecord[] {
  if (!Array.isArray(payload)) throw new Error('Malformed Binance funding history response');
  return payload.map((entry, index) => {
    if (!isRecord(entry) || !isAutoSymbol(entry.symbol)
      || typeof entry.fundingTime !== 'number' || !Number.isSafeInteger(entry.fundingTime) || entry.fundingTime < 0) {
      throw new Error(`Malformed Binance funding record at index ${index}`);
    }
    const fundingRate = numeric(entry.fundingRate);
    const markPrice = numeric(entry.markPrice);
    if (!Number.isFinite(fundingRate) || !(markPrice > 0)) throw new Error(`Invalid fundingRate or markPrice at index ${index}`);
    return { symbol: entry.symbol, fundingTime: entry.fundingTime, fundingRate, markPrice };
  });
}

export async function fetchAutoFundingHistory(symbol: string, startTime: number, endTime: number): Promise<AutoFundingRecord[]> {
  if (!isAutoSymbol(symbol) || !Number.isSafeInteger(startTime) || startTime < 0
    || !Number.isSafeInteger(endTime) || endTime < startTime) throw new Error('Invalid funding history symbol or time range');
  const records: AutoFundingRecord[] = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const query = new URLSearchParams({ symbol, startTime: String(cursor), endTime: String(endTime), limit: '1000' });
    const page = parseAutoFundingHistory(await fetchPublicJson(`${restBase('futures')}/fundingRate?${query}`));
    if (page.length === 0) break;
    let previousTime = cursor - 1;
    for (const record of page) {
      if (record.symbol !== symbol || record.fundingTime < cursor || record.fundingTime > endTime
        || record.fundingTime <= previousTime) throw new Error('Funding history is outside the requested range or not strictly ascending');
      previousTime = record.fundingTime;
      records.push(record);
    }
    if (previousTime === endTime) break;
    cursor = previousTime + 1;
  }
  return records;
}

export async function fetchAutoServerTime(market: MarketType): Promise<number> {
  const payload = await fetchPublicJson(`${restBase(market)}/time`);
  if (!isRecord(payload) || typeof payload.serverTime !== 'number'
    || !Number.isSafeInteger(payload.serverTime) || payload.serverTime <= 0) throw new Error('Malformed Binance serverTime response');
  return payload.serverTime;
}
