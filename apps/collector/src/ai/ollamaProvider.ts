import {
  DEFAULT_FOUR_GROUP_OLLAMA_URL,
  DEFAULT_FOUR_GROUP_PROMPT_VERSION,
  DEFAULT_FOUR_GROUP_RULE_VERSION,
  isRemoteOllamaUrl,
  sanitizeOllamaUrl,
  validateAIModelOutput,
  type AIAnalysisResult,
  type AIDataSnapshot,
} from '@fadachi/core';
import type { AnalysisProvider } from './cliRunner.ts';

export interface OllamaModelTag {
  name: string;
  model: string;
  size?: number;
  modifiedAt?: string;
  details?: Record<string, unknown>;
}

export interface OllamaPsModel {
  name: string;
  model: string;
  size?: number;
  sizeVram?: number;
}

export interface OllamaConnectionTestResult {
  reachable: boolean;
  baseUrl: string;
  isRemote: boolean;
  models: string[];
  tagDetails: OllamaModelTag[];
  runningModels: OllamaPsModel[];
  hasRequestedModel?: boolean;
  latencyMs: number;
  error?: string;
}

export interface OllamaTelemetry {
  elapsedMs: number;
  evalCount?: number;
  evalDurationMs?: number;
  promptEvalCount?: number;
  totalDurationMs?: number;
  modelMemoryMb?: number | null;
  modelVramMb?: number | null;
  baseUrl: string;
  isRemote: boolean;
}

export interface OllamaAnalyzeOutput {
  result: AIAnalysisResult;
  telemetry: OllamaTelemetry;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaProviderOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  tagsTimeoutMs?: number;
  analyzeTimeoutMs?: number;
  promptVersion?: string;
  ruleVersion?: string;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function buildOllamaMarketPrompt(snapshot: AIDataSnapshot): { system: string; user: string } {
  const system = [
    'You are a strict cryptocurrency futures quantitative analyst.',
    'Analyze ONLY the provided summarized snapshot and respond ONLY with a valid JSON object.',
    'Required JSON schema:',
    '{"direction":"LONG"|"SHORT"|"NEUTRAL","confidence":0-100,"reasoning":"concise explanation","bullishEvidence":["..."],"bearishEvidence":["..."],"risks":["..."]}',
    'Rules:',
    '- Return NEUTRAL when trend or signals conflict or data confidence is low.',
    '- NEVER output or modify stopLoss, takeProfit, leverage, quantity, or position sizing fields.',
  ].join('\n');

  const compactSnapshot = {
    symbol: snapshot.symbol,
    marketType: snapshot.marketType,
    cutoffTimeIso: new Date(snapshot.cutoffTime).toISOString(),
    essentialDataValid: snapshot.essentialDataValid,
    degraded: snapshot.degraded,
    missingData: snapshot.missingData,
    market: snapshot.market,
    recent1mCandles: snapshot.klines.slice(-20),
    indicators: snapshot.indicators,
    derivatives: {
      openInterest: snapshot.derivatives.openInterest,
      fundingRate: snapshot.derivatives.fundingRate,
      recentLiquidationCount: snapshot.derivatives.liquidations.length,
    },
    newsHeadlines: snapshot.news.slice(0, 5).map(n => ({ title: n.title, source: n.source, publishedAt: n.publishedAt })),
    onChain: snapshot.onChain,
  };

  return {
    system,
    user: JSON.stringify(compactSnapshot),
  };
}

export class OllamaProvider implements AnalysisProvider {
  private readonly defaultBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tagsTimeoutMs: number;
  private readonly analyzeTimeoutMs: number;
  private readonly promptVersion: string;
  private readonly ruleVersion: string;

