import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fetchAutoFundingHistory, type AutoFundingRecord } from '@fadachi/core';
import type { DuckDBClient } from '../storage/duckdb.ts';

const ONE_HOUR_MS = 3_600_000;
const EIGHT_DAYS_MS = 8 * 24 * ONE_HOUR_MS;

export const KLINES_1H_CSV_COLUMNS = [
  'symbol',
  'open_time',
  'close_time',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'quote_volume',
  'trades',
  'taker_buy_base',
  'taker_buy_quote',
  'is_final',
  'source',
] as const;

export const FUNDING_RATES_CSV_COLUMNS = [
  'symbol',
  'funding_time',
  'funding_rate',
  'mark_price',
  'source',
] as const;

export class DataNotReadyError extends Error {
  readonly code = 'DATA_NOT_READY';
  readonly missingSymbols: string[];

  constructor(message: string, missingSymbols: string[] = []) {
    super(message);
    this.name = 'DataNotReadyError';
    this.missingSymbols = missingSymbols;
  }
}

export interface MarketCacheUpdaterOptions {
  dataDir: string;
  client?: DuckDBClient;
  fetchImpl?: typeof fetch;
  fetchFundingHistory?: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  baseKlinesParquetPath?: string;
  baseFundingParquetPath?: string;
  cacheDir?: string;
}

export interface MarketCacheUpdateResult {
  klinesCsvPath: string;
  fundingCsvPath: string;
  baseKlinesParquetPath: string;
  addedKlineRows: number;
  addedFundingRows: number;
  targetHour: number;
}

export class MarketCacheUpdater {
  readonly dataDir: string;
  readonly client?: DuckDBClient;
  readonly fetchImpl: typeof fetch;
  readonly fetchFundingHistory: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  readonly baseKlinesParquetPath: string;
  readonly baseFundingParquetPath: string;
  readonly cacheDir: string;
  readonly klinesCsvPath: string;
  readonly fundingCsvPath: string;

  private parquetKlinesMaxOpen: Map<string, number> | null = null;
  private parquetFundingMaxTime: Map<string, number> | null = null;

  constructor(options: MarketCacheUpdaterOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.client = options.client;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.fetchFundingHistory = options.fetchFundingHistory ?? fetchAutoFundingHistory;
    this.baseKlinesParquetPath = options.baseKlinesParquetPath
      ? path.resolve(options.baseKlinesParquetPath)
      : path.join(this.dataDir, 'model-research', 'datasets', 'klines_1h.parquet');
    this.baseFundingParquetPath = options.baseFundingParquetPath
      ? path.resolve(options.baseFundingParquetPath)
      : path.join(this.dataDir, 'model-research', 'datasets', 'funding_rates.parquet');
    this.cacheDir = options.cacheDir
      ? path.resolve(options.cacheDir)
      : path.join(this.dataDir, 'model-paper', 'market-cache');
    this.klinesCsvPath = path.join(this.cacheDir, 'klines_1h.csv');
    this.fundingCsvPath = path.join(this.cacheDir, 'funding_rates.csv');
  }

  private async loadParquetMaxTimes(
    parquetPath: string,
    timeCol: string,
    cached: Map<string, number> | null,
  ): Promise<Map<string, number>> {
    if (cached) return cached;
    const map = new Map<string, number>();
    if (!this.client || !fs.existsSync(parquetPath)) {
      return map;
    }
    try {
      const rows = await this.client.all<{ symbol: string; max_t: number }>(
        `SELECT symbol, MAX(${timeCol}) AS max_t FROM read_parquet(?) GROUP BY symbol;`,
        parquetPath,
      );
      for (const r of rows) {
        const t = Number(r.max_t);
        if (typeof r.symbol === 'string' && Number.isFinite(t)) {
          map.set(r.symbol, t);
        }
      }
    } catch {
      /* ignore if parquet reader unavailable in unit tests */
    }
    return map;
  }

