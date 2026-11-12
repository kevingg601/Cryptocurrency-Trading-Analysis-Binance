import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HourlyModelVersions, LightgbmRankSnapshot, RollingPipelineStatus } from '@fadachi/core';
import { ModelResearchBusyError, ModelResearchRunner } from '../research/modelResearchRunner.ts';
import { inspectLocalRollingStatus, resolveChronosPythonBin } from './adapters.ts';
import type { Chronos2LiveOutput, ForwardRankOutput } from './forwardInference.ts';
import { DataNotReadyError } from './marketCache.ts';
import { defaultSchedulerClock, type SchedulerClock } from './scheduler.ts';

const ONE_HOUR_MS = 3_600_000;
const DEFAULT_RETRAIN_INTERVAL_HOURS = 6;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_DEADLINE_MS = 600_000;
const DEFAULT_BG_TRAIN_MARGIN_MS = 28 * 60_000;

export class ChronosTrainingPausedError extends Error {
  readonly errorCode = 'TRAINING_PAUSED';
  constructor(message = '目前暫停 Chronos-2 及其他非 LightGBM 模型訓練，僅執行 LightGBM 每小時獨立更新與排名發布') {
    super(message);
    this.name = 'ChronosTrainingPausedError';
  }
}

export interface RollingCycleOutput {
  snapshotDir: string;
  inputDoc: Record<string, unknown>;
  rankResult: ForwardRankOutput & {
    lightgbm: ForwardRankOutput['lightgbm'] & {
      versionId?: string | null;
      trainedAt?: number | null;
      valNdcg5Long?: number | null;
      valNdcg5Short?: number | null;
    };
    chronosTrainDue?: boolean;
    klinesPath?: string;
    datasetVersion?: string;
  };
  chronosResult: Chronos2LiveOutput;
  modelVersions: HourlyModelVersions;
  committedRunId?: string | null;
}

export interface RollingModelPipelineOptions {
  runner: ModelResearchRunner;
  dataDir: string;
  workspaceRoot: string;
  chronosPython?: string;
  clock?: SchedulerClock;
  autoHourlyEnabled?: boolean;
  autoLgbmHourlyEnabled?: boolean;
  chronosTrainingPaused?: boolean;
  runOnStart?: boolean;
  retrainIntervalHours?: number;
  rankTimeoutMs?: number;
  chronosInferTimeoutMs?: number;
  chronosTrainTimeoutMs?: number;
  backgroundTrainMarginMs?: number;
  onHourCompleted?: (output: RollingCycleOutput) => void;
  onLgbmRankingPublished?: (snapshot: LightgbmRankSnapshot) => void;
}

export class RollingModelPipeline {
  readonly runner: ModelResearchRunner;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly chronosPython: string;
  readonly clock: SchedulerClock;
  readonly autoHourlyEnabled: boolean;
  readonly autoLgbmHourlyEnabled: boolean;
  readonly chronosTrainingPaused: boolean;
  readonly runOnStart: boolean;
  readonly retrainIntervalHours: number;
  readonly rankTimeoutMs: number;
  readonly chronosInferTimeoutMs: number;
  readonly chronosTrainTimeoutMs: number;
  readonly backgroundTrainMarginMs: number;
  private readonly onHourCompleted?: (output: RollingCycleOutput) => void;
  private readonly onLgbmRankingPublished?: (snapshot: LightgbmRankSnapshot) => void;

  private started = false;
  private hourlyTimer: unknown | null = null;
  private retryTimer: unknown | null = null;
  private nextScheduleAt: number | null = null;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private lastCompletedHourH: number | null = null;
  private lastCachedCycle: {
    cacheKey: string;
    output: RollingCycleOutput;
  } | null = null;

  private lgbmLastAttemptAt: number | null = null;
  private lgbmLastSuccessAt: number | null = null;
  private lgbmLastError: string | null = null;
  private lastLgbmCompletedHourH: number | null = null;
  private lastLgbmSnapshot: LightgbmRankSnapshot | null = null;
  private readonly inFlightLgbmHours = new Map<string, Promise<LightgbmRankSnapshot>>();

  private readonly inFlightHours = new Map<string, Promise<RollingCycleOutput>>();
  private readonly activePromises = new Set<Promise<unknown>>();
  private isTrainingChronos = false;
  private activeTrainPromise: Promise<Record<string, unknown>> | null = null;