  constructor(options: OllamaProviderOptions = {}) {
    this.defaultBaseUrl = sanitizeOllamaUrl(options.baseUrl ?? DEFAULT_FOUR_GROUP_OLLAMA_URL);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.tagsTimeoutMs = Math.max(500, options.tagsTimeoutMs ?? 5_000);
    this.analyzeTimeoutMs = Math.max(1_000, options.analyzeTimeoutMs ?? 30_000);
    this.promptVersion = options.promptVersion ?? DEFAULT_FOUR_GROUP_PROMPT_VERSION;
    this.ruleVersion = options.ruleVersion ?? DEFAULT_FOUR_GROUP_RULE_VERSION;
  }

  /**
   * Notice: OllamaProvider handles local/remote Ollama endpoints ONLY.
   * It intentionally NEVER satisfies or alters AntigravityProvider's CLI profile isolation status.
   */
  async verifyIsolation(): Promise<{ verified: boolean; reason?: string }> {
    const check = await this.testConnection(this.defaultBaseUrl);
    if (!check.reachable) {
      return { verified: false, reason: check.error || '無法連線 Ollama API' };
    }
    return {
      verified: true,
      reason: check.isRemote ? `遠端 Ollama (${check.baseUrl})` : `本機 Ollama (${check.baseUrl})`,
    };
  }