  private async readCsvIndex(
    csvPath: string,
    expectedHeader: readonly string[],
  ): Promise<{ keys: Set<string>; maxTimeBySymbol: Map<string, number> }> {
    const keys = new Set<string>();
    const maxTimeBySymbol = new Map<string, number>();

    if (!fs.existsSync(csvPath)) {
      return { keys, maxTimeBySymbol };
    }

    const content = await fsp.readFile(csvPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (i === 0) {
        if (line !== expectedHeader.join(',')) {
          throw new Error(`快取 CSV 欄位標頭與規格不符：${csvPath}`);
        }
        continue;
      }
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const sym = parts[0];
      const ts = Number(parts[1]);
      if (!sym || !Number.isFinite(ts)) continue;
      keys.add(`${sym}:${ts}`);
      const prev = maxTimeBySymbol.get(sym);
      if (prev === undefined || ts > prev) {
        maxTimeBySymbol.set(sym, ts);
      }
    }
    return { keys, maxTimeBySymbol };
  }

  private async appendCsvLines(
    csvPath: string,
    header: readonly string[],
    lines: string[],
  ): Promise<void> {
    await fsp.mkdir(path.dirname(csvPath), { recursive: true });
    if (!fs.existsSync(csvPath)) {
      await fsp.writeFile(csvPath, header.join(',') + '\n', 'utf8');
    }
    if (lines.length > 0) {
      await fsp.appendFile(csvPath, lines.join('\n') + '\n', 'utf8');
    }
  }

  async update(
    universeSymbols: string[],
    targetHourH: number,
    now: number,
  ): Promise<MarketCacheUpdateResult> {
    const symbols = Array.from(new Set(universeSymbols.map(s => s.trim().toUpperCase()).filter(Boolean)));
    const targetCutoffTime = targetHourH + ONE_HOUR_MS;

    this.parquetKlinesMaxOpen = await this.loadParquetMaxTimes(
      this.baseKlinesParquetPath,
      'open_time',
      this.parquetKlinesMaxOpen,
    );
    this.parquetFundingMaxTime = await this.loadParquetMaxTimes(
      this.baseFundingParquetPath,
      'funding_time',
      this.parquetFundingMaxTime,
    );

    const klineIdx = await this.readCsvIndex(this.klinesCsvPath, KLINES_1H_CSV_COLUMNS);
    const newKlineLines: string[] = [];
    const missingTargetSymbols: string[] = [];

    for (const symbol of symbols) {
      const csvMax = klineIdx.maxTimeBySymbol.get(symbol);
      const pqMax = this.parquetKlinesMaxOpen.get(symbol);
      const lastOpen = Math.max(csvMax ?? -Infinity, pqMax ?? -Infinity);
      let cursor = Number.isFinite(lastOpen) ? lastOpen + ONE_HOUR_MS : targetHourH - 256 * ONE_HOUR_MS;

      while (cursor <= targetHourH) {
        const params = new URLSearchParams({
          symbol,
          interval: '1h',
          startTime: String(cursor),
          endTime: String(targetCutoffTime - 1),
          limit: '1500',
        });
        const url = `https://fapi.binance.com/fapi/v1/klines?${params.toString()}`;
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          throw new Error(`Binance 1h K 線查詢失敗 (${symbol}): HTTP ${res.status}`);
        }
        const batch = (await res.json()) as any[];
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }

        let lastBatchOpen = -1;
        for (const item of batch) {
          if (!Array.isArray(item) || item.length < 11) continue;
          const openTime = Number(item[0]);
          const open = Number(item[1]);
          const high = Number(item[2]);
          const low = Number(item[3]);
          const close = Number(item[4]);
          const volume = Number(item[5]);
          const closeTime = Number(item[6]);
          const quoteVolume = Number(item[7]);
          const trades = Math.trunc(Number(item[8]) || 0);
          const takerBuyBase = Number(item[9]) || 0;
          const takerBuyQuote = Number(item[10]) || 0;

          if (openTime > lastBatchOpen) lastBatchOpen = openTime;

          // Strictly retain only closed bars whose closeTime < now and <= targetCutoffTime - 1
          if (
            !Number.isSafeInteger(openTime) ||
            openTime % ONE_HOUR_MS !== 0 ||
            !Number.isSafeInteger(closeTime) ||
            closeTime >= now ||
            openTime + ONE_HOUR_MS > targetCutoffTime ||
            ![open, high, low, close, volume, quoteVolume].every(Number.isFinite) ||
            open <= 0 ||
            close <= 0 ||
            low <= 0 ||
            high < low
          ) {
            continue;
          }

          const key = `${symbol}:${openTime}`;
          if (pqMax !== undefined && openTime <= pqMax) {
            continue;
          }
          if (!klineIdx.keys.has(key)) {
            klineIdx.keys.add(key);
            const prevMax = klineIdx.maxTimeBySymbol.get(symbol);
            if (prevMax === undefined || openTime > prevMax) {
              klineIdx.maxTimeBySymbol.set(symbol, openTime);
            }
            newKlineLines.push(
              [
                symbol,
                openTime,
                closeTime,
                open,
                high,
                low,
                close,
                volume,
                quoteVolume,
                trades,
                takerBuyBase,
                takerBuyQuote,
                'true',
                'binance_rest_1h',
              ].join(','),
            );
          }
        }

        if (batch.length < 1500 || lastBatchOpen < cursor) {
          break;
        }
        cursor = lastBatchOpen + ONE_HOUR_MS;
      }

