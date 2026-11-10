import type { AIDataAggregator } from './aiDataAggregator.ts';
import type { AICLIRunner } from './cliRunner.ts';
import type { AIScopeStore, AnalysisScope } from './scopeStore.ts';
import type { MarketType } from '@fadachi/core';

export interface AISchedulerOptions {
  aggregator: AIDataAggregator;
  cliRunner: AICLIRunner;
  scopeStore?: AIScopeStore;
  getTrackedSymbols?: () => string[];
  getScope?: () => Promise<AnalysisScope>;
  market?: MarketType;
  signal?: AbortSignal;
}

export class AIScheduler {
  private readonly aggregator: AIDataAggregator;
  private readonly cliRunner: AICLIRunner;
  private readonly scopeStore?: AIScopeStore;
  private readonly getTrackedSymbols: () => string[];
  private readonly getScope?: () => Promise<AnalysisScope>;
  private readonly market: MarketType;
  private periodicTimer: NodeJS.Timeout | null = null;
  private newsTimer: NodeJS.Timeout | null = null;
  private onChainTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private scopeLockUsers = 0;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly seenNewsIds = new Set<string>();

  readonly INTERVAL_MS = 15 * 60 * 1000;
  readonly NEWS_INTERVAL_MS = 5 * 60 * 1000;
  readonly ONCHAIN_INTERVAL_MS = 60 * 60 * 1000;

  constructor(options: AISchedulerOptions) {
    this.aggregator = options.aggregator;
    this.cliRunner = options.cliRunner;
    this.scopeStore = options.scopeStore;
    this.getTrackedSymbols = options.getTrackedSymbols ?? (() => []);
    this.getScope = options.getScope;
    this.market = options.market ?? 'futures';
    options.signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  start(): void {
    if (this.stopped) return;
    this.launch(this.runPeriodicAnalysis());
    this.launch(this.refreshNews());
    this.launch(this.refreshOnChain());
    this.periodicTimer = setInterval(() => this.launch(this.runPeriodicAnalysis()), this.INTERVAL_MS);
    this.newsTimer = setInterval(() => this.launch(this.refreshNews()), this.NEWS_INTERVAL_MS);
    this.onChainTimer = setInterval(() => this.launch(this.refreshOnChain()), this.ONCHAIN_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.periodicTimer, this.newsTimer, this.onChainTimer]) {
      if (timer) clearInterval(timer);
    }
    this.periodicTimer = this.newsTimer = this.onChainTimer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private launch(job: Promise<unknown>): void {
    this.inFlight.add(job);
    void job.catch(error => console.warn('[AIScheduler] Background task failed:', error))
      .finally(() => this.inFlight.delete(job));
  }

  async runPeriodicAnalysis(): Promise<void> {
    if (this.stopped || this.running || !this.cliRunner.isIsolationVerified()) return;
    this.running = true;
    let locked = false;
    try {
      const scope = await this.acquireScope();
      locked = Boolean(this.scopeStore);
      const snapshots = await this.buildSnapshots(scope);
      if (this.stopped || !snapshots.length) return;
      await this.cliRunner.runBatchAnalysis(snapshots, scope.model, false);
    } catch (err) {
      console.warn('[AIScheduler] Periodic batch skipped:', (err as Error).message);
    } finally {
      if (locked) await this.releaseScope().catch(() => {});
      this.running = false;
    }
  }

  async triggerEventUpdate(symbol: string, reason: string): Promise<void> {
    if (this.stopped || !this.cliRunner.isIsolationVerified()) return;
    let locked = false;
    try {
      const scope = await this.acquireScope();
      locked = Boolean(this.scopeStore);
      if (!scope.symbols.some(item => item.toUpperCase() === symbol.toUpperCase())) return;
      const snapshots = await this.buildSnapshots(scope);
      if (snapshots.length) await this.cliRunner.runBatchAnalysis(snapshots, scope.model, true);
      console.info(`[AIScheduler] Event batch triggered for ${symbol} (${reason})`);
    } catch (err) {
      console.warn(`[AIScheduler] Event batch deferred for ${symbol}:`, (err as Error).message);
    } finally {
      if (locked) await this.releaseScope().catch(() => {});
    }
  }

  private async acquireScope(): Promise<AnalysisScope> {
    if (this.scopeStore) {
      const scope = await this.scopeStore.lockScope('ai-scheduler');
      this.scopeLockUsers++;
      return scope;
    }
    if (this.getScope) return this.getScope();
    const symbols = [...new Set(this.getTrackedSymbols().map(value => value.toUpperCase()))].slice(0, 10);
    return { market: this.market, symbols, model: 'gemini-2.5-flash' };
  }

  private async releaseScope(): Promise<void> {
    if (this.scopeStore && this.scopeLockUsers > 0 && --this.scopeLockUsers === 0) {
      await this.scopeStore.unlockScope('ai-scheduler');
    }
  }

  private async buildSnapshots(scope: AnalysisScope) {
    if (!scope.symbols.length || scope.symbols.length > 10) return [];
    const snapshots = await Promise.all(scope.symbols.map(symbol =>
      this.aggregator.buildSnapshot(symbol, scope.market)));
    return snapshots.filter(snapshot => snapshot.essentialDataValid && Date.now() < snapshot.validUntil);
  }

  private async refreshNews(): Promise<void> {
    if (this.stopped) return;
    try {
      const fresh = await this.aggregator.refreshNews();
      const major = fresh.filter(item => this.aggregator.news.isMajorNews(item) && !this.seenNewsIds.has(item.id));
      for (const item of fresh) this.seenNewsIds.add(item.id);
      while (this.seenNewsIds.size > 2000) this.seenNewsIds.delete(this.seenNewsIds.values().next().value!);
      if (major.length && this.cliRunner.isIsolationVerified()) {
        await this.runNewsEvent(major[0].id);
      }
    } catch (err) {
      console.warn('[AIScheduler] News refresh failed:', (err as Error).message);
    }
  }

  private async runNewsEvent(newsId: string): Promise<void> {
    try {
      const scope = await this.acquireScope();
      const snapshots = await this.buildSnapshots(scope);
      if (snapshots.length) await this.cliRunner.runBatchAnalysis(snapshots, scope.model, true);
      console.info(`[AIScheduler] Major news event batch ${newsId}`);
    } catch (err) {
      console.warn('[AIScheduler] News event analysis deferred:', (err as Error).message);
    } finally {
      await this.releaseScope().catch(() => {});
    }
  }

  private async refreshOnChain(): Promise<void> {
    if (this.stopped) return;
    try {
      const scope = await this.acquireScope();
      await this.aggregator.refreshOnChain(scope.symbols);
    } catch (err) {
      console.warn('[AIScheduler] On-chain refresh failed:', (err as Error).message);
    } finally {
      await this.releaseScope().catch(() => {});
    }
  }
}
