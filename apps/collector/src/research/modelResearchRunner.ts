import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import {
  type KronosModelKey,
  type ModelResearchJobRecord,
  type ModelResearchRunResult,
  type ModelResearchStatusResponse,
  evaluateResearchValidityStatus,
  isResearchRunExpired,
} from '@fadachi/core';
import type { RollingModelPipeline } from '../modelPaper/rollingPipeline.ts';

export type SpawnResearchWorker = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface ModelResearchRunnerOptions {
  dataDir: string;
  workspaceRoot?: string;
  pythonExecutable?: string;
  workerScript?: string;
  spawnWorker?: SpawnResearchWorker;
  jobTimeoutMs?: number;
  statusTimeoutMs?: number;
}

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_STATUS_TIMEOUT_MS = 30 * 1000;

function isValidRunResult(value: any): value is ModelResearchRunResult {
  return Boolean(value && typeof value === 'object'
    && typeof value.runId === 'string' && /^run-[A-Za-z0-9_-]{1,120}$/.test(value.runId)
    && ['small', 'base', 'chronos2'].includes(value.kronosModel) && value.market === 'futures'
    && ['SUCCESS', 'INSUFFICIENT_DATA'].includes(value.status)
    && Number.isFinite(value.cutoffTime) && Number.isFinite(value.expiresAt)
    && value.expiresAt > value.cutoffTime && Number.isFinite(value.generatedAt)
    && Array.isArray(value.rankings?.longTop5) && Array.isArray(value.rankings?.shortTop5)
    && Array.isArray(value.rankings?.allRankings) && Array.isArray(value.rankings?.conflictSymbols)
    && value.forecasts && typeof value.forecasts === 'object' && !Array.isArray(value.forecasts));
}

function resolveWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(current, 'research', 'model_research', 'worker.py'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

export class ModelResearchBusyError extends Error {
  readonly activeJobId: string;
  constructor(activeJobId: string) {
    super('模型推論工作忙碌中，同時僅允許執行一個推論工作');
    this.name = 'ModelResearchBusyError';
    this.activeJobId = activeJobId;
  }
}

export class ModelResearchRunner {
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly pythonExecutable: string;
  readonly workerScript: string;
  readonly jobTimeoutMs: number;
  readonly statusTimeoutMs: number;
  private readonly spawnWorker: SpawnResearchWorker;
  private readonly nativeSpawn: boolean;

  private activeJob: ModelResearchJobRecord | null = null;
  private activeExclusiveLabel: string | null = null;
  private rollingPipeline: RollingModelPipeline | null = null;
  private lastJob: ModelResearchJobRecord | null = null;
  private readonly jobs = new Map<string, ModelResearchJobRecord>();
  private readonly activeProcesses = new Set<ChildProcessWithoutNullStreams>();
  private readonly runProcesses = new Set<ChildProcessWithoutNullStreams>();

  constructor(options: ModelResearchRunnerOptions) {
    this.workspaceRoot = options.workspaceRoot
      ? path.resolve(options.workspaceRoot)
      : resolveWorkspaceRoot(process.cwd());
    const candidateDataDir = path.resolve(options.dataDir);
    if (
      !fs.existsSync(path.join(candidateDataDir, 'model-research', 'datasets', 'klines_1h.parquet')) &&
      fs.existsSync(path.join(this.workspaceRoot, 'data', 'model-research', 'datasets', 'klines_1h.parquet')) &&
      (candidateDataDir.endsWith(path.join('apps', 'collector', 'data')) ||
       candidateDataDir === path.join(this.workspaceRoot, 'apps', 'collector', 'data'))
    ) {
      this.dataDir = path.join(this.workspaceRoot, 'data');
    } else {
      this.dataDir = candidateDataDir;
    }

    this.pythonExecutable = options.pythonExecutable
      ? path.resolve(options.pythonExecutable)
      : process.platform === 'win32'
        ? path.join(this.workspaceRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(this.workspaceRoot, '.venv', 'bin', 'python');
    this.workerScript = options.workerScript
      ? path.resolve(options.workerScript)
      : path.join(this.workspaceRoot, 'research', 'model_research', 'worker.py');
    this.spawnWorker = options.spawnWorker ?? ((cmd, args, opts) => spawn(cmd, args, opts) as ChildProcessWithoutNullStreams);
    this.nativeSpawn = !options.spawnWorker;
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.statusTimeoutMs = options.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    this.loadPersistedFailedJobs();
  }

  private loadPersistedFailedJobs(): void {
    try {
      const dirs = ['failed-jobs', 'completed-jobs'].map(name => path.join(this.dataDir, 'model-research', name));
      const entries = dirs.flatMap(dir => fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name)) : []);
      let newestJob: ModelResearchJobRecord | null = null;
      let newestTime = -1;
      for (const entry of entries) {
        try {
          const raw = JSON.parse(fs.readFileSync(entry, 'utf8')) as ModelResearchJobRecord;
          if (raw && typeof raw.jobId === 'string') {
            this.jobs.set(raw.jobId, raw);
            const t = raw.completedAt ?? raw.createdAt ?? 0;
            if (t > newestTime) {
              newestTime = t;
              newestJob = raw;
            }
          }
        } catch {
          /* ignore malformed file */
        }
      }
      if (newestJob) {
        this.lastJob = newestJob;
      }
    } catch {
      /* ignore */
    }
  }

  attachRollingPipeline(pipeline: RollingModelPipeline): void {
    this.rollingPipeline = pipeline;
  }

  getRollingPipeline(): RollingModelPipeline | null {
    return this.rollingPipeline;
  }

  isBusy(): boolean {
    return this.activeJob !== null || this.activeExclusiveLabel !== null || this.runProcesses.size > 0;
  }

  async runExclusive<T>(
    label: string,
    fn: () => Promise<T>,
    options: { allowDuringJobId?: string } = {},
  ): Promise<T> {
    const allowedActiveJob = Boolean(
      options.allowDuringJobId
      && this.activeJob?.jobId === options.allowDuringJobId
      && this.activeExclusiveLabel === null
      && this.runProcesses.size === 0,
    );
    if (this.isBusy() && !allowedActiveJob) {
      throw new ModelResearchBusyError(
        this.activeJob?.jobId ?? this.activeExclusiveLabel ?? this.lastJob?.jobId ?? 'terminating-worker',
      );
    }
    this.activeExclusiveLabel = label;
    try {
      return await fn();
    } finally {
      if (this.activeExclusiveLabel === label) {
        this.activeExclusiveLabel = null;
      }
    }
  }

  getJob(jobId: string): ModelResearchJobRecord | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.result) {
      return {
        ...job,
        result: this.decorateRunResult(job.result),
      };
    }
    return { ...job };
  }

  private decorateRunResult(result: ModelResearchRunResult, now = Date.now()): ModelResearchRunResult {
    const expired = isResearchRunExpired(result, now);
    const validityStatus = evaluateResearchValidityStatus(result, now);
    return {
      ...result,
      isExpired: expired,
      validityStatus,
    };
  }

  async getLatestResult(now = Date.now()): Promise<ModelResearchRunResult | null> {
    const mrDir = path.join(this.dataDir, 'model-research');
    const pointerPath = path.join(mrDir, 'latest-run.json');
    if (!fs.existsSync(pointerPath)) return null;
    try {
      const pointer = JSON.parse(await fsp.readFile(pointerPath, 'utf8'));
      const runId = pointer?.runId;
      if (typeof runId !== 'string' || !/^run-[A-Za-z0-9_-]{1,120}$/.test(runId)) return null;
      const resultPath = path.join(mrDir, runId, 'result.json');
      if (!fs.existsSync(resultPath)) return null;
      const rawResult = JSON.parse(await fsp.readFile(resultPath, 'utf8')) as ModelResearchRunResult;
      if (!isValidRunResult(rawResult) || rawResult.runId !== runId) return null;
      return this.decorateRunResult(rawResult, now);
    } catch {
      return null;
    }
  }

  async getStatus(now = Date.now()): Promise<ModelResearchStatusResponse> {
    const latest = await this.getLatestResult(now);
    const latestRunSummary = latest
      ? {
          runId: latest.runId,
          kronosModel: latest.kronosModel,
          cutoffTime: latest.cutoffTime,
          expiresAt: latest.expiresAt,
          generatedAt: latest.generatedAt,
          isExpired: Boolean(latest.isExpired),
          validityStatus: latest.validityStatus ?? evaluateResearchValidityStatus(latest, now),
        }
      : null;

    if (this.nativeSpawn && (!fs.existsSync(this.pythonExecutable) || !fs.existsSync(this.workerScript))) {
      return {
        configured: false,
        pythonAvailable: false,
        pythonExecutable: this.pythonExecutable,
        datasetReady: false,
        universeSymbols: [],
        insufficientSymbols: [],
        lightgbmReady: false,
        kronosModels: {
          small: {
            modelKey: 'small',
            repoId: 'NeoQuasar/Kronos-small',
            tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
            installed: false,
            revision: 'unknown',
            tokenizerRevision: 'unknown',
          },
          base: {
            modelKey: 'base',
            repoId: 'NeoQuasar/Kronos-base',
            tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
            installed: false,
            revision: 'unknown',
            tokenizerRevision: 'unknown',
          },
        },
        offlineComparisonReady: false,
        isBusy: this.isBusy(),
        activeJob: this.activeJob ? { ...this.activeJob } : null,
        lastJob: this.lastJob ? { ...this.lastJob } : null,
        latestRunSummary,
        statusReason: '專案虛擬環境 .venv 或研究 worker 腳本尚未就緒',
      };
    }

    try {
      const workerStatus = await this.invokeWorker(
        {
          action: 'status',
          dataDir: this.dataDir,
        },
        this.statusTimeoutMs,
      );

      const configured = Boolean(
        workerStatus.datasetReady
        && workerStatus.lightgbmReady
        && (workerStatus.kronosModels?.small?.installed || workerStatus.kronosModels?.base?.installed || workerStatus.chronos2?.installed),
      );

      let statusReason: string | undefined;
      if (!workerStatus.datasetReady) {
        statusReason = '研究資料集尚未準備（請先執行 CLI prepare-data）';
      } else if (!workerStatus.lightgbmReady) {
        statusReason = 'LightGBM 排名模型尚未訓練（請先執行 CLI train-lgbm）';
      } else if (!workerStatus.kronosModels?.small?.installed && !workerStatus.kronosModels?.base?.installed && !workerStatus.chronos2?.installed) {
        statusReason = '預測模型尚未安裝（請匯入 Chronos-2 adapter 或準備 Kronos 權重）';
      }

      const liveSchedule = this.rollingPipeline?.getStatus();
      const rollingPipeline = workerStatus.rollingPipeline
        ? {
            ...workerStatus.rollingPipeline,
            ...(liveSchedule?.autoSchedule ? { autoSchedule: liveSchedule.autoSchedule } : {}),
            chronos2: {
              ...workerStatus.rollingPipeline.chronos2,
              isTraining: liveSchedule?.chronos2?.isTraining ?? workerStatus.rollingPipeline.chronos2?.isTraining ?? false,
            },
          }
        : liveSchedule ?? null;

      const chronosStatusReport = workerStatus.rollingPipeline
        ? {
            ...workerStatus.chronos2,
            installed: Boolean(rollingPipeline?.chronos2?.ready ?? workerStatus.chronos2?.installed),
            reason: rollingPipeline?.chronos2?.reason ?? workerStatus.chronos2?.reason,
            versionId: rollingPipeline?.chronos2?.versionId,
            trainedAt: rollingPipeline?.chronos2?.trainedAt,
            valReturnMae: rollingPipeline?.chronos2?.valReturnMae,
            nextRetrainAt: rollingPipeline?.chronos2?.nextRetrainAt,
            isTraining: rollingPipeline?.chronos2?.isTraining,
            lastError: rollingPipeline?.chronos2?.lastError,
          }
        : workerStatus.chronos2;

      return {
        configured,
        pythonAvailable: true,
        pythonExecutable: workerStatus.pythonExecutable ?? this.pythonExecutable,
        pythonVersion: workerStatus.pythonVersion,
        gpuEnvironment: workerStatus.gpuEnvironment,
        datasetReady: Boolean(workerStatus.datasetReady),
        datasetVersion: workerStatus.datasetVersion ?? null,
        datasetCutoffTime: workerStatus.datasetCutoffTime ?? null,
        universeSymbols: Array.isArray(workerStatus.universeSymbols) ? workerStatus.universeSymbols : [],
        insufficientSymbols: Array.isArray(workerStatus.insufficientSymbols) ? workerStatus.insufficientSymbols : [],
        lightgbmReady: Boolean(workerStatus.lightgbmReady),
        lightgbmMetadata: workerStatus.lightgbmMetadata ?? null,
        artifactWarnings: Array.isArray(workerStatus.artifactWarnings) ? workerStatus.artifactWarnings : [],
        chronos2: chronosStatusReport,
        rollingPipeline,
        kronosModels: workerStatus.kronosModels ?? {
          small: {
            modelKey: 'small',
            repoId: 'NeoQuasar/Kronos-small',
            tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
            installed: false,
            revision: 'unknown',
            tokenizerRevision: 'unknown',
          },
          base: {
            modelKey: 'base',
            repoId: 'NeoQuasar/Kronos-base',
            tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
            installed: false,
            revision: 'unknown',
            tokenizerRevision: 'unknown',
          },
        },
        offlineComparisonReady: Boolean(workerStatus.offlineComparisonReady),
        offlineComparison: workerStatus.offlineComparison ?? null,
        isBusy: this.isBusy(),
        activeJob: this.activeJob ? { ...this.activeJob } : null,
        lastJob: this.lastJob ? { ...this.lastJob } : null,
        latestRunSummary,
        statusReason,
      };
    } catch (err: any) {
      return {
        configured: false,
        pythonAvailable: false,
        pythonExecutable: this.pythonExecutable,
        datasetReady: false,
        universeSymbols: [],
        insufficientSymbols: [],
        lightgbmReady: false,
        kronosModels: {
          small: {
            modelKey: 'small',
            repoId: 'NeoQuasar/Kronos-small',
            tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
            installed: false,
            revision: 'unknown',
            tokenizerRevision: 'unknown',
          },
          base: {
            modelKey: 'base',
            repoId: 'NeoQuasar/Kronos-base',
            tokenizerRepoId: 'NeoQuasar/Kronos-Tokenizer-base',
            installed: false,
            revision: 'unknown',
            tokenizerRevision: 'unknown',
          },
        },
        offlineComparisonReady: false,
        isBusy: this.isBusy(),
        activeJob: this.activeJob ? { ...this.activeJob } : null,
        lastJob: this.lastJob ? { ...this.lastJob } : null,
        latestRunSummary,
        statusReason: err?.message || '查詢研究環境狀態失敗',
      };
    }
  }

  startRunJob(options: {
    kronosModel?: KronosModelKey;
    cutoffTime?: number;
    _simulateFailure?: string;
  } = {}): ModelResearchJobRecord {
    if (this.isBusy()) {
      throw new ModelResearchBusyError(this.activeJob?.jobId ?? this.lastJob?.jobId ?? 'terminating-worker');
    }

    const kronosModel: KronosModelKey = options.kronosModel === 'chronos2' ? 'chronos2' : options.kronosModel === 'base' ? 'base' : 'small';
    const now = Date.now();
    const jobId = `job-${now}-${randomUUID().slice(0, 8)}`;
    const runId = `run-${now}-${kronosModel}-${randomUUID().slice(0, 6)}`;

    const job: ModelResearchJobRecord = {
      jobId,
      runId,
      kronosModel,
      status: 'RUNNING',
      createdAt: now,
      startedAt: now,
    };

    this.activeJob = job;
    this.jobs.set(jobId, job);
    if (this.jobs.size > 25) {
      for (const [oldId, oldJob] of this.jobs.entries()) {
        if (oldId !== jobId && oldJob.status !== 'RUNNING') {
          this.jobs.delete(oldId);
          if (this.jobs.size <= 25) break;
        }
      }
    }

    void this.executeJob(job, options).finally(() => {
      if (this.activeJob?.jobId === job.jobId) {
        this.activeJob = null;
      }
      this.lastJob = { ...job };
    });

    return { ...job };
  }

  private async executeJob(
    job: ModelResearchJobRecord,
    options: { kronosModel?: KronosModelKey; cutoffTime?: number; _simulateFailure?: string },
  ): Promise<void> {
    if (this.nativeSpawn && (!fs.existsSync(this.pythonExecutable) || !fs.existsSync(this.workerScript))) {
      job.status = 'FAILED';
      job.completedAt = Date.now();
      job.errorCode = 'PYTHON_ENV_MISSING';
      job.errorMessage = '專案 .venv Python 執行檔或 worker 腳本不存在';
      this.persistFailedJobRecord(job);
      return;
    }

    try {
      let rawResult: ModelResearchRunResult;
      if (
        this.rollingPipeline
        && options.cutoffTime === undefined
        && !options._simulateFailure
        && job.kronosModel === 'chronos2'
      ) {
        const now = Date.now();
        const targetHourH = Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000;
        const cycleRes = await this.rollingPipeline.runHourlyCycle({
          targetHourH,
          now,
          commitRunId: job.runId,
          lockOwnerJobId: job.jobId,
          force: true,
          retrainLgbm: true,
          commitResearch: true,
          requireChronosReady: true,
          triggerChronosRetrainIfDue: false,
        });
        const committedPath = path.join(
          this.dataDir,
          'model-research',
          cycleRes.committedRunId || job.runId,
          'result.json',
        );
        rawResult = JSON.parse(await fsp.readFile(committedPath, 'utf8')) as ModelResearchRunResult;
      } else {
        const payload: Record<string, unknown> = {
          action: 'run',
          runId: job.runId,
          dataDir: this.dataDir,
          kronosModel: job.kronosModel,
          ...(this.rollingPipeline && options.cutoffTime === undefined ? { useRolling: true, retrainLgbm: true } : {}),
        };
        if (options.cutoffTime !== undefined) payload.cutoffTime = options.cutoffTime;
        if (options._simulateFailure) payload._simulateFailure = options._simulateFailure;

        rawResult = (await this.invokeWorker(payload, this.jobTimeoutMs)) as ModelResearchRunResult;
      }
      if (!isValidRunResult(rawResult) || rawResult.runId !== job.runId || rawResult.kronosModel !== job.kronosModel) {
        throw Object.assign(new Error('Worker 回傳結構無效'), { errorCode: 'INVALID_WORKER_OUTPUT' });
      }

      const decorated = this.decorateRunResult(rawResult);
      job.status = 'SUCCEEDED';
      job.completedAt = Date.now();
      job.result = decorated;
      this.persistFailedJobRecord(job);
    } catch (err: any) {
      job.status = 'FAILED';
      job.completedAt = Date.now();
      job.errorCode = err?.errorCode || 'WORKER_FAILED';
      job.errorMessage = err?.message || '模型推論執行失敗';
      this.persistFailedJobRecord(job);
    }
  }

  private persistFailedJobRecord(job: ModelResearchJobRecord): void {
    try {
      const failedDir = path.join(this.dataDir, 'model-research', job.status === 'FAILED' ? 'failed-jobs' : 'completed-jobs');
      fs.mkdirSync(failedDir, { recursive: true });
      fs.writeFileSync(
        path.join(failedDir, `${job.jobId}.json`),
        JSON.stringify(job, null, 2),
        'utf8',
      );
    } catch {
      /* ignore best-effort failure log write */
    }
  }

  private invokeWorker(requestPayload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    return this.invokeWorkerWith(
      this.pythonExecutable,
      ['-m', 'research.model_research.worker'],
      requestPayload,
      timeoutMs,
      { trackBusy: requestPayload.action === 'run' },
    );
  }

  invokeWorkerWith(
    pythonExecutable: string,
    args: string[],
    requestPayload: Record<string, unknown> | null,
    timeoutMs: number,
    options: { env?: NodeJS.ProcessEnv; cwd?: string; trackBusy?: boolean } = {},
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        FADACHI_DATA: this.dataDir,
        ...(options.env ?? {}),
      };

      const child = this.spawnWorker(
        pythonExecutable,
        args,
        {
          cwd: options.cwd ?? this.workspaceRoot,
          env,
          windowsHide: true,
          shell: false,
        },
      );
      const trackBusy = options.trackBusy ?? true;
      this.activeProcesses.add(child);
      if (trackBusy) this.runProcesses.add(child);
      child.once('close', () => {
        this.activeProcesses.delete(child);
        this.runProcesses.delete(child);
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let parsedProtocolEvent: any = null;
      const stdoutDecoder = new StringDecoder('utf8');

      const finish = (err?: Error & { errorCode?: string }, data?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.terminateChild(child);
          reject(err);
        } else {
          resolve(data);
        }
      };

      const timer = setTimeout(() => {
        const timeoutErr = Object.assign(
          new Error(`模型推論工作超時（超過 ${Math.round(timeoutMs / 1000)} 秒）`),
          { errorCode: 'WORKER_TIMEOUT' },
        );
        finish(timeoutErr);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          finish(Object.assign(new Error('Worker stdout 超過上限'), { errorCode: 'STDOUT_LIMIT_EXCEEDED' }));
          return;
        }
        stdoutBuf += stdoutDecoder.write(chunk);
        let newlineIdx: number;
        while (!settled && (newlineIdx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, newlineIdx).trim();
          stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (!msg || typeof msg !== 'object' || !('event' in msg)) {
              finish(
                Object.assign(new Error('Worker stdout 包含非 JSONL 協定內容'), {
                  errorCode: 'INVALID_PROTOCOL_OUTPUT',
                }),
              );
              return;
            }
            if (parsedProtocolEvent || !['result', 'error'].includes(msg.event)) {
              finish(Object.assign(new Error('Worker 終止協定訊息重複或未知'), { errorCode: 'INVALID_PROTOCOL_OUTPUT' }));
              return;
            }
            parsedProtocolEvent = msg;
          } catch {
            finish(
              Object.assign(new Error(`Worker 輸出非合法 JSON：${line.slice(0, 120)}`), {
                errorCode: 'INVALID_JSON_OUTPUT',
              }),
            );
            return;
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_STDERR_BYTES) {
          stderrBuf += chunk.toString('utf8');
        }
      });

      child.on('error', (err) => {
        finish(
          Object.assign(new Error(`無法啟動 Python 研究 Worker：${err.message}`), {
            errorCode: 'WORKER_SPAWN_ERROR',
          }),
        );
      });

      child.stdin.on('error', () => {
        /* handled by close/error */
      });

      child.on('close', (code) => {
        if (settled) return;
        stdoutBuf += stdoutDecoder.end();
        const leftover = stdoutBuf.trim();
        if (leftover) {
          try {
            const msg = JSON.parse(leftover);
            if (msg && typeof msg === 'object' && ['result', 'error'].includes(msg.event) && !parsedProtocolEvent) {
              parsedProtocolEvent = msg;
            } else {
              finish(
                Object.assign(new Error('Worker stdout 包含非 JSONL 協定內容'), {
                  errorCode: 'INVALID_PROTOCOL_OUTPUT',
                }),
              );
              return;
            }
          } catch {
            finish(
              Object.assign(new Error(`Worker 輸出非合法 JSON：${leftover.slice(0, 120)}`), {
                errorCode: 'INVALID_JSON_OUTPUT',
              }),
            );
            return;
          }
        }

        if (parsedProtocolEvent?.event === 'error') {
          finish(
            Object.assign(new Error(parsedProtocolEvent.message || 'Worker 回報錯誤'), {
              errorCode: parsedProtocolEvent.errorCode || 'WORKER_ERROR',
            }),
          );
          return;
        }

        if (code !== 0) {
          const diag = stderrBuf.trim().split(/\r?\n/).slice(-5).join(' | ');
          finish(
            Object.assign(
              new Error(`Worker 異常退出 (exit code ${code})${diag ? `：${diag}` : ''}`),
              { errorCode: 'WORKER_EXIT_NONZERO' },
            ),
          );
          return;
        }

        if (!parsedProtocolEvent || parsedProtocolEvent.event !== 'result' || !parsedProtocolEvent.data) {
          finish(
            Object.assign(new Error('Worker 結束但未輸出有效 result 協定訊息'), {
              errorCode: 'MISSING_RESULT_EVENT',
            }),
          );
          return;
        }

        finish(undefined, parsedProtocolEvent.data);
      });

      if (requestPayload !== null) {
        child.stdin.end(JSON.stringify(requestPayload) + '\n');
      } else {
        child.stdin.end();
      }
    });
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    try {
      child.stdin.destroy();
    } catch {}
    if (child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid && this.nativeSpawn) {
      const killer = spawn(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, stdio: 'ignore' },
      );
      killer.on('error', () => {
        try { child.kill(); } catch {}
      });
      killer.unref();
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  close(): void {
    for (const child of this.activeProcesses) {
      this.terminateChild(child);
    }
    this.activeProcesses.clear();
  }
}