  async getTags(baseUrl = this.defaultBaseUrl, signal?: AbortSignal): Promise<OllamaModelTag[]> {
    const cleanUrl = sanitizeOllamaUrl(baseUrl);
    const reqSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.tagsTimeoutMs)])
      : AbortSignal.timeout(this.tagsTimeoutMs);

    const res = await this.fetchImpl(`${cleanUrl}/api/tags`, {
      method: 'GET',
      signal: reqSignal,
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/tags HTTP ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as { models?: Array<Record<string, any>> };
    const list = Array.isArray(data?.models) ? data.models : [];
    const seen = new Set<string>();
    const out: OllamaModelTag[] = [];
    for (const m of list) {
      const name = String(m?.name || m?.model || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        model: String(m?.model || name),
        size: typeof m?.size === 'number' ? m.size : undefined,
        modifiedAt: typeof m?.modified_at === 'string' ? m.modified_at : undefined,
        details: m?.details && typeof m.details === 'object' ? m.details : undefined,
      });
    }
    return out;
  }

  async getRunningModels(baseUrl = this.defaultBaseUrl, signal?: AbortSignal): Promise<OllamaPsModel[]> {
    try {
      const cleanUrl = sanitizeOllamaUrl(baseUrl);
      const reqSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(this.tagsTimeoutMs, 2_500))])
        : AbortSignal.timeout(Math.min(this.tagsTimeoutMs, 2_500));
      const res = await this.fetchImpl(`${cleanUrl}/api/ps`, {
        method: 'GET',
        signal: reqSignal,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<Record<string, any>> };
      if (!Array.isArray(data?.models)) return [];
      return data.models.map(m => ({
        name: String(m?.name || m?.model || ''),
        model: String(m?.model || m?.name || ''),
        size: typeof m?.size === 'number' ? m.size : undefined,
        sizeVram: typeof m?.size_vram === 'number' ? m.size_vram : undefined,
      }));
    } catch {
      return [];
    }
  }

  async getModels(baseUrl = this.defaultBaseUrl, signal?: AbortSignal): Promise<string[]> {
    const tags = await this.getTags(baseUrl, signal);
    return tags.map(t => t.name);
  }

  async testConnection(baseUrl = this.defaultBaseUrl, requestedModel?: string, signal?: AbortSignal): Promise<OllamaConnectionTestResult> {
    const cleanUrl = sanitizeOllamaUrl(baseUrl);
    const isRemote = isRemoteOllamaUrl(cleanUrl);
    const started = Date.now();
    try {
      const tagDetails = await this.getTags(cleanUrl, signal);
      const models = tagDetails.map(t => t.name);
      const runningModels = await this.getRunningModels(cleanUrl, signal);
      const hasRequestedModel = requestedModel ? models.includes(requestedModel.trim()) : undefined;
      return {
        reachable: true,
        baseUrl: cleanUrl,
        isRemote,
        models,
        tagDetails,
        runningModels,
        hasRequestedModel,
        latencyMs: Date.now() - started,
      };
    } catch (err: any) {
      const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `Ollama 連線逾時（${cleanUrl}）`
        : err?.message || `無法連線 Ollama（${cleanUrl}）`;
      return {
        reachable: false,
        baseUrl: cleanUrl,
        isRemote,
        models: [],
        tagDetails: [],
        runningModels: [],
        hasRequestedModel: requestedModel ? false : undefined,
        latencyMs: Date.now() - started,
        error: msg,
      };
    }
  }

  async analyzeSnapshot(
    snapshot: AIDataSnapshot,
    model: string,
    options: {
      baseUrl?: string;
      promptVersion?: string;
      ruleVersion?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<OllamaAnalyzeOutput> {
    const cleanUrl = sanitizeOllamaUrl(options.baseUrl ?? this.defaultBaseUrl);
    const isRemote = isRemoteOllamaUrl(cleanUrl);
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      throw new Error('請指定 Ollama 模型名稱');
    }
    const promptVersion = options.promptVersion ?? this.promptVersion;
    const ruleVersion = options.ruleVersion ?? this.ruleVersion;
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? this.analyzeTimeoutMs);

    const { system, user } = buildOllamaMarketPrompt(snapshot);
    const started = Date.now();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const reqSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    const response = await this.fetchImpl(`${cleanUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: reqSignal,
      body: JSON.stringify({
        model: trimmedModel,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: '15m',
        options: { temperature: 0.1, num_predict: 512 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`Ollama /api/chat HTTP ${response.status}: ${bodyText || response.statusText}`);
    }

    const payload = (await response.json()) as Record<string, any>;
    const rawContent = payload?.message?.content ?? payload?.response;
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      throw new Error('Ollama 回傳空白或非字串內容');
    }

    let parsedOutput: unknown;
    try {
      parsedOutput = JSON.parse(stripJsonFences(rawContent));
    } catch (err: any) {
      throw new Error(`Ollama 回傳非合法 JSON：${err?.message || 'parse error'}`, { cause: err });
    }

    const result = validateAIModelOutput(parsedOutput, snapshot, {
      model: trimmedModel,
      promptVersion,
      ruleVersion,
    });

    const elapsedMs = Date.now() - started;
    const psModels = await this.getRunningModels(cleanUrl, options.signal);
    const psMatch = psModels.find(p => p.name === trimmedModel || p.model === trimmedModel);

    return {
      result,
      telemetry: {
        elapsedMs,
        evalCount: typeof payload.eval_count === 'number' ? payload.eval_count : undefined,
        evalDurationMs: typeof payload.eval_duration === 'number' ? Math.round(payload.eval_duration / 1e6) : undefined,
        promptEvalCount: typeof payload.prompt_eval_count === 'number' ? payload.prompt_eval_count : undefined,
        totalDurationMs: typeof payload.total_duration === 'number' ? Math.round(payload.total_duration / 1e6) : undefined,
        modelMemoryMb: typeof psMatch?.size === 'number' ? Math.round(psMatch.size / (1024 * 1024)) : null,
        modelVramMb: typeof psMatch?.sizeVram === 'number' ? Math.round(psMatch.sizeVram / (1024 * 1024)) : null,
        baseUrl: cleanUrl,
        isRemote,
      },
    };
  }

  async analyzeBatch(snapshots: AIDataSnapshot[], model: string, signal: AbortSignal): Promise<{ analyses: AIAnalysisResult[] }> {
    const out: AIAnalysisResult[] = [];
    for (const snapshot of snapshots) {
      signal.throwIfAborted();
      const { result } = await this.analyzeSnapshot(snapshot, model, { signal });
      out.push(result);
    }
    return { analyses: out };
  }
}
