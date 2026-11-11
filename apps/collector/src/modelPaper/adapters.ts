import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AdapterRunSummary,
  ModelSource,
  RollingPipelineStatus,
} from '@fadachi/core';

export interface AssetLockChronos2 {
  repo_id: string;
  revision: string;
  files: Record<string, string>;
}

export function resolveRunsRoot(workspaceRoot: string, runsRootOverride?: string): string {
  if (runsRootOverride) return path.resolve(runsRootOverride);
  if (process.env.FADACHI_MODEL_BENCHMARK_RUNS_ROOT) {
    return path.resolve(process.env.FADACHI_MODEL_BENCHMARK_RUNS_ROOT);
  }
  return path.resolve(workspaceRoot, 'data', 'model-benchmark', 'runs');
}

export function readChronosAssetLock(workspaceRoot: string): AssetLockChronos2 {
  const lockPath = path.resolve(workspaceRoot, 'research', 'model_benchmark', 'model-assets.lock.json');
  const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const chronos = raw?.models?.chronos2;
  if (!chronos || typeof chronos.revision !== 'string' || !chronos.files) {
    throw new Error('model-assets.lock.json 缺少 models.chronos2 鎖定設定');
  }
  return chronos as AssetLockChronos2;
}

function sha256File(filePath: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex').toLowerCase();
}