  constructor(options: RollingModelPipelineOptions) {
    this.runner = options.runner;
    this.dataDir = path.resolve(options.dataDir);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.chronosPython = resolveChronosPythonBin(this.workspaceRoot, options.chronosPython);
    this.clock = options.clock ?? defaultSchedulerClock;
    this.autoHourlyEnabled = options.autoHourlyEnabled ?? true;
    this.chronosTrainingPaused = options.chronosTrainingPaused ?? true;
    this.autoLgbmHourlyEnabled = options.autoLgbmHourlyEnabled ?? this.autoHourlyEnabled;
    this.runOnStart = options.runOnStart ?? true;
    this.retrainIntervalHours = Math.max(1, Math.trunc(options.retrainIntervalHours ?? DEFAULT_RETRAIN_INTERVAL_HOURS));
    this.rankTimeoutMs = options.rankTimeoutMs ?? 180_000;
    this.chronosInferTimeoutMs = options.chronosInferTimeoutMs ?? 300_000;
    this.chronosTrainTimeoutMs = options.chronosTrainTimeoutMs ?? 40 * 60_000;
    this.backgroundTrainMarginMs = options.backgroundTrainMarginMs ?? DEFAULT_BG_TRAIN_MARGIN_MS;
    this.onHourCompleted = options.onHourCompleted;
    this.onLgbmRankingPublished = options.onLgbmRankingPublished;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.activePromises.add(promise);
    return promise.finally(() => {
      this.activePromises.delete(promise);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.autoHourlyEnabled && !this.autoLgbmHourlyEnabled) return;

    this.scheduleNextHourly();
    if (this.runOnStart) {
      const now = this.clock.now();
      const currentH = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
      const expectedCutoff = currentH + ONE_HOUR_MS;

      if (this.chronosTrainingPaused) {
        const latestLgbm = path.join(this.dataDir, 'model-live', 'models', 'lgbm', 'latest-ranking.json');
        let lgbmFresh = false;
        if (fs.existsSync(latestLgbm)) {
          try {
            const ptr = JSON.parse(fs.readFileSync(latestLgbm, 'utf8'));
            if (ptr?.status === 'SUCCESS' && ptr.cutoffTime === expectedCutoff
              && Number.isFinite(ptr.generatedAt) && ptr.generatedAt <= now
              && Number.isFinite(ptr.publishedAt) && ptr.publishedAt <= now
              && Number.isFinite(ptr.expiresAt) && now < ptr.expiresAt) {
              lgbmFresh = true;
              this.lastLgbmCompletedHourH = currentH;
              this.lastLgbmSnapshot = ptr as LightgbmRankSnapshot;
            }
          } catch {
            lgbmFresh = false;
          }
        }
        if (!lgbmFresh && this.autoLgbmHourlyEnabled) {
          void this.track(this.runAutoHourlyTick(currentH, now + DEFAULT_DEADLINE_MS));
        }
        return;
      }

      const latestRun = path.join(this.dataDir, 'model-research', 'latest-run.json');
      let alreadyFresh = false;
      if (fs.existsSync(latestRun)) {
        try {
          const ptr = JSON.parse(fs.readFileSync(latestRun, 'utf8'));
          if (typeof ptr?.cutoffTime === 'number' && ptr.cutoffTime >= expectedCutoff) {
            alreadyFresh = true;
          }
        } catch {
          alreadyFresh = false;
        }
      }
      if (!alreadyFresh) {
        void this.track(this.runAutoHourlyTick(currentH));
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.hourlyTimer !== null) {
      this.clock.clearTimeout(this.hourlyTimer);
      this.hourlyTimer = null;
    }
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextScheduleAt = null;
    while (this.activePromises.size > 0) {
      await Promise.allSettled(Array.from(this.activePromises));
    }
  }

  isBusyTrainingChronos(): boolean {
    return this.isTrainingChronos;
  }

  isTrainingPaused(): boolean {
    return this.chronosTrainingPaused;
  }

  getLatestLightgbmRanking(now = this.clock.now()): {
    snapshot: LightgbmRankSnapshot | null;
    expectedCutoffTime: number;
    isExpired: boolean;
    matchesCurrentHour: boolean;
    latestError: { cutoffTime?: number; failedAt?: number; error?: string } | null;
  } {
    const expectedCutoffTime = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS;
    const lgbmDir = path.join(this.dataDir, 'model-live', 'models', 'lgbm');
    const rankingPath = path.join(lgbmDir, 'latest-ranking.json');
    const errPath = path.join(lgbmDir, 'ranking_error.json');

    let snapshot: LightgbmRankSnapshot | null = this.lastLgbmSnapshot;
    if (fs.existsSync(rankingPath)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(rankingPath, 'utf8')) as LightgbmRankSnapshot;
        this.lastLgbmSnapshot = snapshot;
      } catch {
        // fallback to in-memory cache
      }
    }

    let latestError: { cutoffTime?: number; failedAt?: number; error?: string } | null = null;
    if (fs.existsSync(errPath)) {
      try {
        latestError = JSON.parse(fs.readFileSync(errPath, 'utf8'));
      } catch {
        latestError = null;
      }
    }

    const isExpired = snapshot
      ? (!Number.isFinite(snapshot.expiresAt) || now >= snapshot.expiresAt || snapshot.cutoffTime !== expectedCutoffTime)
      : true;
    const matchesCurrentHour = Boolean(snapshot && snapshot.cutoffTime === expectedCutoffTime && now < snapshot.expiresAt);
    return {
      snapshot,
      expectedCutoffTime,
      isExpired,
      matchesCurrentHour,
      latestError,
    };
  }

