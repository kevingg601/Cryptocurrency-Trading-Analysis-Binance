import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FOUR_GROUP_OLLAMA_URL,
  DEFAULT_FOUR_GROUP_PROMPT_VERSION,
  DEFAULT_FOUR_GROUP_RULE_VERSION,
  sanitizeOllamaUrl,
  type AIDataSnapshot,
  type MarketType,
} from '@fadachi/core';
import type { ExtendedAIAnalysisInput } from '@fadachi/core';
import type { DuckDBClient } from '../storage/duckdb.ts';
import type { AIDataAggregator } from './aiDataAggregator.ts';
import { OllamaProvider, type OllamaConnectionTestResult, type OllamaTelemetry } from './ollamaProvider.ts';

export interface OllamaRunnerOptions {
  client: DuckDBClient;
  provider?: OllamaProvider;
  defaultBaseUrl?: string;
  maxConcurrency?: number;
  requestTimeoutMs?: number;
}

export interface OllamaSymbolAnalysisEntry {
  analysis: ExtendedAIAnalysisInput;
  telemetry?: OllamaTelemetry;
  updatedAt: number;
}

export class OllamaAnalysisRunner {
  private readonly client: DuckDBClient;
  readonly provider: OllamaProvider;
  private readonly defaultBaseUrl: string;
  private readonly maxConcurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<OllamaSymbolAnalysisEntry>>();
  private readonly activeJobs = new Set<Promise<OllamaSymbolAnalysisEntry>>();
  private readonly latestCache = new Map<string, OllamaSymbolAnalysisEntry>();
  private readonly controller = new AbortController();

