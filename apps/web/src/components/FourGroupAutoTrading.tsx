import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Download,
  History,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import {
  DEFAULT_FOUR_GROUP_OLLAMA_URL,
  FOUR_GROUP_IDS,
  FOUR_GROUP_D_MIN_AI_CONFIDENCE,
  FOUR_GROUP_SPEC,
  FourGroupComparisonCoordinator,
  MAX_FOUR_GROUP_COINS,
  defaultAutoTradingConfig,
  evaluateAiGate,
  isAutoTradingActive,
  isRemoteOllamaUrl,
  sanitizeOllamaUrl,
  selectDynamicCoinsFromLgbmSnapshot,
  stringifyWithInfinity,
  type AutoTradingConfig,
  type AutoTradingSnapshot,
  type AutoTradingStatus,
  type FourGroupCoinMode,
  type FourGroupId,
  type FourGroupTradingBatch,
  type MarketType,
} from '@fadachi/core';
import type { useFourGroupTrading } from '../hooks/useFourGroupTrading';
import { collectorClient } from '../api/collectorClient';

export interface FourGroupAutoTradingProps {
  marketType: MarketType;
  theme: 'dark' | 'light';
  fourGroup: ReturnType<typeof useFourGroupTrading>;
  onSelectSymbol: (symbol: string, planId?: string) => void;
  renderSettings: (props: {
    formId: string;
    config: AutoTradingConfig;
    locked: boolean;
    historical: boolean;
    ready: boolean;
    onStart: (config: AutoTradingConfig) => void;
  }) => ReactNode;
  renderRecords: (snapshot: AutoTradingSnapshot, keySuffix: string) => ReactNode;
}

const STATUS_LABELS: Record<AutoTradingStatus, string> = {
  IDLE: '待命',
  RUNNING: '執行中',
  PAUSED: '已暫停',
  DRAINING: '收尾中',
  COMPLETED: '已完成',
  INTERRUPTED: '已中斷',
};

const FUNDING_LABELS: Record<AutoTradingSnapshot['fundingStatus'], string> = {
  NOT_REQUIRED: '無須結算',
  PENDING: '待結算',
  SETTLED: '已結算',
  ERROR: '結算失敗',
};

const GROUP_COLORS: Record<FourGroupId, string> = {
  A: '#38bdf8',
  B: '#a855f7',
  C: '#10b981',
  D: '#f59e0b',
};

