import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  ChronosForecastItem,
  HourlyModelVersions,
  ModelPaperExperimentRecord,
  RankCandidateEntry,
} from '@fadachi/core';
import { ModelResearchRunner } from '../research/modelResearchRunner.ts';
import { resolveChronosPythonBin, resolveRunsRoot, validateAdapterRun } from './adapters.ts';
import { DataNotReadyError, MarketCacheUpdater } from './marketCache.ts';
import type { RollingModelPipeline } from './rollingPipeline.ts';

const ONE_HOUR_MS = 3_600_000;

export interface ForwardRankOutput {
  inputMode: 'live' | 'replay';
  replay: boolean;
  decisionOpenTime: number;
  cutoffTime: number;
  universeSymbols: string[];
  eligibleCount: number;
  insufficientSymbols: Array<{ symbol: string; reason: string }>;
  longTop5: RankCandidateEntry[];
  shortTop5: RankCandidateEntry[];
  conflictSymbols: string[];
  kronosTargetSymbols: string[];
  chronosTargetSymbols?: string[];
  inputSha256: string;
  inputHashes: Record<string, unknown>;
  lightgbm: {
    longSha256: string;
    shortSha256: string;
    elapsedMs: number;
  };
  generatedAt: number;
}

export interface Chronos2LiveOutput {
  decisionOpenTime: number;
  forecasts: Record<string, ChronosForecastItem>;
  skipped: Array<{ symbol: string; reason: string }>;
  modelInfo: Record<string, unknown>;
  elapsedMs: number;
}

export interface ForwardInferenceOutput {
  snapshotDir: string;
  inputDoc: Record<string, unknown>;
  rankResult: ForwardRankOutput;
  chronosResult: Chronos2LiveOutput;
  modelVersions?: HourlyModelVersions;
}

export interface ForwardInferenceCoordinatorOptions {
  runner: ModelResearchRunner;
  marketCache: MarketCacheUpdater;
  workspaceRoot: string;
  dataDir: string;
  rollingPipeline?: RollingModelPipeline;
  chronosPython?: string;
  runsRoot?: string;
  rankTimeoutMs?: number;
  chronosTimeoutMs?: number;
}

export function resolveChronosPython(workspaceRoot: string, override?: string): string {
  return resolveChronosPythonBin(workspaceRoot, override);
}

export class ForwardInferenceCoordinator {
  readonly runner: ModelResearchRunner;
  readonly marketCache: MarketCacheUpdater;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly rollingPipeline?: RollingModelPipeline;
  readonly chronosPython: string;
  readonly runsRoot: string;
  readonly rankTimeoutMs: number;
  readonly chronosTimeoutMs: number;

  constructor(options: ForwardInferenceCoordinatorOptions) {
    this.runner = options.runner;
    this.marketCache = options.marketCache;
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dataDir = path.resolve(options.dataDir);
    this.rollingPipeline = options.rollingPipeline;
    this.chronosPython = resolveChronosPython(this.workspaceRoot, options.chronosPython);
    this.runsRoot = resolveRunsRoot(this.workspaceRoot, options.runsRoot);
    this.rankTimeoutMs = options.rankTimeoutMs ?? 120_000;
    this.chronosTimeoutMs = options.chronosTimeoutMs ?? 300_000;
  }

