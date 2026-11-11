import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MODEL_PAPER_CONFIG,
  computeAccountMetrics,
  evaluateComparability,
  fetchAutoFundingHistory,
  fetchAutoSymbolRules,
  type AccountId,
  type AdapterRunSummary,
  type AutoFundingRecord,
  type AutoSymbolRules,
  type ModelPaperExperimentDetail,
  type ModelPaperExperimentRecord,
  type PaperAccountState,
} from '@fadachi/core';
import { ModelResearchRunner } from '../research/modelResearchRunner.ts';
import type { DuckDBClient } from '../storage/duckdb.ts';
import {
  resolveRunsRoot,
  validateAdapterRun,
  buildLocalRollingModelSource,
} from './adapters.ts';
import { PaperExecutor } from './executor.ts';
import { ForwardInferenceCoordinator } from './forwardInference.ts';
import { FundingSettler } from './funding.ts';
import { MarketCacheUpdater } from './marketCache.ts';
import { RollingModelPipeline } from './rollingPipeline.ts';
import { ForwardScheduler, defaultSchedulerClock, type SchedulerClock } from './scheduler.ts';
import { ModelPaperStore } from './store.ts';
import type { TradeBus } from './tradeBus.ts';

const ONE_HOUR_MS = 3_600_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_LEASE_TTL_MS = 45_000;
const RULES_CACHE_TTL_MS = 30 * 60_000;

export class ModelPaperHttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ModelPaperHttpError';
    this.statusCode = statusCode;
  }
}