function fmtTime(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '--';
  return new Date(ms).toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function fmtMoney(v?: number | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(v?: number | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function toneClass(v?: number | null): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'at-positive' : 'at-negative';
}

function aiReasonLabel(reason: string, explanation = ''): string {
  switch (reason) {
    case 'NO_ANALYSIS': return '當時尚無 AI 分析';
    case 'WAITING': return '當時 AI 分析尚未就緒';
    case 'FAILED': return 'AI 分析失敗';
    case 'DATA_INCOMPLETE': return '資料不足';
    case 'EXPIRED': return 'AI 分析已過期';
    case 'NEUTRAL': return 'AI 中立觀望';
    case 'MISMATCH': return explanation.includes('版本') ? 'AI 版本不符' : 'AI 方向不一致';
    case 'ACCEPTED':
    case 'ALLOWED': return 'AI 條件通過';
    case 'LOW_CONFIDENCE': return 'AI 信心度不足';
    case 'NOT_TRACKED': return '非追蹤幣種';
    default: return reason;
  }
}

export default function FourGroupAutoTrading({
  marketType,
  fourGroup,
  renderSettings,
  renderRecords,
}: FourGroupAutoTradingProps) {
  const id = useId();
  const formId = `${id}-four-settings`;
  const closeDialog = useRef<HTMLDialogElement>(null);

  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [coinMode, setCoinMode] = useState<FourGroupCoinMode>('auto-lgbm');
  const [selectedCoins, setSelectedCoins] = useState<string[]>(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const [selectedModel, setSelectedModel] = useState<string>('gemma4:e2b');
  const [activeTab, setActiveTab] = useState<'decisions' | 'counterfactual' | 'accountA' | 'accountB' | 'accountC' | 'accountD'>('decisions');
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const universe = fourGroup.lgbmState.universeSymbols;

  // Keep selectedCoins intersected cleanly with LightGBM research universe while idle
  useEffect(() => {
    if (!universe.length) return;
    setSelectedCoins((prev) => {
      const valid = prev.filter(s => universe.includes(s)).slice(0, MAX_FOUR_GROUP_COINS);
      return valid.length ? valid : universe.slice(0, 3);
    });
  }, [universe]);

  // Auto-select gemma4:e2b or first available Ollama model when tags arrive
  useEffect(() => {
    const models = fourGroup.ollamaConn.models;
    if (!models.length) return;
    if (!models.includes(selectedModel)) {
      const gemma = models.find(m => m.toLowerCase().includes('gemma4') || m.toLowerCase().includes('gemma'));
      setSelectedModel(gemma ?? models[0]);
    }
  }, [fourGroup.ollamaConn.models, selectedModel]);

  const archived = selectedBatchId !== null && selectedBatchId !== fourGroup.snapshot.id
    ? fourGroup.history.find(b => b.id === selectedBatchId)
    : undefined;
  const shown: FourGroupTradingBatch = archived ?? fourGroup.snapshot;
  const historical = Boolean(archived);
  const isActive = isAutoTradingActive(fourGroup.snapshot.status);

  const metrics = useMemo(
    () => (shown.id === fourGroup.snapshot.id ? fourGroup.metrics : FourGroupComparisonCoordinator.calculateMetricsFromBatch(shown)),
    [fourGroup.metrics, fourGroup.snapshot.id, shown],
  );

  const batches = useMemo(() => {
    const merged = new Map<string, FourGroupTradingBatch>();
    for (const item of fourGroup.history) merged.set(item.id, item);
    if (fourGroup.snapshot.status !== 'IDLE') merged.set(fourGroup.snapshot.id, fourGroup.snapshot);
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [fourGroup.history, fourGroup.snapshot]);

  const canClose = isActive && !historical && FOUR_GROUP_IDS.some(
    g => fourGroup.snapshot.accounts[g].positions.length > 0 || fourGroup.snapshot.accounts[g].orders.length > 0,
  );

  let draftUrlValid = true;
  let draftIsRemote = false;
  let draftUrlErr: string | null = null;
  try {
    const sanitized = sanitizeOllamaUrl(fourGroup.ollamaDraftUrl);
    draftIsRemote = isRemoteOllamaUrl(sanitized);
  } catch (err: any) {
    draftUrlValid = false;
    draftUrlErr = err?.message || 'Ollama URL 格式無效';
  }

  const autoLgbmCoins = useMemo(
    () => selectDynamicCoinsFromLgbmSnapshot(fourGroup.lgbmState.snapshot, universe, MAX_FOUR_GROUP_COINS),
    [fourGroup.lgbmState.snapshot, universe],
  );
  const draftAutoCoins = useMemo(
    () => (autoLgbmCoins.length > 0 ? autoLgbmCoins : universe.slice(0, MAX_FOUR_GROUP_COINS)),
    [autoLgbmCoins, universe],
  );
  const effectiveDraftCoins = coinMode === 'auto-lgbm' ? draftAutoCoins : selectedCoins;
  const shownCoinMode: FourGroupCoinMode = (isActive || historical)
    ? (shown.locked.coinMode ?? 'manual')
    : coinMode;
  const shownActiveCoins = (isActive || historical)
    ? (shown.activeCoins?.length ? shown.activeCoins : shown.locked.selectedCoins)
    : effectiveDraftCoins;

  const invalidCoins = effectiveDraftCoins.filter(c => universe.length > 0 && !universe.includes(c));
  const coinValidationOk = effectiveDraftCoins.length >= 1
    && effectiveDraftCoins.length <= MAX_FOUR_GROUP_COINS
    && universe.length > 0
    && invalidCoins.length === 0;

  const canStartBatch = fourGroup.ready
    && !isActive
    && !historical
    && marketType === 'futures'
    && coinValidationOk
    && draftUrlValid
    && Boolean(selectedModel.trim())
    && !starting;

  const toggleCoin = (sym: string) => {
    if (isActive || historical) return;
    setSelectedCoins((prev) => {
      if (prev.includes(sym)) {
        if (prev.length <= 1) return prev;
        return prev.filter(s => s !== sym);
      }
      if (prev.length >= MAX_FOUR_GROUP_COINS) return prev;
      return [...prev, sym];
    });
  };

  const handleStart = async (cfg: AutoTradingConfig) => {
    setActionError(null);
    setStarting(true);
    try {
      await fourGroup.startFourGroup(cfg, effectiveDraftCoins, fourGroup.ollamaDraftUrl, selectedModel, coinMode);
    } catch (err: any) {
      setActionError(err?.message || '四組策略比較啟動失敗');
    } finally {
      setStarting(false);
    }
  };

  const handleExportCsv = async () => {
    setActionError(null);
    try {
      let csv: string;
      try {
        csv = await collectorClient.exportFourGroupBatchCsv(shown.id);
      } catch {
        csv = FourGroupComparisonCoordinator.exportCsvFromBatch(shown);
      }
      const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `four-group-${shown.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      setActionError(err?.message || '四組 CSV 匯出失敗');
    }
  };

  const handleExportJson = () => {
    try {
      const json = stringifyWithInfinity({ batch: shown, metrics }, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `four-group-${shown.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      setActionError(err?.message || '四組 JSON 匯出失敗');
    }
  };

  const shownUrl = isActive || historical ? shown.locked.ollamaUrl : fourGroup.ollamaDraftUrl;
  const shownRemote = isActive || historical ? shown.locked.isRemoteOllama : draftIsRemote;
  const lgbmSnap = fourGroup.lgbmState.snapshot;

  return (
    <div data-testid="four-group-auto-trading">
      <header className="at-header">
        <div className="at-title">
          <BrainCircuit size={21} style={{ color: '#f59e0b' }} aria-hidden="true" />
          <div>
            <h2>四組即時策略比較（Futures 永續合約）</h2>
            <p>
              A 規則基準 vs B 規則＋AI vs C 規則＋LightGBM Top3 vs D LightGBM＋AI
            </p>
          </div>
        </div>
        <div className="at-controls">
          <span className={`at-status at-status-${shown.status.toLowerCase()}`} role="status">
            {historical ? '歷史・' : ''}
            {STATUS_LABELS[shown.status]}
          </span>
          {historical ? (
            <button type="button" className="at-button" onClick={() => setSelectedBatchId(null)}>
              <ArrowLeft size={15} aria-hidden="true" />
              返回目前批次
            </button>
          ) : (
            <>
              {!isActive && (
                <button type="submit" form={formId} className="at-button at-primary" disabled={!canStartBatch}>
                  <Play size={15} aria-hidden="true" />
                  {starting ? '啟動中...' : '啟動四組比較'}
                </button>
              )}
              {fourGroup.snapshot.status === 'RUNNING' && (
                <button type="button" className="at-button" onClick={() => void fourGroup.pauseFourGroup()}>
                  <Pause size={15} aria-hidden="true" />
                  暫停新進場
                </button>
              )}
              {fourGroup.snapshot.status === 'PAUSED' && (
                <button type="button" className="at-button at-primary" onClick={() => void fourGroup.resumeFourGroup()} disabled={!fourGroup.ready}>
                  <Play size={15} aria-hidden="true" />
                  繼續
                </button>
              )}
              <button
                type="button"
                className="at-button"
                disabled={!isActive || fourGroup.snapshot.status === 'DRAINING'}
                onClick={() => void fourGroup.drainFourGroup()}
              >
                <Square size={14} aria-hidden="true" />
                停止接單並收尾
              </button>
              <button
                type="button"
                className="at-button at-danger"
                disabled={!canClose}
                onClick={() => closeDialog.current?.showModal()}
              >
                <X size={16} aria-hidden="true" />
                全部平倉
              </button>
            </>
          )}
        </div>
      </header>

      <div className="at-disclaimer-card" role="note">
        <ShieldAlert size={16} color="#38bdf8" style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          <strong>實驗公平性與安全聲明：</strong>
          僅紙上模擬，不送出真實委託；四組（A/B/C/D）各自擁有獨立資金與倉位但共用相同訊號與逐筆報價。
          所有模型訓練（Chronos-2 GPU 等）目前已暫停，僅保留 <strong>LightGBM 每小時獨立更新</strong> 與 <strong>Ollama (預設 {DEFAULT_FOUR_GROUP_OLLAMA_URL})</strong> 推論對照。
        </div>
      </div>

      {marketType !== 'futures' && (
        <p className="at-notice at-error" role="alert">
          <AlertTriangle size={16} />
          <span>四組策略比較首版僅支援 USDT 永續合約（futures），請先於右上方切換為「合約」市場後再啟動。</span>
        </p>
      )}

      {fourGroup.statusMessage && (
        <p className={`at-notice ${!fourGroup.ready ? 'at-unready' : ''}`} role="status">
          <Activity size={16} aria-hidden="true" />
          <span>{fourGroup.statusMessage}</span>
        </p>
      )}

      {(actionError || fourGroup.storageError) && (
        <p className="at-notice at-error" role="alert">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>{actionError || fourGroup.storageError}</span>
        </p>
      )}

      {(() => {
        const rt = fourGroup.engineRuntime;
        const syncFailed = Boolean(rt.error);
        return (
          <div className="at-4g-meta-grid" style={{ marginBottom: '10px' }} data-testid="four-group-backend-status">
            <span>
              執行進程：<strong>{rt.runningInCollector ? 'Collector 後端運行中' : '未連線'}</strong>
            </span>
            <span>
              合約串流：<strong className={fourGroup.streamHealthy ? 'at-positive' : 'at-warning'}>
                {fourGroup.streamHealthy ? '已連線' : '等待中'}
              </strong>
            </span>
            <span>
              合約規格：<strong className={fourGroup.rulesReady ? 'at-positive' : 'at-warning'}>
                {fourGroup.rulesReady ? '已就緒' : '載入中'}
              </strong>
            </span>
            <span>
              最後已同步版本：<strong>{rt.lastSaveRevision !== null ? `rev ${rt.lastSaveRevision}` : '--'}</strong>
              {rt.lastSaveAt ? ` @ ${fmtTime(rt.lastSaveAt)}` : ''}
              {rt.lastTxElapsedMs !== null ? ` (DB ${rt.lastTxElapsedMs}ms${rt.lastQueueWaitMs !== null && rt.lastQueueWaitMs > 200 ? `, 排隊 ${rt.lastQueueWaitMs}ms` : ''})` : ''}
            </span>
            {syncFailed && (
              <span className="at-negative">
                <strong>後端存檔異常：{rt.error}</strong>
              </span>
            )}
            {!syncFailed && rt.unsyncedChanges && (
              <span>
                背景存檔同步中...
              </span>
            )}
          </div>
        );
      })()}

      {invalidCoins.length > 0 && (
        <p className="at-notice at-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>選定追蹤幣種不在 LightGBM 固定研究名單：{invalidCoins.join(', ')}，禁止啟動。</span>
        </p>
      )}

      {/* Batch Selector & Export Toolbar */}
      <div className="at-batchbar">
        <label htmlFor={`${id}-four-batch`}>
          <History size={15} aria-hidden="true" />
          四組批次
        </label>
        <select
          id={`${id}-four-batch`}
          value={historical ? shown.id : ''}
          onChange={(e) => setSelectedBatchId(e.target.value || null)}
        >
          <option value="">目前批次・{STATUS_LABELS[fourGroup.snapshot.status]}</option>
          {batches.filter(b => b.id !== fourGroup.snapshot.id).map((b) => (
            <option key={b.id} value={b.id}>
              {fmtTime(b.startedAt)}・{b.locked.model}・{STATUS_LABELS[b.status]}・{b.id}
            </option>
          ))}
        </select>
        <div className="at-exports">
          <button type="button" className="at-button" disabled={shown.status === 'IDLE'} onClick={() => void handleExportCsv()}>
            <Download size={15} aria-hidden="true" />
            匯出四組 CSV
          </button>
          <button type="button" className="at-button" disabled={shown.status === 'IDLE'} onClick={handleExportJson}>
            <Download size={15} aria-hidden="true" />
            匯出四組 JSON
          </button>
        </div>
      </div>

      {/* Main Split: Left (Overview + LightGBM + 4-Group Table) | Right (Settings + Ollama + Coins) */}
      <div className="at-overview">
        <section className="at-performance" aria-label="四組比較與模型狀態">
          {/* LightGBM Independent Hourly Status Strip */}
          <div className="at-4g-status-box">
            <div className="at-4g-status-head">
              <div>
                <strong>
                  <Cpu size={14} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  LightGBM 獨立每小時排名（全 20 檔研究池）
                </strong>
                <span className={`at-pill ${fourGroup.lgbmState.matchesCurrentHour ? 'ok' : 'warn'}`}>
                  {fourGroup.lgbmState.matchesCurrentHour
                    ? '當小時有效'
                    : lgbmSnap
                      ? '已過期 / 待更新'
                      : '尚無排名快照'}
                </span>
              </div>
              <button
                type="button"
                className="at-button"
                disabled={fourGroup.updatingLgbm}
                onClick={() => void fourGroup.triggerManualLgbmUpdate(false)}
              >
                <RefreshCw size={13} className={fourGroup.updatingLgbm ? 'spinning' : ''} />
                <span>{fourGroup.updatingLgbm ? '更新中...' : '立即更新 LightGBM 排名'}</span>
              </button>
            </div>
            <div className="at-4g-meta-grid">
              <span>版本：<strong>{lgbmSnap?.versionId ?? fourGroup.lgbmState.lgbmStatus?.versionId ?? '--'}</strong></span>
              <span>Cutoff UTC：<strong>{fmtTime(lgbmSnap?.cutoffTime)}</strong></span>
              <span>發布時間：<strong>{fmtTime(lgbmSnap?.publishedAt)}</strong></span>
              <span>到期時間：<strong>{fmtTime(lgbmSnap?.expiresAt)}</strong></span>
              {lgbmSnap?.trainAudit && (
                <span>
                  耗時 / CPU / RAM：
                  <strong>
                    {lgbmSnap.trainAudit.elapsedMs.toFixed(0)}ms ・ CPU {lgbmSnap.trainAudit.cpuPercent ?? '--'}% ・ {lgbmSnap.trainAudit.rssMb ?? '--'} MB
                  </strong>
                </span>
              )}
              <span>非 LightGBM 訓練：<strong>已暫停（Chronos-2 等）</strong></span>
            </div>
            {fourGroup.lgbmState.latestError?.error && (
              <p className="at-notice at-error" style={{ marginTop: '8px', marginBottom: 0 }}>
                最近更新錯誤：{fourGroup.lgbmState.latestError.error}
              </p>
            )}
            {lgbmSnap && (
              <div className="at-4g-ranks-preview">
                <div>
                  <small>做多候選 (Top 3 許可進場)：</small>
                  <div className="at-4g-rank-chips">
                    {(lgbmSnap.longTop5 ?? []).map((entry) => (
                      <span
                        key={`l-${entry.symbol}`}
                        className={`at-rank-chip ${entry.conflict ? 'conflict' : entry.rank <= 3 ? 'top3' : 'outside'}`}
                      >
                        #{entry.rank} {entry.symbol.replace('USDT', '')}
                        {entry.conflict ? ' (衝突)' : entry.rank > 3 ? ' (>3)' : ''}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <small>做空候選 (Top 3 許可進場)：</small>
                  <div className="at-4g-rank-chips">
                    {(lgbmSnap.shortTop5 ?? []).map((entry) => (
                      <span
                        key={`s-${entry.symbol}`}
                        className={`at-rank-chip ${entry.conflict ? 'conflict' : entry.rank <= 3 ? 'top3-short' : 'outside'}`}
                      >
                        #{entry.rank} {entry.symbol.replace('USDT', '')}
                        {entry.conflict ? ' (衝突)' : entry.rank > 3 ? ' (>3)' : ''}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 4-Group Parallel Summary Matrix */}
          <p className={`at-notice ${metrics.pairCostStatus === 'SETTLED' ? '' : 'at-warning'}`} style={{ marginTop: '12px' }}>
            <span>
              共同截止：{fmtTime(metrics.commonCutoff)} ・ 四組成本完整度：
              <strong>{metrics.pairCostStatus === 'SETTLED' ? 'SETTLED（全組費用已核對）' : 'PROVISIONAL（含進行中部位或待結算資金費）'}</strong>
            </span>
          </p>

          <div className="at-table-scroll">
            <table className="at-ab-table" data-testid="four-group-metrics-table">
              <thead>
                <tr>
                  <th>績效與審計指標</th>
                  {FOUR_GROUP_IDS.map(g => (
                    <th key={g} style={{ color: GROUP_COLORS[g] }}>
                      {g}：{FOUR_GROUP_SPEC[g].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>帳戶淨值 (USDT)</td>
                  {FOUR_GROUP_IDS.map(g => <td key={g}><strong>{fmtMoney(metrics.accounts[g].metrics.equity)}</strong></td>)}
                </tr>
                <tr>
                  <td>總報酬率 (%)</td>
                  {FOUR_GROUP_IDS.map(g => (
                    <td key={g} className={toneClass(metrics.accounts[g].metrics.returnPct)}>
                      {fmtPct(metrics.accounts[g].metrics.returnPct)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>已實現損益 (USDT)</td>
                  {FOUR_GROUP_IDS.map(g => (
                    <td key={g} className={toneClass(metrics.accounts[g].metrics.realizedPnl)}>
                      {fmtMoney(metrics.accounts[g].metrics.realizedPnl)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>未實現損益 (USDT)</td>
                  {FOUR_GROUP_IDS.map(g => (
                    <td key={g} className={toneClass(metrics.accounts[g].metrics.unrealizedPnl)}>
                      {fmtMoney(metrics.accounts[g].metrics.unrealizedPnl)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>手續費 / 資金費 (USDT)</td>
                  {FOUR_GROUP_IDS.map(g => (
                    <td key={g}>
                      {fmtMoney(metrics.accounts[g].metrics.fees)} / {fmtMoney(metrics.accounts[g].metrics.funding)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>最大回撤 MDD (%)</td>
                  {FOUR_GROUP_IDS.map(g => <td key={g}>{metrics.accounts[g].metrics.maxDrawdownPct.toFixed(2)}%</td>)}
                </tr>
                <tr>
                  <td>勝率 / 獲利因子 PF</td>
                  {FOUR_GROUP_IDS.map((g) => {
                    const m = metrics.accounts[g].metrics;
                    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor === null ? '--' : fmtMoney(m.profitFactor);
                    return <td key={g}>{fmtPct(m.winRate)} / {pf}</td>;
                  })}
                </tr>
                <tr>
                  <td>完成交易 / 現有持倉 / 委託</td>
                  {FOUR_GROUP_IDS.map((g) => {
                    const a = metrics.accounts[g];
                    return <td key={g}>{a.closedTradeCount} / {a.openPositionCount} / {a.pendingOrderCount}</td>;
                  })}
                </tr>
                <tr>
                  <td>訊號放行 / 拒絕 / 實際進場</td>
                  {FOUR_GROUP_IDS.map((g) => {
                    const a = metrics.accounts[g];
                    return <td key={g}>{a.allowedSignals} / {a.rejectedSignals} / {a.executedSignals}</td>;
                  })}
                </tr>
                <tr>
                  <td>資金費結算狀態</td>
                  {FOUR_GROUP_IDS.map(g => <td key={g}>{FUNDING_LABELS[metrics.accounts[g].fundingStatus]}</td>)}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="at-coverage-bar">
            <span>總評估訊號：<strong>{metrics.signalAudit.totalSignals}</strong></span>
            <span>AI 覆蓋率：<strong>{metrics.signalAudit.aiCoveragePct.toFixed(1)}%</strong>（許可 {metrics.signalAudit.aiAllowedSignals}）</span>
            <span>LightGBM 覆蓋率：<strong>{metrics.signalAudit.lgbmCoveragePct.toFixed(1)}%</strong>（許可 {metrics.signalAudit.lgbmAllowedSignals}）</span>
            {Object.entries(metrics.signalAudit.aiBlockedReasons).map(([r, c]) => (
              <span key={`ai-r-${r}`}>AI[{r}]: {c}</span>
            ))}
            {Object.entries(metrics.signalAudit.lgbmBlockedReasons).map(([r, c]) => (
              <span key={`lgbm-r-${r}`}>LGBM[{r}]: {c}</span>
            ))}
          </div>
        </section>

        {/* Right Column: Settings + Ollama Configuration + Research Coin Picker */}
        <aside className="at-settings-side" aria-label="四組策略啟動與連線設定">
          {renderSettings({
            formId,
            config: shown.id === 'idle' ? defaultAutoTradingConfig('futures') : shown.config,
            locked: isActive,
            historical,
            ready: canStartBatch,
            onStart: handleStart,
          })}

          {/* Ollama Connection Panel */}
          <div className="at-4g-ollama-box">
            <div className="at-4g-subhead">
              <span>Ollama 推論端點</span>
              {(isActive || historical) && (
                <span className="at-locked-tag">
                  <LockKeyhole size={12} /> 已鎖定
                </span>
              )}
            </div>
            <div className="at-4g-url-row">
              <input
                type="url"
                aria-label="Ollama 位址"
                value={shownUrl}
                disabled={isActive || historical}
                placeholder={DEFAULT_FOUR_GROUP_OLLAMA_URL}
                onChange={(e) => fourGroup.setOllamaDraftUrl(e.target.value)}
              />
              <button
                type="button"
                className="at-button"
                disabled={isActive || historical || fourGroup.ollamaConn.checking || !draftUrlValid}
                onClick={() => void fourGroup.testOllamaConnection(fourGroup.ollamaDraftUrl, selectedModel)}
              >
                {fourGroup.ollamaConn.checking ? '測試中...' : '測試連線'}
              </button>
            </div>
            {draftUrlErr && !(isActive || historical) && (
              <p className="at-notice at-error" style={{ marginTop: '6px' }}>{draftUrlErr}</p>
            )}
            <div className="at-4g-conn-status">
              {fourGroup.ollamaConn.reachable ? (
                <span className="at-positive">
                  <CheckCircle2 size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  已連線 ({fourGroup.ollamaConn.baseUrl})・{fourGroup.ollamaConn.models.length} 個模型・{fourGroup.ollamaConn.latencyMs ?? '--'}ms
                </span>
              ) : (
                <span className="at-warning">
                  {fourGroup.ollamaConn.error || `未連線到 Ollama (${fourGroup.ollamaConn.baseUrl})`}
                </span>
              )}
            </div>

            {shownRemote && (
              <p className="at-notice at-warning" style={{ marginTop: '6px', fontSize: '11px' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>
                  遠端端點安全提示：連線至非本機 Ollama 時，系統僅傳送去識別化行情摘要／指標／新聞標題，絕不傳送交易所 API 金鑰或帳號密碼。
                </span>
              </p>
            )}

            <label style={{ display: 'block', marginTop: '10px', fontSize: '11px', fontWeight: 600 }}>
              Ollama 模型（鎖定後本批次不變更）
              <select
                className="at-model-selector"
                value={isActive || historical ? shown.locked.model : selectedModel}
                disabled={isActive || historical}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {Array.from(new Set([
                  ...(isActive || historical ? [shown.locked.model] : []),
                  selectedModel,
                  ...fourGroup.ollamaConn.models,
                ].filter(Boolean))).map((m) => (
                  <option key={m} value={m}>
                    {m}{fourGroup.ollamaConn.models.includes(m) ? '' : ' (未載入)'}
                  </option>
                ))}
              </select>
            </label>

            {isActive && !historical && (
              <>
                <button
                  type="button"
                  className="at-button"
                  style={{ width: '100%', marginTop: '8px', justifyContent: 'center' }}
                  disabled={fourGroup.analyzingOllama}
                  onClick={() => void fourGroup.triggerOllamaBatchAnalysis()}
                >
                  <RefreshCw size={13} className={fourGroup.analyzingOllama ? 'spinning' : ''} />
                  <span>
                    {fourGroup.analyzingOllama
                      ? `Ollama 分析中${fourGroup.ollamaProgress ? ` (${fourGroup.ollamaProgress.completed}/${fourGroup.ollamaProgress.total}${fourGroup.ollamaProgress.currentSymbol ? `・${fourGroup.ollamaProgress.currentSymbol.replace('USDT', '')}` : ''})` : '...'}`
                      : '立即更新追蹤幣 Ollama 分析'}
                  </span>
                </button>
                {fourGroup.ollamaLastError && (
                  <p className="at-notice at-warning" style={{ marginTop: '6px', fontSize: '11px' }}>
                    {fourGroup.ollamaLastError}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Research Universe Coin Picker (Auto-following LightGBM <= 10 or Manual) */}
          <div style={{ marginTop: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                追蹤下單幣種（限 20 檔研究池・上限 {MAX_FOUR_GROUP_COINS} 檔・目前 {shownActiveCoins.length} 檔）
              </span>
              {!(isActive || historical) && (
                <div style={{ display: 'inline-flex', gap: '4px' }}>
                  <button
                    type="button"
                    className={`at-coin-chip ${coinMode === 'auto-lgbm' ? 'selected' : ''}`}
                    onClick={() => setCoinMode('auto-lgbm')}
                  >
                    跟隨 LightGBM 自動
                  </button>
                  <button
                    type="button"
                    className={`at-coin-chip ${coinMode === 'manual' ? 'selected' : ''}`}
                    onClick={() => setCoinMode('manual')}
                  >
                    手動自選
                  </button>
                </div>
              )}
            </div>

            {shownCoinMode === 'auto-lgbm' ? (
              <>
                <p style={{ margin: '6px 0', fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {autoLgbmCoins.length > 0 || (shown.coinRotations?.length ?? 0) > 0
                    ? '自動追蹤 LightGBM 最新做多／做空 Top 5 排行（合計上限 10 檔，輪出幣種之既有持倉仍管理至平倉）。'
                    : '尚未產生最新 LightGBM 快照，暫以研究名單前 10 檔預備，快照發布後將自動切換。'}
                </p>
                <div className="at-coin-picker">
                  {shownActiveCoins.map(sym => (
                    <button
                      type="button"
                      key={sym}
                      className="at-coin-chip selected"
                      disabled
                    >
                      {sym.replace('USDT', '')}
                    </button>
                  ))}
                  {universe.length === 0 && !(isActive || historical) && (
                    <p className="at-empty" style={{ margin: '6px 0' }}>尚未讀取研究名單（請先同步或建立 universe.json）</p>
                  )}
                </div>
                {(shown.coinRotations?.length ?? 0) > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--text-secondary)' }}>
                    已跟隨 LightGBM 輪替 {shown.coinRotations!.length} 次・最近更新 {fmtTime(shown.coinRotations![shown.coinRotations!.length - 1].updatedAt)}
                  </p>
                )}
              </>
            ) : (
              <div className="at-coin-picker">
                {(isActive || historical ? shownActiveCoins : universe).map((sym) => {
                  const isSelected = shownActiveCoins.includes(sym);
                  return (
                    <button
                      type="button"
                      key={sym}
                      className={`at-coin-chip ${isSelected ? 'selected' : ''}`}
                      disabled={isActive || historical}
                      onClick={() => toggleCoin(sym)}
                    >
                      {sym.replace('USDT', '')}
                    </button>
                  );
                })}
                {universe.length === 0 && !(isActive || historical) && (
                  <p className="at-empty" style={{ margin: '6px 0' }}>尚未讀取研究名單（請先同步或建立 universe.json）</p>
                )}
              </div>
            )}
          </div>

          {/* Locked Version Audit Badge */}
          {shown.status !== 'IDLE' && (
            <div className="at-4g-lock-summary">
              <div>幣池模式：<code>{shownCoinMode === 'auto-lgbm' ? '跟隨 LightGBM 自動 (上限 10 檔)' : '手動固定自選'}</code></div>
              <div>Ollama：<code>{shown.locked.ollamaUrl}</code></div>
              <div>模型：<code>{shown.locked.model}</code></div>
              <div>版本：<code>{shown.locked.promptVersion} / {shown.locked.ruleVersion} / {shown.locked.lgbmPolicyVersion}</code></div>
            </div>
          )}
        </aside>
      </div>

      {/* Bottom Tabs: Decisions Audit / Counterfactuals / Per-Group Records */}
      <div className="at-records-section" style={{ marginTop: '18px' }}>
        <div className="at-tabs">
          <button type="button" className={`at-tab ${activeTab === 'decisions' ? 'active' : ''}`} onClick={() => setActiveTab('decisions')}>
            統一訊號審計 ({shown.decisions.length})
          </button>
          <button type="button" className={`at-tab ${activeTab === 'counterfactual' ? 'active' : ''}`} onClick={() => setActiveTab('counterfactual')}>
            被過濾對照 vs A 基準 ({metrics.blockedCounterfactuals.length})
          </button>
          {FOUR_GROUP_IDS.map((g) => {
            const tabId = `account${g}` as const;
            return (
              <button
                key={tabId}
                type="button"
                className={`at-tab ${activeTab === tabId ? 'active' : ''}`}
                onClick={() => setActiveTab(tabId)}
              >
                {g}：{FOUR_GROUP_SPEC[g].label}
              </button>
            );
          })}
        </div>

        {activeTab === 'decisions' && (
          <div className="at-table-scroll" style={{ marginTop: '10px' }}>
            <table className="at-ab-table" data-testid="four-group-decisions-table">
              <thead>
                <tr>
                  <th>訊號時間 / Plan ID</th>
                  <th>標的 / 方向</th>
                  <th>LightGBM 快照 / 名次 / 結果</th>
                  <th>訊號當時的 AI 判定 / 目前 AI 狀態</th>
                  <th>A</th>
                  <th>B</th>
                  <th>C</th>
                  <th>D</th>
                </tr>
              </thead>
              <tbody>
                {shown.decisions.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px' }}>
                      尚無訊號記錄（A/B/C 等待 5 秒急漲跌回撤確認；D 於 LightGBM Top 3＋AI 同向且信心 ≥ 60 時直接觸發）
                    </td>
                  </tr>
                ) : (
                  shown.decisions.slice().reverse().map((d) => {
                    const showCurrent = shown.id === fourGroup.snapshot.id && isActive;
                    const analysis = showCurrent ? fourGroup.ollamaAnalyses[d.symbol] : undefined;
                    const error = showCurrent ? fourGroup.ollamaSymbolErrors?.[d.symbol] : undefined;
                    const inProgress = showCurrent && fourGroup.analyzingOllama
                      && fourGroup.ollamaProgress?.currentSymbol === d.symbol;
                    const now = Date.now();
                    const current = analysis ? evaluateAiGate({
                      symbol: d.symbol, side: d.side, confirmedAt: now,
                      entries: [{ analysis, availableAt: now }], locked: shown.locked,
                    }) : null;
                    const currentLabel = inProgress ? 'AI 分析中'
                      : error ? 'AI 分析失敗'
                      : current?.allowed && d.signalSource === 'lgbm-ai-direct'
                        && (current.confidence ?? 0) < FOUR_GROUP_D_MIN_AI_CONFIDENCE ? 'AI 信心度不足'
                      : current ? aiReasonLabel(current.reason, current.explanation)
                      : fourGroup.analyzingOllama ? '等待 AI 分析' : '尚無 AI 分析結果';
                    return <tr key={d.id}>
                      <td style={{ textAlign: 'left' }}>
                        <div>{fmtTime(d.confirmedAt)}</div>
                        <small style={{ color: 'var(--text-secondary)' }}>
                          {d.signalSource === 'lgbm-ai-direct' ? '[D獨立模型] ' : '[5s跟進規則] '}
                          {d.planId}
                        </small>
                      </td>
                      <td>
                        <strong>{d.symbol}</strong> <small>{d.side}</small>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        <div>
                          {d.lgbm.sideRank ? `#${d.lgbm.sideRank}` : '--'}・
                          <strong className={d.lgbm.allowed ? 'at-positive' : 'at-negative'}>{d.lgbm.reason}</strong>
                        </div>
                        <small style={{ color: 'var(--text-secondary)' }}>
                          {d.lgbm.snapshotId ?? '無快照'} {d.lgbm.cutoffTime ? `@ ${fmtTime(d.lgbm.cutoffTime)}` : ''}
                        </small>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        <div>
                          當時：{d.ai.direction ?? '--'}・
                          <strong className={d.ai.allowed ? 'at-positive' : 'at-negative'} title={d.ai.explanation}>
                            {aiReasonLabel(d.ai.reason, d.ai.explanation)}
                          </strong>
                        </div>
                        <small style={{ color: 'var(--text-secondary)' }}>
                          {d.ai.model ?? shown.locked.model}・{d.ai.snapshotId ?? '無快照'}
                        </small>
                        {showCurrent && <div title={inProgress ? '目前正在分析此幣種' : error ?? current?.explanation}>
                          <small>目前：{currentLabel}{!inProgress && !error && current?.direction ? `（${current.direction}）` : ''}</small>
                        </div>}
                      </td>
                      {FOUR_GROUP_IDS.map((g) => (
                        <td key={g} title={d.groups[g].explanation}>
                          <span className={`at-status ${d.groups[g].allowed ? 'at-status-running' : 'at-status-interrupted'}`}>
                            {d.groups[g].allowed ? '進' : '略'}
                          </span>
                          <div><small>{d.groups[g].reason.startsWith('AI:')
                            ? `AI：${aiReasonLabel(d.groups[g].reason.slice(3), d.groups[g].explanation)}`
                            : g === 'B' ? aiReasonLabel(d.groups[g].reason, d.groups[g].explanation)
                            : d.groups[g].reason}</small></div>
                        </td>
                      ))}
                    </tr>;
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'counterfactual' && (
          <div className="at-table-scroll" style={{ marginTop: '10px' }}>
            <table className="at-ab-table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>標的 / 方向</th>
                  <th>被攔截組別</th>
                  <th>A 基準實際執行 / 淨損益</th>
                  <th>LightGBM 原因 / 名次</th>
                  <th>AI 原因 / 方向</th>
                </tr>
              </thead>
              <tbody>
                {metrics.blockedCounterfactuals.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px' }}>
                      尚無被 B / C / D 組過濾攔截的訊號
                    </td>
                  </tr>
                ) : (
                  metrics.blockedCounterfactuals.slice().reverse().map((cf) => (
                    <tr key={`cf-${cf.planId}`}>
                      <td>{fmtTime(cf.confirmedAt)}</td>
                      <td>{cf.symbol} <small>{cf.side}</small></td>
                      <td>{cf.blockedInGroups.join(', ')}</td>
                      <td className={toneClass(cf.tradeNetPnlInA)}>
                        {cf.executedInA
                          ? (cf.tradeNetPnlInA !== undefined ? `${fmtMoney(cf.tradeNetPnlInA)} USDT` : '執行中')
                          : 'A 亦未成交'}
                      </td>
                      <td>{cf.lgbmReason} {cf.sideRank ? `(#${cf.sideRank})` : ''}</td>
                      <td>{cf.aiReason} ({cf.aiDirection ?? '--'})</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'accountA' && renderRecords(shown.accounts.A, '4g-A')}
        {activeTab === 'accountB' && renderRecords(shown.accounts.B, '4g-B')}
        {activeTab === 'accountC' && renderRecords(shown.accounts.C, '4g-C')}
        {activeTab === 'accountD' && renderRecords(shown.accounts.D, '4g-D')}
      </div>

      <dialog ref={closeDialog} className="at-dialog" aria-labelledby={`${id}-4g-close-title`}>
        <h3 id={`${id}-4g-close-title`}>全部平倉四組（A/B/C/D）部位？</h3>
        <p>將對四組帳戶的所有目前持倉提出平倉並取消全部待成交進場單。</p>
        <div className="at-dialog-actions">
          <form method="dialog">
            <button type="submit" className="at-button" autoFocus>取消</button>
          </form>
          <button
            type="button"
            className="at-button at-danger"
            disabled={!canClose}
            onClick={() => {
              closeDialog.current?.close();
              if (canClose) void fourGroup.closeAllFourGroup();
            }}
          >
            <X size={15} />
            確認四組全數平倉
          </button>
        </div>
      </dialog>
    </div>
  );
}