  getStatus(): RollingPipelineStatus {
    const base = inspectLocalRollingStatus(this.dataDir, this.workspaceRoot, {
      chronosPython: this.chronosPython,
      isTrainingChronos: this.isTrainingChronos,
      retrainIntervalHours: this.retrainIntervalHours,
      chronosTrainingPaused: this.chronosTrainingPaused,
    });
    return {
      ...base,
      lgbmAutoSchedule: {
        enabled: this.autoLgbmHourlyEnabled && this.started,
        nextRunAt: this.nextScheduleAt,
        lastAttemptAt: this.lgbmLastAttemptAt,
        lastSuccessAt: this.lgbmLastSuccessAt,
        lastError: this.lgbmLastError,
        lastCutoffTime: this.lastLgbmSnapshot?.cutoffTime ?? base.lgbm.lastRankingCutoffTime ?? null,
        lastRankingPublishedAt: this.lastLgbmSnapshot?.publishedAt ?? base.lgbm.lastRankingPublishedAt ?? null,
      },
      autoSchedule: {
        enabled: (this.chronosTrainingPaused ? this.autoLgbmHourlyEnabled : this.autoHourlyEnabled) && this.started,
        nextRunAt: this.nextScheduleAt,
        lastAttemptAt: this.chronosTrainingPaused ? this.lgbmLastAttemptAt : this.lastAttemptAt,
        lastSuccessAt: this.chronosTrainingPaused ? this.lgbmLastSuccessAt : this.lastSuccessAt,
        lastError: this.chronosTrainingPaused ? this.lgbmLastError : this.lastError,
        isTrainingChronos: this.isTrainingChronos,
        chronosPaused: this.chronosTrainingPaused,
      },
    };
  }

  private scheduleNextHourly(): void {
    if (!this.started || (!this.autoHourlyEnabled && !this.autoLgbmHourlyEnabled)) return;
    if (this.hourlyTimer !== null) {
      this.clock.clearTimeout(this.hourlyTimer);
      this.hourlyTimer = null;
    }
    const now = this.clock.now();
    const curHourPlus30s = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS + 30_000;
    const nextRunAt = now < curHourPlus30s ? curHourPlus30s : curHourPlus30s + ONE_HOUR_MS;
    this.nextScheduleAt = nextRunAt;

    const delay = Math.max(1, nextRunAt - now);
    this.hourlyTimer = this.clock.setTimeout(() => {
      this.hourlyTimer = null;
      if (!this.started) return;
      const fireNow = this.clock.now();
      const targetH = Math.floor(fireNow / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
      void this.track(this.runAutoHourlyTick(targetH)).finally(() => {
        if (this.started) this.scheduleNextHourly();
      });
    }, delay);
  }

  private scheduleRetry(targetH: number, deadline?: number): void {
    if (!this.started || (!this.autoHourlyEnabled && !this.autoLgbmHourlyEnabled)) return;
    if (this.retryTimer !== null) {
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      if (!this.started) return;
      void this.track(this.runAutoHourlyTick(targetH, deadline));
    }, DEFAULT_RETRY_MS);
  }

  private async runAutoHourlyTick(targetH: number, retryDeadline?: number): Promise<void> {
    if (!this.started) return;

    const now = this.clock.now();
    const deadline = retryDeadline ?? (targetH + ONE_HOUR_MS + DEFAULT_DEADLINE_MS);
    if (now >= deadline || targetH + ONE_HOUR_MS !== Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS) return;

    if (this.chronosTrainingPaused) {
      if (!this.autoLgbmHourlyEnabled) return;
      if (this.lastLgbmCompletedHourH !== null && this.lastLgbmCompletedHourH >= targetH) {
        return;
      }
      this.lgbmLastAttemptAt = now;
      try {
        await this.runLightgbmHourlyUpdate({
          targetHourH: targetH,
          now,
          skipTrainingIfSameCutoff: true,
        });
      } catch (err: any) {
        this.lgbmLastError = err?.message || String(err);
        if (
          (err instanceof DataNotReadyError || err?.errorCode === 'DATA_NOT_READY' || err instanceof ModelResearchBusyError)
          && this.clock.now() < deadline
        ) {
          this.scheduleRetry(targetH, deadline);
        }
      }
      return;
    }

    if (this.lastCompletedHourH !== null && this.lastCompletedHourH >= targetH) {
      return;
    }

    this.lastAttemptAt = now;
    try {
      await this.runHourlyCycle({
        targetHourH: targetH,
        now,
        commitResearch: true,
        requireChronosReady: false,
        triggerChronosRetrainIfDue: true,
        skipTrainingIfSameCutoff: true,
      });
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      if (
        (err instanceof DataNotReadyError || err?.errorCode === 'DATA_NOT_READY' || err instanceof ModelResearchBusyError)
        && this.clock.now() < deadline
      ) {
        this.scheduleRetry(targetH);
      }
    }
  }