export function loadResearchUniverse(dataDir: string): { symbols: string[]; error?: string } {
  const manifestPath = path.join(dataDir, 'model-research', 'datasets', 'dataset_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { symbols: [], error: `找不到研究資料集清單：${manifestPath}` };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const rawSymbols = manifest?.universe?.symbols;
    if (!Array.isArray(rawSymbols)) {
      return { symbols: [], error: 'dataset_manifest.json 缺少 universe.symbols' };
    }
    const symbols = Array.from(
      new Set(
        rawSymbols
          .map((s: unknown) => (typeof s === 'string' ? s.trim().toUpperCase() : ''))
          .filter((s: string) => /^[A-Z0-9]{2,30}USDT$/.test(s)),
      ),
    );
    if (symbols.length < 10) {
      return { symbols: [], error: 'dataset_manifest.json 研究幣種數量不足 10 檔' };
    }
    return { symbols };
  } catch (err: any) {
    return {
      symbols: [],
      error: `讀取 dataset_manifest.json 失敗：${err?.message || String(err)}`,
    };
  }
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : '';
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  let text = typeof val === 'string' ? val : JSON.stringify(val);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsvCell(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export interface ModelPaperServiceOptions {
  client: DuckDBClient;
  dataDir: string;
  workspaceRoot: string;
  runner: ModelResearchRunner;
  tradeBus: TradeBus;
  clock?: SchedulerClock;
  fetchImpl?: typeof fetch;
  fetchSymbolRules?: () => Promise<Record<string, AutoSymbolRules>>;
  fetchFundingHistory?: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  runsRoot?: string;
  chronosPython?: string;
  rollingPipeline?: RollingModelPipeline;
  retrainIntervalHours?: number;
  universeSymbols?: string[];
  available?: boolean;
  availabilityReason?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  generation?: number;
  ownerToken?: string;
  requireConnectedStream?: boolean;
}

export class ModelPaperService {
  readonly store: ModelPaperStore;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly runner: ModelResearchRunner;
  readonly tradeBus: TradeBus;
  readonly clock: SchedulerClock;
  readonly runsRoot: string;
  readonly marketCache: MarketCacheUpdater;
  readonly rollingPipeline: RollingModelPipeline;
  readonly forwardInference: ForwardInferenceCoordinator;
  readonly executor: PaperExecutor;
  readonly fundingSettler: FundingSettler;
  readonly scheduler: ForwardScheduler;

  readonly ownerToken: string;
  readonly generation: number;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly requireConnectedStream: boolean;

  private readonly fetchRulesFn: () => Promise<Record<string, AutoSymbolRules>>;
  private rulesCache: { rules: Record<string, AutoSymbolRules>; fetchedAt: number } | null = null;
  private readonly ownedExperimentIds = new Set<string>();
  private readonly ownsRollingPipeline: boolean;
  private universeSymbols: string[];
  private available: boolean;
  private availabilityReason: string | null;
  private heartbeatTimer: unknown = null;
  private started = false;

  constructor(options: ModelPaperServiceOptions) {
    this.store = new ModelPaperStore(options.client);
    this.dataDir = path.resolve(options.dataDir);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.runner = options.runner;
    this.tradeBus = options.tradeBus;
    this.clock = options.clock ?? defaultSchedulerClock;
    this.runsRoot = resolveRunsRoot(this.workspaceRoot, options.runsRoot);

    this.ownerToken = options.ownerToken ?? randomUUID();
    this.generation = options.generation ?? Date.now();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.requireConnectedStream = options.requireConnectedStream ?? true;

    if (options.universeSymbols && options.universeSymbols.length > 0) {
      this.universeSymbols = Array.from(new Set(options.universeSymbols.map(s => s.trim().toUpperCase())));
      this.available = options.available ?? true;
      this.availabilityReason = options.availabilityReason ?? null;
    } else {
      const loaded = loadResearchUniverse(this.dataDir);
      this.universeSymbols = loaded.symbols;
      this.available = options.available ?? loaded.symbols.length >= 10;
      this.availabilityReason = options.availabilityReason ?? loaded.error ?? null;
    }

    this.fetchRulesFn = options.fetchSymbolRules ?? (() => fetchAutoSymbolRules('futures'));

    this.marketCache = new MarketCacheUpdater({
      dataDir: this.dataDir,
      client: options.client,
      fetchImpl: options.fetchImpl,
      fetchFundingHistory: options.fetchFundingHistory,
    });

    this.ownsRollingPipeline = !options.rollingPipeline;
    this.rollingPipeline =
      options.rollingPipeline
      ?? new RollingModelPipeline({
        runner: this.runner,
        dataDir: this.dataDir,
        workspaceRoot: this.workspaceRoot,
        chronosPython: options.chronosPython,
        clock: this.clock,
        autoHourlyEnabled: false,
        runOnStart: false,
        retrainIntervalHours: options.retrainIntervalHours ?? 6,
      });

    this.forwardInference = new ForwardInferenceCoordinator({
      runner: this.runner,
      marketCache: this.marketCache,
      rollingPipeline: this.rollingPipeline,
      workspaceRoot: this.workspaceRoot,
      dataDir: this.dataDir,
      chronosPython: options.chronosPython,
      runsRoot: this.runsRoot,
    });

    this.fundingSettler = new FundingSettler({
      store: this.store,
      fetchFundingHistory: options.fetchFundingHistory ?? fetchAutoFundingHistory,
      clock: this.clock,
      getOwnedExperimentIds: () => Array.from(this.ownedExperimentIds),
      getLastPrices: () => this.executor.getLastPrices(),
    });

    this.scheduler = new ForwardScheduler({
      store: this.store,
      tradeBus: this.tradeBus,
      forwardInference: this.forwardInference,
      getRules: () => this.getRules(),
      isLeaseOwned: (expId) => this.ownedExperimentIds.has(expId),
      clock: this.clock,
    });

    this.executor = new PaperExecutor({
      store: this.store,
      tradeBus: this.tradeBus,
      clock: this.clock,
      getOwnedExperimentIds: () => Array.from(this.ownedExperimentIds),
      getRules: () => this.rulesCache?.rules ?? {},
      onPositionClosed: async (expId, symbol) => {
        await this.fundingSettler.settleExperiment(expId, [symbol]);
      },
      onExitFilled: async ({ experimentId, account, now }) => {
        await this.scheduler.onExitFilled({ experimentId, account, now });
      },
      onAwaitingResume: (experimentId) => {
        this.scheduler.stop(experimentId);
      },
    });
  }

  getAvailability(): { available: boolean; reason: string | null; universeSymbols: string[] } {
    return {
      available: this.available,
      reason: this.availabilityReason,
      universeSymbols: [...this.universeSymbols],
    };
  }

  async getRules(): Promise<Record<string, AutoSymbolRules>> {
    const now = this.clock.now();
    if (this.rulesCache && now - this.rulesCache.fetchedAt < RULES_CACHE_TTL_MS) {
      return this.rulesCache.rules;
    }
    const rules = await this.fetchRulesFn();
    this.rulesCache = { rules, fetchedAt: now };
    return rules;
  }

  listAdapters(): {
    pipelineMode: 'local-rolling';
    runsRoot: string;
    defaultRunDir: string | null;
    adapters: AdapterRunSummary[];
    rollingPipeline: ReturnType<RollingModelPipeline['getStatus']>;
    available: boolean;
    availabilityReason: string | null;
  } {
    const rolling = this.rollingPipeline.getStatus();
    return {
      pipelineMode: 'local-rolling',
      runsRoot: this.runsRoot,
      defaultRunDir: null,
      adapters: [],
      rollingPipeline: rolling,
      available: this.available,
      availabilityReason: this.availabilityReason,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const now = this.clock.now();

    const activeExps = await this.store.getActiveExperiments();
    for (const exp of activeExps) {
      await this.recoverExperimentOnStart(exp, now);
    }

    this.executor.start();
    this.fundingSettler.start();
    this.scheduleHeartbeat();
  }

  private async recoverExperimentOnStart(exp: ModelPaperExperimentRecord, now: number): Promise<void> {
    let owned = false;
    let stillActive = false;

    await this.store.withTx(async (tx) => {
      const fresh = await this.store.getExperiment(exp.id, tx);
      if (!fresh || fresh.status === 'STOPPED') return;

      const claim = await this.store.claimLease(
        fresh.id,
        this.ownerToken,
        this.generation,
        now,
        this.leaseTtlMs,
        tx,
      );
      if (!claim.owner) {
        return;
      }
      owned = true;

      // Cancel all pending ENTRY orders across both accounts; keep pending EXIT orders!
      await this.store.cancelPendingEntries(fresh.id, null, 'RESTART_RECOVERY', tx);
      await this.store.failOrphanedPendingDecisions(fresh.id, '程序重啟中斷推論，可於確認後重試', tx);

      const gapStart = Math.min(fresh.heartbeatAt || fresh.startedAt || now, now);
      if (now >= gapStart) {
        await this.store.insertGap(
          {
            id: `gap-restart-${fresh.id}-${now}-${randomUUID().slice(0, 6)}`,
            experimentId: fresh.id,
            account: 'BOTH',
            kind: 'PROCESS_RESTART',
            startedAt: gapStart,
            endedAt: now,
            detail: 'Collector 程序重啟，未成交入場單已取消，待確認後繼續測試',
          },
          tx,
        );
      }

      if (fresh.status === 'RUNNING' || fresh.status === 'PAUSED' || fresh.status === 'AWAITING_RESUME') {
        await this.store.updateExperimentStatus(
          fresh.id,
          'AWAITING_RESUME',
          {
            heartbeatAt: now,
            statusReason: '程序重啟恢復，請確認行情後按「繼續測試」',
          },
          tx,
        );
        stillActive = true;
      } else if (fresh.status === 'STOPPING') {
        const openPositions = await this.store.listPositions(fresh.id, undefined, 'OPEN', tx);
        const pendingOrders = await this.store.listPendingOrders(fresh.id, undefined, tx);
        const lastPrices = this.tradeBus.getLastPrices();

        for (const pos of openPositions) {
          if (!pendingOrders.some(o => o.action === 'EXIT' && o.positionId === pos.id)) {
            await this.store.insertOrderIfAbsent(
              {
                id: `manual-stop:${pos.id}`,
                experimentId: fresh.id,
                account: pos.account,
                decisionId: `manual-stop:${fresh.id}`,
                symbol: pos.symbol,
                side: pos.side,
                action: 'EXIT',
                reason: 'MANUAL_STOP',
                qty: pos.qty,
                refPrice: lastPrices[pos.symbol] ?? pos.entryPrice,
                createdAt: now,
                status: 'PENDING',
                cancelReason: null,
                positionId: pos.id,
              },
              tx,
            );
          }
        }

        const updatedPending = await this.store.listPendingOrders(fresh.id, undefined, tx);
        if (openPositions.length === 0 && updatedPending.length === 0) {
          await this.store.updateExperimentStatus(
            fresh.id,
            'STOPPED',
            { stoppedAt: now, heartbeatAt: now, statusReason: '已全數平倉停止' },
            tx,
          );
          await this.store.releaseLease(fresh.id, this.ownerToken, tx);
          stillActive = false;
        } else {
          await this.store.updateHeartbeat(fresh.id, now, tx);
          stillActive = true;
        }
      }
    });

    if (owned && stillActive) {
      this.ownedExperimentIds.add(exp.id);
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.started) return;
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = null;
      void this.renewHeartbeats().finally(() => {
        if (this.started) this.scheduleHeartbeat();
      });
    }, this.heartbeatIntervalMs);
  }

  async renewHeartbeats(): Promise<void> {
    const now = this.clock.now();
    for (const expId of Array.from(this.ownedExperimentIds)) {
      try {
        await this.store.withTx(async (tx) => {
          const exp = await this.store.getExperiment(expId, tx);
          if (!exp || exp.status === 'STOPPED') {
            this.ownedExperimentIds.delete(expId);
            await this.store.releaseLease(expId, this.ownerToken, tx);
            return;
          }
          const ok = await this.store.renewLease(
            expId,
            this.ownerToken,
            this.generation,
            now,
            this.leaseTtlMs,
            tx,
          );
          if (!ok) {
            this.ownedExperimentIds.delete(expId);
            this.scheduler.stop(expId);
            return;
          }
          await this.store.updateHeartbeat(expId, now, tx);
        });
      } catch (err) {
        console.error(`[ModelPaper] 更新租約與心跳失敗 (${expId}):`, err);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.heartbeatTimer !== null) {
      this.clock.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.scheduler.stop();
    await this.scheduler.flush();
    if (this.ownsRollingPipeline) {
      await this.rollingPipeline.stop();
    }
    this.executor.stop();
    this.fundingSettler.stop();
    await this.executor.flush();
    await this.fundingSettler.flush();

    const now = this.clock.now();
    for (const expId of Array.from(this.ownedExperimentIds)) {
      try {
        await this.store.withTx(async (tx) => {
          await this.store.updateHeartbeat(expId, now, tx);
          await this.store.releaseLease(expId, this.ownerToken, tx);
        });
      } catch (err) {
        console.error(`[ModelPaper] 停止前釋放實驗租約失敗 (${expId}):`, err);
      }
      this.ownedExperimentIds.delete(expId);
    }
  }

  private assertValidRequestId(requestId: string): void {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
      throw new ModelPaperHttpError(400, 'requestId 須為 8 至 80 字元的英數字、底線或連字號');
    }
  }

  async createExperiment(params: {
    requestId: string;
    adapterRunDir?: string;
    retrainIntervalHours?: number;
  }): Promise<ModelPaperExperimentDetail> {
    this.assertValidRequestId(params.requestId);

    const existingReq = await this.store.getControlRequest(params.requestId);
    if (existingReq) {
      if (existingReq.action === 'CREATE') {
        return this.getExperimentDetail(existingReq.experimentId);
      }
      throw new ModelPaperHttpError(409, 'requestId 已被其他操作使用');
    }

    const retrainIntervalHours = Number.isInteger(params.retrainIntervalHours)
      ? Math.max(1, Math.min(168, Number(params.retrainIntervalHours)))
      : 6;

    let modelSource;
    try {
      const explicitDir = typeof params.adapterRunDir === 'string' ? params.adapterRunDir.trim() : '';
      if (explicitDir && explicitDir !== 'local-rolling') {
        modelSource = validateAdapterRun(this.runsRoot, explicitDir, this.workspaceRoot).modelSource;
      } else {
        modelSource = buildLocalRollingModelSource(this.dataDir, this.workspaceRoot, retrainIntervalHours, {
          chronosPython: this.rollingPipeline.chronosPython,
        });
      }
    } catch (err: any) {
      throw new ModelPaperHttpError(400, err?.message || '本機 Chronos-2 滾動模型驗證失敗');
    }

    if (!this.available || this.universeSymbols.length < 10) {
      throw new ModelPaperHttpError(
        503,
        this.availabilityReason || '模型前向測試尚未就緒（缺少固定研究幣種清單）',
      );
    }

    if (this.requireConnectedStream && this.tradeBus.getStreamStatus().status !== 'connected') {
      throw new ModelPaperHttpError(409, 'Futures 即時逐筆成交串流尚未連線，無法開始測試');
    }

    // Ensure symbol rules can be loaded before creating experiment
    try {
      await this.getRules();
    } catch (err: any) {
      throw new ModelPaperHttpError(503, `無法取得交易規格：${err?.message || String(err)}`);
    }

    const now = this.clock.now();
    const expId = `mp-${now}-${randomUUID().slice(0, 8)}`;
    const config = { ...DEFAULT_MODEL_PAPER_CONFIG };

    await this.store.withTx(async (tx) => {
      const txReq = await this.store.getControlRequest(params.requestId, tx);
      if (txReq) {
        if (txReq.action === 'CREATE') return;
        throw new ModelPaperHttpError(409, 'requestId 已被其他操作使用');
      }

      const active = await this.store.getActiveExperiments(tx);
      if (active.length > 0) {
        throw new ModelPaperHttpError(
          409,
          `同時僅允許一個進行中實驗（目前已有 ${active[0].id}，狀態 ${active[0].status}）`,
        );
      }

      const expRecord: ModelPaperExperimentRecord = {
        id: expId,
        createdAt: now,
        status: 'RUNNING',
        config,
        modelKey: 'chronos2',
        modelSource,
        universe: [...this.universeSymbols],
        startedAt: now,
        stoppedAt: null,
        heartbeatAt: now,
        statusReason: null,
      };
      await this.store.insertExperiment(expRecord, tx);

      const makeAccount = (account: AccountId): PaperAccountState => ({
        experimentId: expId,
        account,
        cash: config.initialCash,
        reserved: 0,
        realizedPnl: 0,
        fees: 0,
        funding: 0,
        bankrupt: false,
        degraded: false,
        fundingPending: false,
        stoppedThisHour: [],
        updatedAt: now,
      });

      await this.store.insertAccounts([makeAccount('A'), makeAccount('B')], tx);
      for (const accId of ['A', 'B'] as const) {
        await this.store.upsertEquityPoint(
          {
            experimentId: expId,
            account: accId,
            ts: now,
            equity: config.initialCash,
            cash: config.initialCash,
            reserved: 0,
            unrealized: 0,
            complete: true,
          },
          tx,
        );
      }

      await this.store.claimLease(
        expId,
        this.ownerToken,
        this.generation,
        now,
        this.leaseTtlMs,
        tx,
      );

      await this.store.saveControlRequest(
        {
          requestId: params.requestId,
          experimentId: expId,
          action: 'CREATE',
          createdAt: now,
          result: { experimentId: expId, status: 'RUNNING' },
        },
        tx,
      );
    });

    // Check which id was persisted (in case of idempotent race)
    const savedReq = await this.store.getControlRequest(params.requestId);
    const createdId = savedReq?.experimentId ?? expId;

    if (createdId === expId) {
      this.ownedExperimentIds.add(expId);
      this.scheduler.start(expId, { runImmediate: true });
    }

    return this.getExperimentDetail(createdId);
  }

  async controlExperiment(
    experimentId: string,
    action: 'pause' | 'resume' | 'stop',
    requestId: string,
  ): Promise<ModelPaperExperimentDetail> {
    this.assertValidRequestId(requestId);
    const normAction = action.toUpperCase();

    const existingReq = await this.store.getControlRequest(requestId);
    if (existingReq) {
      if (existingReq.experimentId === experimentId && existingReq.action === normAction) {
        return this.getExperimentDetail(experimentId);
      }
      throw new ModelPaperHttpError(409, 'requestId 已被其他實驗或操作使用');
    }

    const now = this.clock.now();
    let shouldStartScheduler = false;
    let shouldRunCurrentHour = false;
    let currentHourToRun = 0;
    let shouldStopScheduler = false;
    let shouldReleaseLease = false;

    await this.store.withTx(async (tx) => {
      const txReq = await this.store.getControlRequest(requestId, tx);
      if (txReq) {
        if (txReq.experimentId === experimentId && txReq.action === normAction) return;
        throw new ModelPaperHttpError(409, 'requestId 已被其他實驗或操作使用');
      }

      const exp = await this.store.getExperiment(experimentId, tx);
      if (!exp) {
        throw new ModelPaperHttpError(404, `找不到實驗 ${experimentId}`);
      }

      const lease = await this.store.getLease(experimentId, tx);
      if (lease && lease.ownerToken !== this.ownerToken && lease.expiresAt > now) {
        throw new ModelPaperHttpError(409, '實驗目前由另一個 Collector 執行個體持有租約');
      }

      if (action === 'pause') {
        if (exp.status !== 'RUNNING') {
          throw new ModelPaperHttpError(409, `實驗狀態為 ${exp.status}，無法暫停`);
        }
        await this.store.updateExperimentStatus(
          exp.id,
          'PAUSED',
          { statusReason: '使用者暫停新進場', heartbeatAt: now },
          tx,
        );
        await this.store.cancelPendingEntries(exp.id, null, 'PAUSED', tx);
        shouldStopScheduler = true;
      } else if (action === 'resume') {
        if (exp.status !== 'PAUSED' && exp.status !== 'AWAITING_RESUME') {
          throw new ModelPaperHttpError(409, `實驗狀態為 ${exp.status}，無法繼續測試`);
        }
        if (this.requireConnectedStream && this.tradeBus.getStreamStatus().status !== 'connected') {
          throw new ModelPaperHttpError(409, 'Futures 行情串流尚未連線，無法繼續測試');
        }
        await this.store.claimLease(
          exp.id,
          this.ownerToken,
          this.generation,
          now,
          this.leaseTtlMs,
          tx,
        );
        await this.store.closeOpenGaps(exp.id, null, now, tx);
        const accounts = await this.store.getAccounts(exp.id, tx);
        for (const accId of ['A', 'B'] as const) {
          if (accounts[accId].degraded) {
            await this.store.upsertAccount({ ...accounts[accId], degraded: false, updatedAt: now }, tx);
          }
        }
        await this.store.updateExperimentStatus(
          exp.id,
          'RUNNING',
          { statusReason: null, heartbeatAt: now },
          tx,
        );
        this.ownedExperimentIds.add(exp.id);
        shouldStartScheduler = true;

        const currentH = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
        const deadline = currentH + ONE_HOUR_MS + exp.config.deadlineMs;
        if (now < deadline) {
          const existingDec = await this.store.getDecisionByHour(exp.id, exp.modelKey, currentH, tx);
          if (!existingDec || existingDec.status === 'PENDING_RETRY' || existingDec.status === 'FAILED') {
            shouldRunCurrentHour = true;
            currentHourToRun = currentH;
          }
        }
      } else if (action === 'stop') {
        if (!['RUNNING', 'PAUSED', 'AWAITING_RESUME'].includes(exp.status)) {
          throw new ModelPaperHttpError(409, `實驗狀態為 ${exp.status}，無法執行停止`);
        }
        await this.store.cancelPendingEntries(exp.id, null, 'STOPPED', tx);
        const openPositions = await this.store.listPositions(exp.id, undefined, 'OPEN', tx);
        const pendingOrders = await this.store.listPendingOrders(exp.id, undefined, tx);
        const lastPrices = this.tradeBus.getLastPrices();

        for (const pos of openPositions) {
          if (!pendingOrders.some(o => o.action === 'EXIT' && o.positionId === pos.id)) {
            await this.store.insertOrderIfAbsent(
              {
                id: `manual-stop:${pos.id}`,
                experimentId: exp.id,
                account: pos.account,
                decisionId: `manual-stop:${exp.id}`,
                symbol: pos.symbol,
                side: pos.side,
                action: 'EXIT',
                reason: 'MANUAL_STOP',
                qty: pos.qty,
                refPrice: lastPrices[pos.symbol] ?? pos.entryPrice,
                createdAt: now,
                status: 'PENDING',
                cancelReason: null,
                positionId: pos.id,
              },
              tx,
            );
          }
        }

        const remainingPending = await this.store.listPendingOrders(exp.id, undefined, tx);
        if (openPositions.length === 0 && remainingPending.length === 0) {
          await this.store.updateExperimentStatus(
            exp.id,
            'STOPPED',
            { stoppedAt: now, heartbeatAt: now, statusReason: '使用者停止並已全數平倉' },
            tx,
          );
          shouldReleaseLease = true;
        } else {
          await this.store.updateExperimentStatus(
            exp.id,
            'STOPPING',
            { heartbeatAt: now, statusReason: '停止中，等待所有持倉依規則平倉' },
            tx,
          );
        }
        shouldStopScheduler = true;
      }

      await this.store.saveControlRequest(
        {
          requestId,
          experimentId: exp.id,
          action: normAction,
          createdAt: now,
          result: { ok: true, action: normAction },
        },
        tx,
      );
    });

    if (shouldStopScheduler) {
      this.scheduler.stop(experimentId);
    }
    if (shouldReleaseLease) {
      this.ownedExperimentIds.delete(experimentId);
      await this.store.withTx((tx) => this.store.releaseLease(experimentId, this.ownerToken, tx));
    }
    if (shouldStartScheduler) {
      this.scheduler.start(experimentId, { runImmediate: false });
      if (shouldRunCurrentHour) {
        void this.scheduler.triggerHour(experimentId, currentHourToRun);
      }
    }

    return this.getExperimentDetail(experimentId);
  }

  async listExperiments(): Promise<
    Array<{
      experiment: ModelPaperExperimentRecord;
      equityA: number;
      equityB: number;
      returnPctA: number;
      returnPctB: number;
      comparable: boolean;
    }>
  > {
    const exps = await this.store.listExperiments();
    const lastPrices = this.executor.getLastPrices();
    const out = [];
    for (const exp of exps) {
      const detail = await this.buildExperimentDetail(exp, lastPrices);
      out.push({
        experiment: exp,
        equityA: detail.accounts.A.metrics.equity,
        equityB: detail.accounts.B.metrics.equity,
        returnPctA: detail.accounts.A.metrics.netReturnPct,
        returnPctB: detail.accounts.B.metrics.netReturnPct,
        comparable: detail.comparability.comparable,
      });
    }
    return out;
  }

  async getExperimentDetail(experimentId: string): Promise<ModelPaperExperimentDetail> {
    const exp = await this.store.getExperiment(experimentId);
    if (!exp) {
      throw new ModelPaperHttpError(404, `找不到實驗 ${experimentId}`);
    }
    return this.buildExperimentDetail(exp, this.executor.getLastPrices());
  }

  private async buildExperimentDetail(
    exp: ModelPaperExperimentRecord,
    lastPrices: Record<string, number>,
  ): Promise<ModelPaperExperimentDetail> {
    const now = this.clock.now();
    const accounts = await this.store.getAccounts(exp.id);
    const positions = await this.store.listPositions(exp.id);
    const orders = await this.store.listOrders(exp.id);
    const fills = await this.store.listFills(exp.id);
    const fundingCharges = await this.store.listFunding(exp.id);
    const equityPoints = await this.store.listEquityPoints(exp.id);
    const decisions = await this.store.listDecisions(exp.id);
    const gaps = await this.store.listGaps(exp.id);

    const buildAccountDetail = (accId: AccountId) => {
      const acc = accounts[accId];
      const accPos = positions.filter(p => p.account === accId);
      const openPositions = accPos.filter(p => p.status === 'OPEN');
      const closedPositions = accPos.filter(p => p.status === 'CLOSED');
      const accOrders = orders.filter(o => o.account === accId);
      const pendingOrders = accOrders.filter(o => o.status === 'PENDING');
      const accFills = fills.filter(f => f.account === accId);
      const accFunding = fundingCharges.filter(c => c.account === accId);
      const accEquity = equityPoints.filter(e => e.account === accId);

      const metrics = computeAccountMetrics({
        account: acc,
        config: exp.config,
        positions: accPos,
        orders: accOrders,
        fills: accFills,
        fundingCharges: accFunding,
        equityCurve: accEquity,
        decisions,
        gaps,
        lastPrices,
        startedAt: exp.startedAt,
        now,
        endedAt: exp.stoppedAt,
      });

      const accLastPrices: Record<string, number> = {};
      for (const p of openPositions) {
        if (lastPrices[p.symbol] !== undefined) accLastPrices[p.symbol] = lastPrices[p.symbol];
      }

      return {
        state: acc,
        openPositions,
        closedPositions,
        pendingOrders,
        recentOrders: accOrders.slice(0, 100),
        fills: accFills,
        fundingCharges: accFunding,
        equityCurve: accEquity,
        metrics,
        lastPrices: accLastPrices,
      };
    };

    const ordersA = orders.filter(o => o.account === 'A');
    const ordersB = orders.filter(o => o.account === 'B');
    const comparability = evaluateComparability(accounts.A, accounts.B, gaps, ordersA, ordersB);

    return {
      experiment: exp,
      accounts: {
        A: buildAccountDetail('A'),
        B: buildAccountDetail('B'),
      },
      decisions,
      gaps,
      comparability,
      nextScheduleAt: exp.status === 'RUNNING' ? this.scheduler.getNextScheduleAt(exp.id) : null,
      available: this.available,
      availabilityReason: this.availabilityReason,
      rollingPipeline: this.rollingPipeline.getStatus(),
    };
  }

  async exportExperiment(
    experimentId: string,
    kind: 'decisions' | 'fills' | 'equity' | 'config' | 'all',
    format: 'csv' | 'json',
  ): Promise<{ contentType: string; filename: string; body: string }> {
    if (kind === 'all' && format === 'csv') {
      throw new ModelPaperHttpError(400, 'kind=all 僅支援 json 格式匯出');
    }

    const detail = await this.getExperimentDetail(experimentId);
    const safeId = experimentId.replace(/[^A-Za-z0-9_-]/g, '_');

    if (format === 'json') {
      let payload: unknown;
      if (kind === 'decisions') payload = detail.decisions;
      else if (kind === 'fills') {
        payload = [...detail.accounts.A.fills, ...detail.accounts.B.fills].sort(
          (a, b) => a.receivedAt - b.receivedAt || a.aggId - b.aggId,
        );
      } else if (kind === 'equity') {
        payload = [...detail.accounts.A.equityCurve, ...detail.accounts.B.equityCurve].sort(
          (a, b) => a.ts - b.ts || a.account.localeCompare(b.account),
        );
      } else if (kind === 'config') {
        payload = detail.experiment;
      } else {
        payload = detail;
      }
      return {
        contentType: 'application/json; charset=utf-8',
        filename: `model-paper-${safeId}-${kind}.json`,
        body: JSON.stringify(payload, null, 2),
      };
    }

    // CSV format
    if (kind === 'decisions') {
      const headers = [
        'id', 'decision_hour_utc', 'status', 'attempts', 'reason',
        'signals_a_count', 'signals_b_count', 'skipped_a_count', 'skipped_b_count',
        'lgbm_version_id', 'chronos_version_id',
        'snapshot_hash', 'created_at', 'submitted_at',
      ];
      const rows = detail.decisions.map(d => ({
        id: d.id,
        decision_hour_utc: new Date(d.decisionHour).toISOString(),
        status: d.status,
        attempts: d.attempts,
        reason: d.reason ?? '',
        signals_a_count: d.signals?.signalsA?.length ?? 0,
        signals_b_count: d.signals?.signalsB?.length ?? 0,
        skipped_a_count: d.signals?.skippedA?.length ?? 0,
        skipped_b_count: d.signals?.skippedB?.length ?? 0,
        lgbm_version_id: d.modelVersions?.lgbmVersionId ?? d.signals?.modelVersions?.lgbmVersionId ?? '',
        chronos_version_id: d.modelVersions?.chronosVersionId ?? d.signals?.modelVersions?.chronosVersionId ?? '',
        snapshot_hash: d.snapshotHash ?? '',
        created_at: d.createdAt,
        submitted_at: d.submittedAt ?? '',
      }));
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `model-paper-${safeId}-decisions.csv`,
        body: toCsv(headers, rows),
      };
    }

    if (kind === 'fills') {
      const headers = [
        'order_id', 'account', 'symbol', 'action', 'agg_id', 'trade_time_utc',
        'received_at_utc', 'raw_price', 'fill_price', 'qty', 'fee',
        'slippage_cost', 'realized_pnl', 'position_id',
      ];
      const allFills = [...detail.accounts.A.fills, ...detail.accounts.B.fills].sort(
        (a, b) => a.receivedAt - b.receivedAt || a.aggId - b.aggId,
      );
      const rows = allFills.map(f => ({
        order_id: f.orderId,
        account: f.account,
        symbol: f.symbol,
        action: f.action ?? '',
        agg_id: f.aggId,
        trade_time_utc: new Date(f.tradeTime).toISOString(),
        received_at_utc: new Date(f.receivedAt).toISOString(),
        raw_price: f.rawPrice,
        fill_price: f.fillPrice,
        qty: f.qty,
        fee: f.fee,
        slippage_cost: f.slippageCost,
        realized_pnl: f.realizedPnl,
        position_id: f.positionId,
      }));
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `model-paper-${safeId}-fills.csv`,
        body: toCsv(headers, rows),
      };
    }

    if (kind === 'equity') {
      const headers = ['ts', 'ts_utc', 'account', 'equity', 'cash', 'reserved', 'unrealized', 'complete'];
      const pts = [...detail.accounts.A.equityCurve, ...detail.accounts.B.equityCurve].sort(
        (a, b) => a.ts - b.ts || a.account.localeCompare(b.account),
      );
      const rows = pts.map(p => ({
        ts: p.ts,
        ts_utc: new Date(p.ts).toISOString(),
        account: p.account,
        equity: p.equity,
        cash: p.cash,
        reserved: p.reserved,
        unrealized: p.unrealized,
        complete: p.complete,
      }));
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `model-paper-${safeId}-equity.csv`,
        body: toCsv(headers, rows),
      };
    }

    // kind === 'config'
    const exp = detail.experiment;
    const headers = ['field', 'value'];
    const rows = [
      { field: 'id', value: exp.id },
      { field: 'status', value: exp.status },
      { field: 'model_key', value: exp.modelKey },
      { field: 'strategy_version', value: exp.config.strategyVersion },
      { field: 'pipeline_mode', value: exp.modelSource.pipelineMode ?? 'adapter-run' },
      { field: 'retrain_interval_hours', value: exp.modelSource.retrainIntervalHours ?? '' },
      { field: 'adapter_run_id', value: exp.modelSource.adapterRunId },
      { field: 'base_revision', value: exp.modelSource.baseRevision },
      { field: 'universe', value: exp.universe.join(' ') },
      { field: 'initial_cash', value: exp.config.initialCash },
      { field: 'comparable', value: detail.comparability.comparable },
    ];
    return {
      contentType: 'text/csv; charset=utf-8',
      filename: `model-paper-${safeId}-config.csv`,
      body: toCsv(headers, rows),
    };
  }
}