  constructor(options: OllamaRunnerOptions) {
    this.client = options.client;
    this.defaultBaseUrl = sanitizeOllamaUrl(options.defaultBaseUrl ?? DEFAULT_FOUR_GROUP_OLLAMA_URL);
    this.provider = options.provider ?? new OllamaProvider({
      baseUrl: this.defaultBaseUrl,
      analyzeTimeoutMs: options.requestTimeoutMs ?? 90_000,
    });
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 90_000);
  }

  close(): void {
    this.controller.abort();
  }

  private cacheKey(baseUrl: string, model: string, symbol: string, market: MarketType = 'futures'): string {
    return `${baseUrl}|${model}|${market}|${symbol.trim().toUpperCase()}`;
  }

  private async runLimited(work: () => Promise<OllamaSymbolAnalysisEntry>): Promise<OllamaSymbolAnalysisEntry> {
    while (this.activeJobs.size >= this.maxConcurrency) {
      await Promise.race(this.activeJobs);
    }
    this.controller.signal.throwIfAborted();
    const job = Promise.resolve().then(work);
    this.activeJobs.add(job);
    try {
      return await job;
    } finally {
      this.activeJobs.delete(job);
    }
  }

  async testConnection(baseUrl?: string, model?: string): Promise<OllamaConnectionTestResult> {
    const targetUrl = sanitizeOllamaUrl(baseUrl ?? this.defaultBaseUrl);
    return this.provider.testConnection(targetUrl, model, this.controller.signal);
  }

  async getStatus(baseUrl?: string): Promise<OllamaConnectionTestResult & {
    latestAnalyses: Record<string, ExtendedAIAnalysisInput>;
  }> {
    const conn = await this.testConnection(baseUrl);
    const latestAnalyses: Record<string, ExtendedAIAnalysisInput> = {};
    for (const [key, entry] of this.latestCache.entries()) {
      if (key.startsWith(`${conn.baseUrl}|`)) {
        latestAnalyses[entry.analysis.symbol] = structuredClone(entry.analysis);
      }
    }
    return {
      ...conn,
      latestAnalyses,
    };
  }

  getLatestFor(baseUrl: string, model: string, symbols?: string[]): Record<string, ExtendedAIAnalysisInput> {
    const cleanUrl = sanitizeOllamaUrl(baseUrl);
    const trimmedModel = model.trim();
    const out: Record<string, ExtendedAIAnalysisInput> = {};
    const wanted = symbols ? new Set(symbols.map(s => s.trim().toUpperCase())) : null;
    for (const [key, entry] of this.latestCache.entries()) {
      const sym = entry.analysis.symbol;
      if (key !== this.cacheKey(cleanUrl, trimmedModel, sym)) continue;
      if (wanted && !wanted.has(sym)) continue;
      out[sym] = structuredClone(entry.analysis);
    }
    return out;
  }

  async analyzeSymbols(params: {
    aggregator: AIDataAggregator;
    symbols: string[];
    model: string;
    baseUrl?: string;
    market?: MarketType;
    promptVersion?: string;
    ruleVersion?: string;
    now?: number;
  }): Promise<{
    baseUrl: string;
    model: string;
    results: Record<string, ExtendedAIAnalysisInput>;
    telemetries: Record<string, OllamaTelemetry>;
    errors: Record<string, string>;
  }> {
    const cleanUrl = sanitizeOllamaUrl(params.baseUrl ?? this.defaultBaseUrl);
    const model = params.model.trim();
    if (!model) {
      throw new Error('請先指定 Ollama 模型名稱');
    }
    const market = params.market ?? 'futures';
    const promptVersion = params.promptVersion ?? DEFAULT_FOUR_GROUP_PROMPT_VERSION;
    const ruleVersion = params.ruleVersion ?? DEFAULT_FOUR_GROUP_RULE_VERSION;
    const uniqueSymbols = Array.from(new Set(params.symbols.map(s => s.trim().toUpperCase()).filter(Boolean)));

    const results: Record<string, ExtendedAIAnalysisInput> = {};
    const telemetries: Record<string, OllamaTelemetry> = {};
    const errors: Record<string, string> = {};

    const queue = [...uniqueSymbols];
    const runNext = async (): Promise<void> => {
      while (queue.length > 0 && !this.controller.signal.aborted) {
        const sym = queue.shift()!;
        const flightKey = JSON.stringify([cleanUrl, model, market, promptVersion, ruleVersion, sym]);
        let promise = this.inFlight.get(flightKey);
        if (!promise) {
          promise = this.runLimited(() => this.runSingleSymbol({
            aggregator: params.aggregator,
            symbol: sym,
            market,
            baseUrl: cleanUrl,
            model,
            promptVersion,
            ruleVersion,
            now: params.now ?? Date.now(),
          }));
          this.inFlight.set(flightKey, promise);
          const cleanup = () => {
            if (this.inFlight.get(flightKey) === promise) {
              this.inFlight.delete(flightKey);
            }
          };
          void promise.then(cleanup, cleanup);
        }

        const entry = await promise;
        results[sym] = entry.analysis;
        if (entry.telemetry) telemetries[sym] = entry.telemetry;
        if (entry.analysis.failed) {
          errors[sym] = entry.analysis.reasoning;
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.maxConcurrency, uniqueSymbols.length) }, () => runNext());
    await Promise.all(workers);

    return { baseUrl: cleanUrl, model, results, telemetries, errors };
  }

  private async runSingleSymbol(params: {
    aggregator: AIDataAggregator;
    symbol: string;
    market: MarketType;
    baseUrl: string;
    model: string;
    promptVersion: string;
    ruleVersion: string;
    now: number;
  }): Promise<OllamaSymbolAnalysisEntry> {
    const cacheKey = this.cacheKey(params.baseUrl, params.model, params.symbol, params.market);
    let snapshot: AIDataSnapshot | null = null;
    try {
      snapshot = await params.aggregator.buildSnapshot(params.symbol, params.market, params.now);
      if (!snapshot.essentialDataValid) {
        // A collector restart or a candle boundary may temporarily leave the
        // first read incomplete. Rebuild once; never accept missing data.
        this.controller.signal.throwIfAborted();
        snapshot = await params.aggregator.buildSnapshot(params.symbol, params.market, Date.now());
      }
      if (!snapshot.essentialDataValid) {
        const failed = this.makeFailedResult({
          snapshot,
          symbol: params.symbol,
          market: params.market,
          model: params.model,
          promptVersion: params.promptVersion,
          ruleVersion: params.ruleVersion,
          now: params.now,
          reason: `必要市場或指標快照不完整：${snapshot.missingData.join(', ')}`,
          incompleteData: true,
        });
        const entry: OllamaSymbolAnalysisEntry = { analysis: failed, updatedAt: Date.now() };
        this.latestCache.set(cacheKey, entry);
        return entry;
      }

      const { result, telemetry } = await this.provider.analyzeSnapshot(snapshot, params.model, {
        baseUrl: params.baseUrl,
        promptVersion: params.promptVersion,
        ruleVersion: params.ruleVersion,
        signal: this.controller.signal,
        timeoutMs: this.requestTimeoutMs,
      });

      const enriched: ExtendedAIAnalysisInput = {
        ...result,
        snapshotCreatedAt: snapshot.createdAt,
        status: 'SUCCESS',
        failed: false,
      };
      await this.persistAnalysis(enriched);

      const entry: OllamaSymbolAnalysisEntry = {
        analysis: enriched,
        telemetry,
        updatedAt: Date.now(),
      };
      this.latestCache.set(cacheKey, entry);
      return entry;
    } catch (err: any) {
      const msg = err?.name === 'TimeoutError'
        ? `Ollama 推論逾時（>${this.requestTimeoutMs}ms）`
        : err?.message || 'Ollama 推論失敗';
      const failed = this.makeFailedResult({
        snapshot,
        symbol: params.symbol,
        market: params.market,
        model: params.model,
        promptVersion: params.promptVersion,
        ruleVersion: params.ruleVersion,
        now: params.now,
        reason: msg,
        incompleteData: false,
      });
      const entry: OllamaSymbolAnalysisEntry = { analysis: failed, updatedAt: Date.now() };
      this.latestCache.set(cacheKey, entry);
      return entry;
    }
  }

  private makeFailedResult(params: {
    snapshot: AIDataSnapshot | null;
    symbol: string;
    market: MarketType;
    model: string;
    promptVersion: string;
    ruleVersion: string;
    now: number;
    reason: string;
    incompleteData: boolean;
  }): ExtendedAIAnalysisInput {
    return {
      schemaVersion: 1,
      id: `ollama-fail-${randomUUID()}`,
      snapshotId: params.snapshot?.id ?? `missing-${params.symbol}-${params.now}`,
      snapshotHash: params.snapshot?.hash ?? '',
      snapshotCreatedAt: params.snapshot?.createdAt ?? params.now,
      symbol: params.symbol,
      marketType: params.market,
      model: params.model,
      promptVersion: params.promptVersion,
      ruleVersion: params.ruleVersion,
      generatedAt: Date.now(),
      expiresAt: params.snapshot?.validUntil ?? (params.now + 20 * 60_000),
      direction: 'NEUTRAL',
      confidence: 0,
      reasoning: params.reason,
      bullishEvidence: [],
      bearishEvidence: [],
      risks: [],
      missingData: params.snapshot?.missingData ?? (params.incompleteData ? ['market_price'] : []),
      degraded: params.incompleteData ? true : Boolean(params.snapshot?.degraded),
      status: params.incompleteData ? 'SUCCESS' : 'FAILED',
      failed: !params.incompleteData,
    };
  }

  private async persistAnalysis(result: ExtendedAIAnalysisInput): Promise<void> {
    try {
      await this.client.run(
        `INSERT OR REPLACE INTO ai_analysis_results
         (id, snapshot_id, symbol, market, model, direction, confidence, generated_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        result.id,
        result.snapshotId,
        result.symbol,
        result.marketType,
        result.model,
        result.direction,
        result.confidence,
        result.generatedAt,
        result.expiresAt,
        JSON.stringify(result),
      );
    } catch {
      // Do not fail live four-group execution if optional audit SQL insert hits test table subset
    }
  }
}