  async runLightgbmHourlyUpdate(params: {
    targetHourH?: number;
    now?: number;
    universeSymbols?: string[];
    force?: boolean;
    retrainLgbm?: boolean;
    skipTrainingIfSameCutoff?: boolean;
    allowNetwork?: boolean;
    lockOwnerJobId?: string;
  } = {}): Promise<LightgbmRankSnapshot> {
    const now = params.now ?? this.clock.now();
    const targetHourH = params.targetHourH ?? (Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS);
    const targetCutoffTime = targetHourH + ONE_HOUR_MS;
    if (!Number.isSafeInteger(targetCutoffTime) || targetCutoffTime <= 0
      || targetCutoffTime % ONE_HOUR_MS !== 0
      || targetCutoffTime > Math.floor(this.clock.now() / ONE_HOUR_MS) * ONE_HOUR_MS) {
      throw new DataNotReadyError('LightGBM cutoff 必須是已收盤 UTC 整點');
    }
    const cacheKey = JSON.stringify({
      targetHourH,
      universeSymbols: [...(params.universeSymbols ?? [])].map(s => s.toUpperCase()).sort(),
      retrainLgbm: params.retrainLgbm ?? true,
      skipTrainingIfSameCutoff: params.skipTrainingIfSameCutoff ?? true,
      allowNetwork: params.allowNetwork ?? true,
    });

    if (!params.force && this.lastLgbmSnapshot && this.lastLgbmSnapshot.cutoffTime === targetCutoffTime && this.lastLgbmSnapshot.status === 'SUCCESS') {
      return structuredClone(this.lastLgbmSnapshot);
    }

    const existing = this.inFlightLgbmHours.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = this.track((async () => {
      this.lgbmLastAttemptAt = this.clock.now();
      try {
        const res = await this.runner.runExclusive(
          `lgbm-hourly:${targetHourH}`,
          async () => {
            const raw = (await this.runner.invokeWorkerWith(
              this.runner.pythonExecutable,
              ['-m', 'research.model_research.worker'],
              {
                action: 'rolling_update_lgbm_rank',
                dataDir: this.dataDir,
                targetCutoffTime,
                ...(params.universeSymbols?.length ? { universeSymbols: params.universeSymbols } : {}),
                retrainLgbm: params.retrainLgbm ?? true,
                skipTrainingIfSameCutoff: params.skipTrainingIfSameCutoff ?? true,
                allowNetwork: params.allowNetwork ?? true,
              },
              this.rankTimeoutMs,
            )) as Record<string, any>;

            if (!raw || raw.replay === true || raw.inputMode !== 'live') {
              throw Object.assign(new Error('拒絕使用 replay 或非即時模式之 LightGBM 排名結果'), {
                errorCode: 'REPLAY_RESULT_REJECTED',
              });
            }
            if (Number(raw.decisionOpenTime) !== targetHourH || Number(raw.cutoffTime) !== targetCutoffTime) {
              throw new DataNotReadyError(
                `LightGBM 排名截斷小時 (${raw.cutoffTime}) 與目標小時 (${targetCutoffTime}) 不符`,
              );
            }

            const publishedAt = Number(raw.publishedAt ?? raw.generatedAt ?? this.clock.now());
            const generatedAt = Number(raw.generatedAt ?? publishedAt);
            const expiresAt = Number(raw.expiresAt ?? (targetCutoffTime + ONE_HOUR_MS));
            const snapshot: LightgbmRankSnapshot = {
              snapshotId: String(raw.snapshotId || `lgbm-${targetCutoffTime}-${raw.lightgbm?.versionId ?? 'active'}`),
              status: 'SUCCESS',
              decisionOpenTime: Number(raw.decisionOpenTime),
              cutoffTime: Number(raw.cutoffTime),
              generatedAt,
              publishedAt,
              expiresAt,
              versionId: raw.lightgbm?.versionId ?? null,
              longSha256: raw.lightgbm?.longSha256 ?? null,
              shortSha256: raw.lightgbm?.shortSha256 ?? null,
              trainedAt: raw.lightgbm?.trainedAt ?? null,
              universeSymbols: Array.isArray(raw.universeSymbols) ? raw.universeSymbols : [],
              eligibleCount: typeof raw.eligibleCount === 'number' ? raw.eligibleCount : undefined,
              insufficientSymbols: Array.isArray(raw.insufficientSymbols) ? raw.insufficientSymbols : [],
              longTop5: Array.isArray(raw.longTop5) ? raw.longTop5 : [],
              shortTop5: Array.isArray(raw.shortTop5) ? raw.shortTop5 : [],
              allRankings: Array.isArray(raw.allRankings) ? raw.allRankings : [],
              conflictSymbols: Array.isArray(raw.conflictSymbols) ? raw.conflictSymbols : [],
              reason: null,
              trainAudit: raw.trainAudit ?? null,
            };
            return snapshot;
          },
          { allowDuringJobId: params.lockOwnerJobId },
        );

        this.lastLgbmCompletedHourH = targetHourH;
        this.lgbmLastSuccessAt = this.clock.now();
        this.lgbmLastError = null;
        this.lastLgbmSnapshot = res;
        this.onLgbmRankingPublished?.(res);
        return res;
      } catch (err: any) {
        this.lgbmLastError = err?.message || String(err);
        if (err?.errorCode === 'DATA_NOT_READY') {
          throw new DataNotReadyError(err.message);
        }
        throw err;
      }
    })());

    this.inFlightLgbmHours.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightLgbmHours.get(cacheKey) === promise) {
        this.inFlightLgbmHours.delete(cacheKey);
      }
    }
  }

  async runHourlyCycle(params: {
    targetHourH?: number;
    now?: number;
    universeSymbols?: string[];
    snapshotDir?: string;
    commitRunId?: string;
    lockOwnerJobId?: string;
    force?: boolean;
    retrainLgbm?: boolean;
    skipTrainingIfSameCutoff?: boolean;
    allowNetwork?: boolean;
    commitResearch?: boolean;
    requireChronosReady?: boolean;
    retrainIntervalHours?: number;
    triggerChronosRetrainIfDue?: boolean;
  } = {}): Promise<RollingCycleOutput> {
    const now = params.now ?? this.clock.now();
    const targetHourH = params.targetHourH ?? (Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS);
    const retrainHours = params.retrainIntervalHours ?? this.retrainIntervalHours;
    const curStatus = inspectLocalRollingStatus(this.dataDir, this.workspaceRoot, {
      chronosPython: this.chronosPython,
      retrainIntervalHours: retrainHours,
    });
    const snapshotDir = params.snapshotDir
      ? path.resolve(params.snapshotDir)
      : path.join(this.dataDir, 'model-live', 'cycles', String(targetHourH));
    const cacheKey = JSON.stringify({
      targetHourH,
      snapshotDir,
      universeSymbols: [...(params.universeSymbols ?? [])].map(s => s.toUpperCase()).sort(),
      chronosVersionId: curStatus.chronos2.versionId ?? null,
      lgbmVersionId: curStatus.lgbm.versionId ?? null,
      retrainHours,
      retrainLgbm: params.retrainLgbm ?? true,
      skipTrainingIfSameCutoff: params.skipTrainingIfSameCutoff ?? false,
      allowNetwork: params.allowNetwork ?? true,
      commitResearch: params.commitResearch ?? false,
      requireChronosReady: params.requireChronosReady ?? false,
      commitRunId: params.commitRunId ?? null,
    });

    if (
      !params.force
      && this.lastCachedCycle
      && this.lastCachedCycle.cacheKey === cacheKey
    ) {
      return this.lastCachedCycle.output;
    }

    const existing = this.inFlightHours.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const targetCutoffTime = targetHourH + ONE_HOUR_MS;
      const execResult = await this.runner.runExclusive(
        `rolling-cycle:${targetHourH}`,
        async () => {
        await fsp.mkdir(snapshotDir, { recursive: true });
        const rankOutPath = path.join(snapshotDir, 'rank.json');

        let rankResult: RollingCycleOutput['rankResult'];
        try {
          rankResult = (await this.runner.invokeWorkerWith(
            this.runner.pythonExecutable,
            ['-m', 'research.model_research.worker'],
            {
              action: 'rolling_prepare_and_train_rank',
              dataDir: this.dataDir,
              targetCutoffTime,
              ...(params.universeSymbols?.length ? { universeSymbols: params.universeSymbols } : {}),
              retrainLgbm: params.retrainLgbm ?? true,
              skipTrainingIfSameCutoff: params.skipTrainingIfSameCutoff ?? false,
              allowNetwork: params.allowNetwork ?? true,
              chronosRetrainIntervalHours: retrainHours,
              outputPath: rankOutPath,
            },
            this.rankTimeoutMs,
          )) as RollingCycleOutput['rankResult'];
        } catch (err: any) {
          if (err?.errorCode === 'DATA_NOT_READY') {
            throw new DataNotReadyError(err.message);
          }
          throw err;
        }

        if (!rankResult || rankResult.replay === true || rankResult.inputMode !== 'live') {
          throw Object.assign(new Error('拒絕使用 replay 或非即時模式之 LightGBM 排名結果'), {
            errorCode: 'REPLAY_RESULT_REJECTED',
          });
        }
        if (Number(rankResult.decisionOpenTime) !== targetHourH) {
          throw new DataNotReadyError(
            `排名結果決策小時 (${rankResult.decisionOpenTime}) 與目標小時 (${targetHourH}) 不符`,
          );
        }

        const latestStatus = inspectLocalRollingStatus(this.dataDir, this.workspaceRoot, {
          chronosPython: this.chronosPython,
          retrainIntervalHours: retrainHours,
        });
        if (!latestStatus.chronos2.ready || !latestStatus.chronos2.versionId) {
          if (params.requireChronosReady ?? true) {
            throw Object.assign(
              new Error(
                latestStatus.chronos2.reason
                || '本機 Chronos-2 LoRA 尚未完成首次 GPU 訓練；請先執行本機微調',
              ),
              { errorCode: 'MODEL_OR_DATA_MISSING' },
            );
          }
          return {
            output: null as unknown as RollingCycleOutput,
            chronosDue: true,
          };
        }

        const conflicts = new Set(rankResult.conflictSymbols ?? []);
        const chronosSymbols: string[] = [];
        for (const e of [...(rankResult.longTop5 ?? []).slice(0, 3), ...(rankResult.shortTop5 ?? []).slice(0, 3)]) {
          if (!conflicts.has(e.symbol) && !chronosSymbols.includes(e.symbol)) {
            chronosSymbols.push(e.symbol);
          }
        }

        const chronosCurrentJson = path.join(this.dataDir, 'model-live', 'models', 'chronos2', 'current.json');
        const liveKlinesParquet = path.join(this.dataDir, 'model-live', 'datasets', 'klines_1h.parquet');
        const chronosReqPath = path.join(snapshotDir, 'chronos_request.json');
        const chronosOutPath = path.join(snapshotDir, 'chronos.json');
        const inputDoc: Record<string, unknown> = {
          mode: 'local-rolling',
          decisionOpenTime: targetHourH,
          targetCutoffTime,
          universeSymbols: rankResult.universeSymbols,
          lgbmVersionId: rankResult.lightgbm?.versionId ?? null,
          chronosVersionId: latestStatus.chronos2.versionId,
          startedAt: now,
        };
        await fsp.writeFile(path.join(snapshotDir, 'input.json'), JSON.stringify(inputDoc, null, 2), 'utf8');
        await fsp.writeFile(
          chronosReqPath,
          JSON.stringify(
            {
              liveChronosCurrentJson: chronosCurrentJson,
              liveKlinesParquet,
              expectedVersionId: latestStatus.chronos2.versionId,
              expectedBaseRevision: latestStatus.chronos2.baseRevision,
              symbols: chronosSymbols,
              decisionOpenTime: targetHourH,
              requireCuda: true,
            },
            null,
            2,
          ),
          'utf8',
        );

        const chronosResult = (await this.runner.invokeWorkerWith(
          this.chronosPython,
          ['-m', 'research.model_research.chronos2_live', '--request', chronosReqPath, '--output', chronosOutPath],
          null,
          this.chronosInferTimeoutMs,
          {
            env: {
              HF_HUB_OFFLINE: '1',
              TRANSFORMERS_OFFLINE: '1',
              MPLBACKEND: 'Agg',
            },
          },
        )) as Chronos2LiveOutput;

        if (!chronosResult || Number(chronosResult.decisionOpenTime) !== targetHourH) {
          throw Object.assign(new Error('Chronos-2 推論回傳無效或決策小時不符'), {
            errorCode: 'INVALID_CHRONOS_OUTPUT',
          });
        }
        if (!fs.existsSync(chronosOutPath)) {
          await fsp.writeFile(chronosOutPath, JSON.stringify(chronosResult, null, 2), 'utf8');
        }

        let committedRunId: string | null = null;
        if (params.commitResearch ?? true) {
          committedRunId = params.commitRunId ?? `run-${targetHourH}-chronos2-${randomUUID().slice(0, 6)}`;
          await this.runner.invokeWorkerWith(
            this.runner.pythonExecutable,
            ['-m', 'research.model_research.worker'],
            {
              action: 'commit_rolling_research',
              dataDir: this.dataDir,
              runId: committedRunId,
              rankPath: rankOutPath,
              chronosPath: chronosOutPath,
            },
            30_000,
          );
        }

        const cModelInfo = (chronosResult.modelInfo ?? {}) as Record<string, any>;
        const cHashes = (cModelInfo.adapterHashes ?? {}) as Record<string, string>;
        const modelVersions: HourlyModelVersions = {
          lgbmVersionId: rankResult.lightgbm?.versionId ?? latestStatus.lgbm.versionId ?? null,
          lgbmLongSha256: rankResult.lightgbm.longSha256,
          lgbmShortSha256: rankResult.lightgbm.shortSha256,
          lgbmTrainedAt: rankResult.lightgbm?.trainedAt ?? latestStatus.lgbm.trainedAt ?? null,
          valNdcg5Long: rankResult.lightgbm?.valNdcg5Long ?? latestStatus.lgbm.valNdcg5Long ?? null,
          valNdcg5Short: rankResult.lightgbm?.valNdcg5Short ?? latestStatus.lgbm.valNdcg5Short ?? null,
          chronosVersionId: String(cModelInfo.versionId || latestStatus.chronos2.versionId),
          chronosAdapterSha256: cHashes['adapter/adapter_model.safetensors'] ?? latestStatus.chronos2.adapterSha256 ?? null,
          chronosTrainedAt: (cModelInfo.trainedAt as number | undefined) ?? latestStatus.chronos2.trainedAt ?? null,
          valReturnMae: (cModelInfo.valReturnMae as number | undefined) ?? latestStatus.chronos2.valReturnMae ?? null,
          chronosBaseRevision: String(cModelInfo.baseRevision || latestStatus.chronos2.baseRevision || ''),
        };

        const output: RollingCycleOutput = {
          snapshotDir,
          inputDoc,
          rankResult,
          chronosResult,
          modelVersions,
          committedRunId,
        };

        this.lastCompletedHourH = targetHourH;
        this.lastSuccessAt = this.clock.now();
        this.lastError = null;
        this.lastCachedCycle = {
          cacheKey,
          output,
        };
        this.onHourCompleted?.(output);
        return {
          output,
          chronosDue: Boolean(rankResult.chronosTrainDue),
        };
      },
      { allowDuringJobId: params.lockOwnerJobId },
    );

      if (params.triggerChronosRetrainIfDue && execResult.chronosDue && !this.chronosTrainingPaused) {
        this.maybeScheduleBackgroundChronosRetrain(retrainHours, targetCutoffTime);
      }

      if (!execResult.output) {
        throw Object.assign(new Error('本機 Chronos-2 LoRA 尚未完成首次 GPU 訓練；已先行同步資料並重訓 LightGBM，並排程背景訓練'), {
          errorCode: 'MODEL_OR_DATA_MISSING',
        });
      }

      return execResult.output;
    })();

    this.inFlightHours.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlightHours.get(cacheKey) === promise) {
        this.inFlightHours.delete(cacheKey);
      }
    }
  }

  private maybeScheduleBackgroundChronosRetrain(retrainIntervalHours: number, cutoffTime?: number): void {
    if (this.chronosTrainingPaused || this.isTrainingChronos || this.runner.isBusy()) return;
    const now = this.clock.now();
    const nextHourBoundary = (Math.floor(now / ONE_HOUR_MS) + 1) * ONE_HOUR_MS;
    if (nextHourBoundary - now < Math.max(this.backgroundTrainMarginMs, this.chronosTrainTimeoutMs + 2 * 60_000)) {
      return;
    }
    void this.track(
      this.triggerChronosRetrain({
        reason: 'auto',
        force: false,
        cutoffTime,
        retrainIntervalHours,
      }).catch((err) => {
        console.warn('[RollingPipeline] 背景 Chronos-2 GPU 重訓失敗（保留既有版本）:', err);
      }),
    );
  }

  async triggerChronosRetrain(params: {
    reason?: 'auto' | 'manual';
    force?: boolean;
    cutoffTime?: number;
    retrainIntervalHours?: number;
    maxUpdates?: number;
  } = {}): Promise<Record<string, unknown>> {
    if (this.chronosTrainingPaused) {
      throw new ChronosTrainingPausedError();
    }
    if (this.isTrainingChronos || this.runner.isBusy()) {
      throw new ModelResearchBusyError('chronos2-gpu-train');
    }
    const retrainHours = params.retrainIntervalHours ?? this.retrainIntervalHours;
    if (!params.force) {
      const status = inspectLocalRollingStatus(this.dataDir, this.workspaceRoot, {
        chronosPython: this.chronosPython,
        retrainIntervalHours: retrainHours,
      });
      const lastTrained = status.chronos2.trainedAt;
      if (
        status.chronos2.ready
        && lastTrained !== null
        && lastTrained !== undefined
        && this.clock.now() - lastTrained < retrainHours * ONE_HOUR_MS
      ) {
        return { skipped: true, reason: '尚未達到 Chronos-2 6h 重訓週期' };
      }
    }

    const promise = this.runner.runExclusive('chronos2-gpu-train', async () => {
      const now = this.clock.now();
      const targetCutoff = params.cutoffTime ?? (Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS);
      const livePathsDir = path.join(this.dataDir, 'model-live', 'models', 'chronos2');
      const stateFile = path.join(this.dataDir, 'model-live', 'datasets', 'dataset_state.json');

      // Bootstrap rolling 180d dataset first if missing on disk
      if (!fs.existsSync(stateFile)) {
        await this.runner.invokeWorkerWith(
          this.runner.pythonExecutable,
          ['-m', 'research.model_research.worker'],
          {
            action: 'rolling_prepare_and_train_rank',
            dataDir: this.dataDir,
            targetCutoffTime: targetCutoff,
            retrainLgbm: false,
            requireLatestHour: false,
            allowNetwork: true,
          },
          this.rankTimeoutMs,
        );
      }

      this.isTrainingChronos = true;
      await fsp.mkdir(livePathsDir, { recursive: true });
      await fsp.writeFile(
        path.join(livePathsDir, 'training_status.json'),
        JSON.stringify(
          {
            isTraining: true,
            lastAttemptAt: now,
            retrainIntervalHours: retrainHours,
            reason: params.reason ?? 'manual',
            lastError: null,
          },
          null,
          2,
        ),
        'utf8',
      );

      const reqDir = path.join(this.dataDir, 'model-live', 'tmp');
      await fsp.mkdir(reqDir, { recursive: true });
      const tag = `${now}-${randomUUID().slice(0, 6)}`;
      const reqPath = path.join(reqDir, `train-req-${tag}.json`);
      const outPath = path.join(reqDir, `train-out-${tag}.json`);
      await fsp.writeFile(
        reqPath,
        JSON.stringify(
          {
            dataDir: this.dataDir,
            cutoffTime: targetCutoff,
            retrainIntervalHours: retrainHours,
            requireCuda: true,
            ...(params.maxUpdates !== undefined ? { maxUpdates: params.maxUpdates } : {}),
          },
          null,
          2,
        ),
        'utf8',
      );

      try {
        const result = (await this.runner.invokeWorkerWith(
          this.chronosPython,
          ['-m', 'research.model_research.chronos2_train', '--request', reqPath, '--output', outPath],
          null,
          this.chronosTrainTimeoutMs,
          {
            env: {
              HF_HUB_OFFLINE: '1',
              TRANSFORMERS_OFFLINE: '1',
              MPLBACKEND: 'Agg',
            },
          },
        )) as Record<string, unknown>;
        this.lastError = null;
        return result;
      } catch (err: any) {
        this.lastError = err?.message || String(err);
        await fsp.writeFile(
          path.join(livePathsDir, 'training_status.json'),
          JSON.stringify(
            {
              isTraining: false,
              lastAttemptAt: now,
              retrainIntervalHours: retrainHours,
              lastError: this.lastError,
            },
            null,
            2,
          ),
          'utf8',
        ).catch(() => {});
        throw err;
      } finally {
        this.isTrainingChronos = false;
        this.activeTrainPromise = null;
        await fsp.rm(reqPath, { force: true }).catch(() => {});
        await fsp.rm(outPath, { force: true }).catch(() => {});
      }
    });

    const wrapped = promise.then((res) => {
      if (this.started && this.autoHourlyEnabled && this.lastCompletedHourH === null) {
        const curClosedH = Math.floor(this.clock.now() / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
        void this.track(
          this.runHourlyCycle({
            targetHourH: curClosedH,
            skipTrainingIfSameCutoff: true,
            triggerChronosRetrainIfDue: false,
            commitResearch: true,
            requireChronosReady: true,
          }).catch(() => {}),
        );
      }
      return res;
    });

    this.activeTrainPromise = wrapped;
    return this.track(wrapped);
  }

  getActiveTrainPromise(): Promise<Record<string, unknown>> | null {
    return this.activeTrainPromise;
  }
}