  async runHour(params: {
    experiment: ModelPaperExperimentRecord;
    targetHourH: number;
    now: number;
  }): Promise<ForwardInferenceOutput> {
    const { experiment, targetHourH, now } = params;
    const targetCutoffTime = targetHourH + ONE_HOUR_MS;
    const isRollingMode =
      experiment.modelSource?.pipelineMode === 'local-rolling'
      || !experiment.modelSource?.adapterRunDir;

    if (isRollingMode) {
      if (!this.rollingPipeline) {
        throw new Error('RollingModelPipeline 未初始化，無法執行本機滾動模型推論');
      }
      const snapshotDir = path.join(
        this.dataDir,
        'model-paper',
        experiment.id,
        'decisions',
        String(targetHourH),
      );
      const res = await this.rollingPipeline.runHourlyCycle({
        targetHourH,
        now,
        universeSymbols: experiment.universe,
        snapshotDir,
        retrainIntervalHours: experiment.modelSource?.retrainIntervalHours ?? 6,
        skipTrainingIfSameCutoff: true,
        commitResearch: true,
        requireChronosReady: true,
        triggerChronosRetrainIfDue: true,
      });
      return {
        snapshotDir: res.snapshotDir,
        inputDoc: res.inputDoc,
        rankResult: res.rankResult,
        chronosResult: res.chronosResult,
        modelVersions: res.modelVersions,
      };
    }

    // Legacy adapter-run verification path for pre-existing historical runs
    const { modelSource: verifiedSource } = validateAdapterRun(
      this.runsRoot,
      experiment.modelSource.adapterRunDir,
      this.workspaceRoot,
    );
    const sortEntries = (obj: Record<string, string>) =>
      JSON.stringify(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
    if (
      sortEntries(verifiedSource.artifactHashes) !== sortEntries(experiment.modelSource.artifactHashes) ||
      verifiedSource.baseRevision !== experiment.modelSource.baseRevision
    ) {
      throw Object.assign(
        new Error('Chronos-2 adapter 雜湊或基礎模型版本與實驗鎖定值不符'),
        { errorCode: 'ADAPTER_VERIFICATION_FAILED' },
      );
    }

    return this.runner.runExclusive(`model-paper:${experiment.id}:${targetHourH}`, async () => {
      const cacheRes = await this.marketCache.update(experiment.universe, targetHourH, now);

      const snapshotDir = path.join(
        this.dataDir,
        'model-paper',
        experiment.id,
        'decisions',
        String(targetHourH),
      );
      await fsp.mkdir(snapshotDir, { recursive: true });

      const inputDoc: Record<string, unknown> = {
        experimentId: experiment.id,
        decisionOpenTime: targetHourH,
        targetCutoffTime,
        universeSymbols: experiment.universe,
        modelKey: experiment.modelKey,
        modelSource: experiment.modelSource,
        klinesCsvPath: cacheRes.klinesCsvPath,
        fundingCsvPath: cacheRes.fundingCsvPath,
        baseKlinesParquetPath: cacheRes.baseKlinesParquetPath,
        startedAt: now,
      };
      await fsp.writeFile(
        path.join(snapshotDir, 'input.json'),
        JSON.stringify(inputDoc, null, 2),
        'utf8',
      );

      const rankOutPath = path.join(snapshotDir, 'rank.json');
      const rankPayload = {
        action: 'forward_rank',
        dataDir: this.dataDir,
        inputMode: 'live',
        targetCutoffTime,
        universeSymbols: experiment.universe,
        supplementalKlinesCsv: cacheRes.klinesCsvPath,
        supplementalFundingCsv: cacheRes.fundingCsvPath,
        outputPath: rankOutPath,
      };

      const rankResult = (await this.runner.invokeWorkerWith(
        this.runner.pythonExecutable,
        ['-m', 'research.model_research.worker'],
        rankPayload,
        this.rankTimeoutMs,
      )) as ForwardRankOutput;

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

      if (!fs.existsSync(rankOutPath)) {
        await fsp.writeFile(rankOutPath, JSON.stringify(rankResult, null, 2), 'utf8');
      }

      // Candidate symbols: Long Top 3 + Short Top 3 deduplicated, excluding conflictSymbols
      const conflicts = new Set(rankResult.conflictSymbols ?? []);
      const chronosSymbols: string[] = [];
      for (const e of [...(rankResult.longTop5 ?? []).slice(0, 3), ...(rankResult.shortTop5 ?? []).slice(0, 3)]) {
        if (!conflicts.has(e.symbol) && !chronosSymbols.includes(e.symbol)) {
          chronosSymbols.push(e.symbol);
        }
      }

      const chronosReqPath = path.join(snapshotDir, 'chronos_request.json');
      const chronosOutPath = path.join(snapshotDir, 'chronos.json');
      await fsp.writeFile(
        chronosReqPath,
        JSON.stringify(
          {
            adapterRunDir: experiment.modelSource.adapterRunDir,
            expectedAdapterHashes: experiment.modelSource.artifactHashes,
            expectedBaseRevision: experiment.modelSource.baseRevision,
            klinesCsv: cacheRes.klinesCsvPath,
            baseKlinesParquet: cacheRes.baseKlinesParquetPath,
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
        this.chronosTimeoutMs,
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

      return {
        snapshotDir,
        inputDoc,
        rankResult,
        chronosResult,
      };
    });
  }
}