function isInsideDir(parentDir: string, childPath: string): boolean {
  const rel = path.relative(parentDir, childPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function rebaseAttemptDir(runDir: string, rawAttemptDir: string): string {
  const realRunDir = fs.realpathSync(runDir);
  const runName = path.basename(runDir);
  const parts = String(rawAttemptDir).replace(/\\/g, '/').split('/').filter(Boolean);
  const isAbs = rawAttemptDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawAttemptDir);
  let relParts = parts;
  if (isAbs) {
    const idx = parts.lastIndexOf(runName);
    if (idx < 0 || idx === parts.length - 1) {
      throw new Error(`無法重定位 attempt_dir：${rawAttemptDir}`);
    }
    relParts = parts.slice(idx + 1);
  }
  const candidate = path.resolve(realRunDir, ...relParts);
  if (!fs.existsSync(candidate)) {
    throw new Error(`找不到 attempt 目錄：${candidate}`);
  }
  const realCandidate = fs.realpathSync(candidate);
  if (!isInsideDir(realRunDir, realCandidate)) {
    throw new Error(`attempt_dir 越出 run 目錄範圍：${rawAttemptDir}`);
  }
  return realCandidate;
}

export function validateAdapterRun(
  runsRoot: string,
  adapterRunDirInput: string,
  workspaceRoot: string,
): { summary: AdapterRunSummary; modelSource: ModelSource } {
  if (!fs.existsSync(runsRoot)) {
    throw new Error(`找不到 benchmark runs 目錄：${runsRoot}`);
  }
  const realRunsRoot = fs.realpathSync(runsRoot);
  const candidateRunDir = path.isAbsolute(adapterRunDirInput)
    ? path.resolve(adapterRunDirInput)
    : path.resolve(realRunsRoot, adapterRunDirInput);

  if (!fs.existsSync(candidateRunDir)) {
    throw new Error(`找不到指定的 adapter run 目錄：${adapterRunDirInput}`);
  }
  const realRunDir = fs.realpathSync(candidateRunDir);
  if (!isInsideDir(realRunsRoot, realRunDir)) {
    throw new Error('adapterRunDir 必須位於 RUNS_ROOT 目錄之下');
  }

  const manifestPath = path.join(realRunDir, 'run_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`run 目錄缺少 run_manifest.json：${path.basename(realRunDir)}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const runId = String(manifest?.run_id || path.basename(realRunDir));
  const chronos = manifest?.models?.chronos2;
  if (!chronos || chronos.status !== 'SUCCESS') {
    throw new Error(`run ${runId} 的 models.chronos2 狀態並非 SUCCESS`);
  }

  const lock = readChronosAssetLock(workspaceRoot);
  const trainingRevision = chronos?.training?.revision ? String(chronos.training.revision) : null;
  if (trainingRevision && trainingRevision !== lock.revision) {
    throw new Error(`Adapter 訓練基礎模型版本 (${trainingRevision}) 與鎖定版本 (${lock.revision}) 不符`);
  }

  const attemptDir = rebaseAttemptDir(realRunDir, String(chronos.attempt_dir || ''));
  const rawHashes = chronos.artifact_hashes;
  if (!rawHashes || typeof rawHashes !== 'object' || Array.isArray(rawHashes)) {
    throw new Error(`run ${runId} 缺少 models.chronos2.artifact_hashes`);
  }

  const normalizedHashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHashes)) {
    const normKey = k.replace(/\\/g, '/');
    const digest = String(v).toLowerCase();
    normalizedHashes[normKey] = digest;

    const filePath = path.resolve(attemptDir, normKey);
    if (!fs.existsSync(filePath)) {
      throw new Error(`缺少 adapter 產物檔案：${normKey}`);
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || !isInsideDir(attemptDir, fs.realpathSync(filePath))) {
      throw new Error(`adapter 產物路徑不合法：${normKey}`);
    }
    if (sha256File(filePath) !== digest) {
      throw new Error(`adapter 檔案雜湊不符：${normKey}`);
    }
  }

  const innerShaPath = path.join(attemptDir, 'adapter', 'adapter.sha256.json');
  if (!fs.existsSync(innerShaPath)) {
    throw new Error('缺少 adapter/adapter.sha256.json');
  }
  const innerHashesRaw = JSON.parse(fs.readFileSync(innerShaPath, 'utf8')) as Record<string, string>;
  const adapterSha256Json: Record<string, string> = {};
  const adapterDir = path.join(attemptDir, 'adapter');
  for (const [name, expected] of Object.entries(innerHashesRaw)) {
    const filePath = path.resolve(adapterDir, name);
    if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink() || !isInsideDir(adapterDir, fs.realpathSync(filePath))) {
      throw new Error(`adapter.sha256.json 檔案缺失或路徑不合法：${name}`);
    }
    const actual = sha256File(filePath);
    if (actual !== String(expected).toLowerCase()) {
      throw new Error(`adapter.sha256.json 驗證失敗：${name}`);
    }
    adapterSha256Json[name] = actual;
  }

  if (!normalizedHashes['adapter/adapter_config.json'] || !normalizedHashes['adapter/adapter_model.safetensors']) {
    throw new Error('artifact_hashes 缺少必要之 adapter_config.json 或 adapter_model.safetensors');
  }

  const summary: AdapterRunSummary = {
    runId,
    runDir: realRunDir,
    attemptDir,
    status: String(chronos.status),
    smoke: Boolean(manifest?.smoke || chronos?.training?.config?.smoke),
    startedUtc: manifest?.started_utc ?? null,
    finishedUtc: manifest?.finished_utc ?? null,
    fingerprint: chronos?.fingerprint ?? null,
    baseRepoId: lock.repo_id,
    baseRevision: lock.revision,
    artifactHashes: normalizedHashes,
    valid: true,
    validationError: null,
  };

  const modelSource: ModelSource = {
    adapterRunId: runId,
    adapterRunDir: realRunDir,
    attemptDir,
    artifactHashes: normalizedHashes,
    adapterSha256Json,
    fingerprint: chronos?.fingerprint ?? null,
    baseRepoId: lock.repo_id,
    baseRevision: lock.revision,
    baseFiles: { ...lock.files },
  };

  return { summary, modelSource };
}