      const hasTargetInCsv = klineIdx.keys.has(`${symbol}:${targetHourH}`);
      const hasTargetInPq = pqMax !== undefined && pqMax >= targetHourH;
      if (!hasTargetInCsv && !hasTargetInPq) {
        missingTargetSymbols.push(symbol);
      }
    }

    await this.appendCsvLines(this.klinesCsvPath, KLINES_1H_CSV_COLUMNS, newKlineLines);

    // Update funding_rates.csv
    const fundingIdx = await this.readCsvIndex(this.fundingCsvPath, FUNDING_RATES_CSV_COLUMNS);
    const newFundingLines: string[] = [];

    for (const symbol of symbols) {
      const csvMax = fundingIdx.maxTimeBySymbol.get(symbol);
      const pqMax = this.parquetFundingMaxTime.get(symbol);
      const lastFunding = Math.max(csvMax ?? -Infinity, pqMax ?? -Infinity);
      const startMs = Number.isFinite(lastFunding)
        ? lastFunding + 1
        : Math.max(0, targetCutoffTime - EIGHT_DAYS_MS);
      if (startMs > now) continue;

      try {
        const records = await this.fetchFundingHistory(symbol, startMs, Math.floor(now));
        for (const r of records) {
          if (r.fundingTime > now) continue;
          if (pqMax !== undefined && r.fundingTime <= pqMax) continue;
          const key = `${symbol}:${r.fundingTime}`;
          if (fundingIdx.keys.has(key)) continue;
          fundingIdx.keys.add(key);
          const prev = fundingIdx.maxTimeBySymbol.get(symbol);
          if (prev === undefined || r.fundingTime > prev) {
            fundingIdx.maxTimeBySymbol.set(symbol, r.fundingTime);
          }
          newFundingLines.push(
            [symbol, r.fundingTime, r.fundingRate, r.markPrice, 'binance_rest_funding'].join(','),
          );
        }
      } catch (err) {
        console.warn(`[ModelPaper] 更新 ${symbol} 歷史資金費率快取失敗:`, err);
      }
    }

    await this.appendCsvLines(this.fundingCsvPath, FUNDING_RATES_CSV_COLUMNS, newFundingLines);

    if (missingTargetSymbols.length > 0) {
      throw new DataNotReadyError(
        `以下標的尚未取得決策小時 ${targetHourH} 之已收盤 1h K 線：${missingTargetSymbols.join(', ')}`,
        missingTargetSymbols,
      );
    }

    return {
      klinesCsvPath: this.klinesCsvPath,
      fundingCsvPath: this.fundingCsvPath,
      baseKlinesParquetPath: this.baseKlinesParquetPath,
      addedKlineRows: newKlineLines.length,
      addedFundingRows: newFundingLines.length,
      targetHour: targetHourH,
    };
  }
}
