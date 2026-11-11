import type {
  DecisionStatus,
  EquityPoint,
  ExperimentStatus,
  ModelPaperExperimentDetail,
  ModelPaperExperimentListItem,
  SkipReason,
} from '@fadachi/core';

export const EXPERIMENT_STATUS_LABELS: Record<ExperimentStatus, string> = {
  RUNNING: '測試中',
  PAUSED: '已暫停新進場',
  AWAITING_RESUME: '中斷恢復待確認',
  STOPPING: '停止平倉中',
  STOPPED: '已停止',
};

export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = {
  PENDING: '推論中',
  PENDING_RETRY: '等待重試',
  SUBMITTED: '已提交',
  FAILED: '推論失敗',
  SKIPPED: '本小時略過',
};

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  CONFLICT: '多空衝突',
  CHRONOS_MISSING: '缺少 Chronos 預測',
  DIRECTION_MISMATCH: '方向不一致',
  BELOW_THRESHOLD: '未達 >0.25% 門檻',
  STALE_REFERENCE_PRICE: '參考價過期',
  NO_SLOT: '名額已滿',
  INSUFFICIENT_CASH: '現金不足',
  SPEC_LIMIT: '規格限制',
  STOPPED_THIS_HOUR: '同小時停損禁止重進',
  BANKRUPT: '帳戶已破產',
  DEGRADED_MARKET: '行情過期停新單',
};

export const ACTIVE_MODEL_PAPER_STATUSES = new Set<ExperimentStatus>([
  'RUNNING',
  'PAUSED',
  'AWAITING_RESUME',
  'STOPPING',
]);

export function generateModelPaperRequestId(prefix = 'mp'): string {
  const cleanPrefix = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'mp';
  const rand = Math.random().toString(36).slice(2, 10);
  return `${cleanPrefix}_${Date.now()}_${rand}`;
}

export function normalizeEquitySeriesPoints(
  points: ReadonlyArray<Pick<EquityPoint, 'ts' | 'equity'>>,
): Array<{ time: number; equity: number }> {
  const bySecond = new Map<number, { ts: number; equity: number }>();
  for (const pt of points) {
    if (!Number.isFinite(pt.ts) || !Number.isFinite(pt.equity)) continue;
    const sec = Math.floor(pt.ts / 1000);
    const existing = bySecond.get(sec);
    if (!existing || pt.ts >= existing.ts) {
      bySecond.set(sec, { ts: pt.ts, equity: pt.equity });
    }
  }
  return Array.from(bySecond.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([time, val]) => ({ time, equity: val.equity }));
}

export function pickPreferredExperimentId(
  experiments: ReadonlyArray<ModelPaperExperimentListItem>,
  currentSelectedId: string | null,
): string | null {
  if (currentSelectedId && experiments.some(e => e.experiment.id === currentSelectedId)) {
    return currentSelectedId;
  }
  const active = experiments.find(e => ACTIVE_MODEL_PAPER_STATUSES.has(e.experiment.status));
  if (active) return active.experiment.id;
  return experiments[0]?.experiment.id ?? null;
}

export function findActiveExperiment(
  experiments: ReadonlyArray<ModelPaperExperimentListItem>,
): ModelPaperExperimentListItem | null {
  return experiments.find(e => ACTIVE_MODEL_PAPER_STATUSES.has(e.experiment.status)) ?? null;
}

export function formatUtcTaipei(ms?: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  const utc = d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const tpe = d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${utc}（台北 ${tpe}）`;
}

export function formatDurationMs(ms?: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatNumber(val?: number | null, digits = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '--';
  return val.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function isDetailActive(detail: ModelPaperExperimentDetail | null): boolean {
  return Boolean(detail && ACTIVE_MODEL_PAPER_STATUSES.has(detail.experiment.status));
}