export function listChronos2Adapters(
  workspaceRoot: string,
  runsRootOverride?: string,
): { runsRoot: string; defaultRunDir: string | null; adapters: AdapterRunSummary[] } {
  const runsRoot = resolveRunsRoot(workspaceRoot, runsRootOverride);
  if (!fs.existsSync(runsRoot)) {
    return { runsRoot, defaultRunDir: null, adapters: [] };
  }

  const entries = fs.readdirSync(runsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
  const adapters: AdapterRunSummary[] = [];

  for (const entry of entries) {
    const runDir = path.join(runsRoot, entry.name);
    const manifestPath = path.join(runDir, 'run_manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const { summary } = validateAdapterRun(runsRoot, runDir, workspaceRoot);
      adapters.push(summary);
    } catch (err: any) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const chronos = manifest?.models?.chronos2;
        adapters.push({
          runId: String(manifest?.run_id || entry.name),
          runDir: path.resolve(runDir),
          attemptDir: String(chronos?.attempt_dir || ''),
          status: String(chronos?.status || 'MISSING'),
          smoke: Boolean(manifest?.smoke || chronos?.training?.config?.smoke),
          startedUtc: manifest?.started_utc ?? null,
          finishedUtc: manifest?.finished_utc ?? null,
          fingerprint: chronos?.fingerprint ?? null,
          baseRepoId: 'amazon/chronos-2',
          baseRevision: chronos?.training?.revision ?? null,
          artifactHashes: {},
          valid: false,
          validationError: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* ignore unreadable manifest */
      }
    }
  }

  adapters.sort((a, b) => {
    const timeA = Date.parse(a.finishedUtc || a.startedUtc || '') || 0;
    const timeB = Date.parse(b.finishedUtc || b.startedUtc || '') || 0;
    return timeB - timeA || b.runId.localeCompare(a.runId);
  });

  const defaultAdapter =
    adapters.find(a => a.valid && a.status === 'SUCCESS' && !a.smoke) ??
    adapters.find(a => a.valid && a.status === 'SUCCESS');
  if (defaultAdapter) {
    defaultAdapter.isDefault = true;
  }

  return {
    runsRoot,
    defaultRunDir: defaultAdapter?.runDir ?? null,
    adapters,
  };
}

function readJsonSafe(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function resolveChronosPythonBin(workspaceRoot: string, override?: string): string {
  if (override) return path.resolve(override);
  return process.platform === 'win32'
    ? path.join(workspaceRoot, '.benchmark-envs', 'chronos', 'Scripts', 'python.exe')
    : path.join(workspaceRoot, '.benchmark-envs', 'chronos', 'bin', 'python');
}

export function inspectLocalRollingStatus(
  dataDir: string,
  workspaceRoot: string,
  opts: { chronosPython?: string; isTrainingChronos?: boolean; retrainIntervalHours?: number } = {},
): RollingPipelineStatus {
  const liveRoot = path.join(path.resolve(dataDir), 'model-live');
  const datasetsDir = path.join(liveRoot, 'datasets');
  const lgbmRoot = path.join(liveRoot, 'models', 'lgbm');
  const chronosRoot = path.join(liveRoot, 'models', 'chronos2');

  const datasetState = readJsonSafe(path.join(datasetsDir, 'dataset_state.json'));
  const klinesPath = path.join(datasetsDir, 'klines_1h.parquet');
  const datasetReady = Boolean(
    fs.existsSync(klinesPath)
    && datasetState
    && typeof datasetState.lastCutoffTime === 'number',
  );

  const lgbmCur = readJsonSafe(path.join(lgbmRoot, 'current.json'));
  const lgbmVersionId = typeof lgbmCur?.versionId === 'string' && !lgbmCur.versionId.includes('..') && !/[\\/]/.test(lgbmCur.versionId)
    ? lgbmCur.versionId
    : null;
  const lgbmVerDir = lgbmVersionId ? path.join(lgbmRoot, 'versions', lgbmVersionId) : null;
  const lgbmReady = Boolean(
    lgbmVerDir
    && fs.existsSync(path.join(lgbmVerDir, 'lgbm_long_ranker.txt'))
    && fs.existsSync(path.join(lgbmVerDir, 'lgbm_short_ranker.txt'))
    && fs.existsSync(path.join(lgbmVerDir, 'lgbm_metadata.json')),
  );

  const chronosCur = readJsonSafe(path.join(chronosRoot, 'current.json'));
  const chronosTrainState = readJsonSafe(path.join(chronosRoot, 'training_status.json'));
  const chronosPy = resolveChronosPythonBin(workspaceRoot, opts.chronosPython);
  const retrainHours = Number(
    opts.retrainIntervalHours
    ?? chronosCur?.retrainIntervalHours
    ?? chronosTrainState?.retrainIntervalHours
    ?? 6,
  );

  let chronosReady = false;
  let chronosReason: string | null = null;
  let lockRevision: string | null = null;
  let lockRepoId = 'amazon/chronos-2';

  try {
    const lock = readChronosAssetLock(workspaceRoot);
    lockRevision = lock.revision;
    lockRepoId = lock.repo_id;
    const baseCacheDir = path.join(workspaceRoot, '.benchmark-cache', 'models', 'chronos2');
    for (const filename of Object.keys(lock.files)) {
      if (!fs.existsSync(path.join(baseCacheDir, filename))) {
        throw new Error(`本機缺少 Chronos-2 基礎權重檔：${filename}`);
      }
    }
    if (!opts.chronosPython && !fs.existsSync(chronosPy)) {
      throw new Error(`找不到 Chronos-2 獨立 Python 環境：${chronosPy}`);
    }
    const verId = typeof chronosCur?.versionId === 'string' ? chronosCur.versionId : '';
    if (!verId || verId.includes('..') || /[\\/]/.test(verId)) {
      throw new Error('尚未完成本機 GPU Chronos-2 LoRA 首次訓練');
    }
    const adapterDir = path.join(chronosRoot, 'versions', verId, 'attempt', 'adapter');
    const shaJsonPath = path.join(adapterDir, 'adapter.sha256.json');
    if (!fs.existsSync(shaJsonPath)) {
      throw new Error(`Chronos-2 adapter 缺少雜湊清單：${shaJsonPath}`);
    }
    const innerHashes = JSON.parse(fs.readFileSync(shaJsonPath, 'utf8')) as Record<string, string>;
    for (const [name, expected] of Object.entries(innerHashes)) {
      const fpath = path.resolve(adapterDir, name);
      if (!isInsideDir(adapterDir, fpath) || !fs.existsSync(fpath) || fs.lstatSync(fpath).isSymbolicLink()) {
        throw new Error(`Chronos-2 adapter 檔案無效或缺失：${name}`);
      }
      if (sha256File(fpath) !== String(expected).toLowerCase()) {
        throw new Error(`Chronos-2 adapter 雜湊驗證失敗：${name}`);
      }
    }
    if (chronosCur?.baseRevision && String(chronosCur.baseRevision) !== lock.revision) {
      throw new Error(`Chronos-2 基礎模型版本不符 (${chronosCur.baseRevision} vs ${lock.revision})`);
    }
    chronosReady = true;
  } catch (err: any) {
    chronosReason = err?.message || String(err);
  }

  const trainedAt = typeof chronosCur?.trainedAt === 'number' ? chronosCur.trainedAt : null;
  const nextRetrainAt =
    typeof chronosCur?.nextRetrainAt === 'number'
      ? chronosCur.nextRetrainAt
      : trainedAt !== null
        ? trainedAt + retrainHours * 3_600_000
        : null;

  return {
    mode: 'local-rolling',
    windowDays: Number(datasetState?.windowDays || 180),
    datasetReady,
    datasetVersion: datasetState?.datasetVersion ?? null,
    lastCutoffTime: typeof datasetState?.lastCutoffTime === 'number' ? datasetState.lastCutoffTime : null,
    universeSymbols: Array.isArray(datasetState?.universeSymbols) ? datasetState.universeSymbols : [],
    lgbm: {
      ready: lgbmReady,
      versionId: lgbmReady ? lgbmVersionId : null,
      trainedAt: typeof lgbmCur?.trainedAt === 'number' ? lgbmCur.trainedAt : null,
      cutoffTime: typeof lgbmCur?.cutoffTime === 'number' ? lgbmCur.cutoffTime : null,
      longSha256: lgbmCur?.longSha256 ?? null,
      shortSha256: lgbmCur?.shortSha256 ?? null,
      valNdcg5Long: typeof lgbmCur?.valNdcg5Long === 'number' ? lgbmCur.valNdcg5Long : null,
      valNdcg5Short: typeof lgbmCur?.valNdcg5Short === 'number' ? lgbmCur.valNdcg5Short : null,
      elapsedMs: typeof lgbmCur?.elapsedMs === 'number' ? lgbmCur.elapsedMs : null,
      trainRows: typeof lgbmCur?.trainRows === 'number' ? lgbmCur.trainRows : null,
      valRows: typeof lgbmCur?.valRows === 'number' ? lgbmCur.valRows : null,
    },
    chronos2: {
      ready: chronosReady,
      installed: chronosReady,
      reason: chronosReason,
      versionId: chronosReady ? String(chronosCur.versionId) : (chronosCur?.versionId ?? null),
      trainedAt,
      cutoffTime: typeof chronosCur?.cutoffTime === 'number' ? chronosCur.cutoffTime : null,
      valReturnMae: typeof chronosCur?.valReturnMae === 'number' ? chronosCur.valReturnMae : null,
      valDirectionHitRate: typeof chronosCur?.valDirectionHitRate === 'number' ? chronosCur.valDirectionHitRate : null,
      peakVramAllocatedMb: typeof chronosCur?.peakVramAllocatedMb === 'number' ? chronosCur.peakVramAllocatedMb : null,
      elapsedSeconds: typeof chronosCur?.elapsedSeconds === 'number' ? chronosCur.elapsedSeconds : null,
      dtype: chronosCur?.dtype ?? null,
      baseRepoId: lockRepoId,
      baseRevision: lockRevision,
      adapterSha256: chronosCur?.adapterSha256Json?.['adapter_model.safetensors'] ?? null,
      retrainIntervalHours: retrainHours,
      nextRetrainAt,
      isTraining: opts.isTrainingChronos ?? Boolean(chronosTrainState?.isTraining),
      lastError: chronosTrainState?.lastError ?? null,
    },
  };
}

export function buildLocalRollingModelSource(
  dataDir: string,
  workspaceRoot: string,
  retrainIntervalHours = 6,
  opts: { chronosPython?: string } = {},
): ModelSource {
  const status = inspectLocalRollingStatus(dataDir, workspaceRoot, {
    chronosPython: opts.chronosPython,
    retrainIntervalHours,
  });
  if (!status.chronos2.ready || !status.chronos2.versionId) {
    throw new Error(status.chronos2.reason || '本機 Chronos-2 LoRA 尚未完成首次 GPU 訓練，請先點擊「先執行首次本機 GPU 微調」');
  }
  const chronosRoot = path.join(path.resolve(dataDir), 'model-live', 'models', 'chronos2');
  const cur = readJsonSafe(path.join(chronosRoot, 'current.json'));
  const lock = readChronosAssetLock(workspaceRoot);
  return {
    pipelineMode: 'local-rolling',
    retrainIntervalHours,
    adapterRunId: status.chronos2.versionId,
    adapterRunDir: chronosRoot,
    attemptDir: String(cur?.attemptDir || path.join(chronosRoot, 'versions', status.chronos2.versionId, 'attempt')),
    artifactHashes: cur?.artifactHashes ?? {},
    adapterSha256Json: cur?.adapterSha256Json ?? {},
    fingerprint: null,
    baseRepoId: lock.repo_id,
    baseRevision: lock.revision,
    baseFiles: { ...lock.files },
    lgbmLongSha256: status.lgbm.longSha256 ?? null,
    lgbmShortSha256: status.lgbm.shortSha256 ?? null,
  };
}
