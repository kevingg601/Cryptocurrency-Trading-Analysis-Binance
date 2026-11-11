import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineSeries, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
} from 'lucide-react';
import type {
  AccountId,
  ExperimentStatus,
  ModelPaperAccountDetail,
  ModelPaperExperimentDetail,
  ModelPaperExperimentListItem,
  RollingPipelineStatus,
  SkipReason,
} from '@fadachi/core';
import { collectorClient } from '../api/collectorClient';
import { formatCryptoPrice } from '../services/utils';
import {
  DECISION_STATUS_LABELS,
  EXPERIMENT_STATUS_LABELS,
  SKIP_REASON_LABELS,
  findActiveExperiment,
  formatDurationMs,
  formatNumber,
  formatUtcTaipei,
  generateModelPaperRequestId,
  isDetailActive,
  normalizeEquitySeriesPoints,
  pickPreferredExperimentId,
} from './modelPaperHelpers';
import './ModelPaperPanel.css';

interface ModelPaperEquityChartProps {
  pointsA: Array<{ time: number; equity: number }>;
  pointsB: Array<{ time: number; equity: number }>;
  initialCapital: number;
  theme: 'dark' | 'light';
}

function ModelPaperEquityChart({ pointsA, pointsB, initialCapital, theme }: ModelPaperEquityChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const seriesA = useRef<ISeriesApi<'Line'> | null>(null);
  const seriesB = useRef<ISeriesApi<'Line'> | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!container.current) return;
    const instance = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { color: theme === 'dark' ? '#191c1c' : '#ffffff' },
        textColor: theme === 'dark' ? '#adb5b5' : '#5f6e80',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: theme === 'dark' ? '#ffffff0a' : '#0000000a' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      localization: {
        locale: 'zh-TW',
        priceFormatter: (value: number) =>
          value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
    });
    chart.current = instance;
    fitted.current = false;

    seriesA.current = instance.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'A: LightGBM + Chronos-2',
    });

    seriesB.current = instance.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'B: LightGBM 基準',
    });

    return () => {
      instance.remove();
      chart.current = null;
      seriesA.current = null;
      seriesB.current = null;
    };
  }, [theme, initialCapital]);

  useEffect(() => {
    seriesA.current?.setData(pointsA.map(p => ({ time: p.time as UTCTimestamp, value: p.equity })));
    seriesB.current?.setData(pointsB.map(p => ({ time: p.time as UTCTimestamp, value: p.equity })));
    if (!fitted.current && (pointsA.length > 1 || pointsB.length > 1)) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [pointsA, pointsB, theme, initialCapital]);

  return (
    <div className="mp-chart-wrap">
      <div
        style={{
          position: 'absolute',
          top: '8px',
          right: '12px',
          zIndex: 5,
          display: 'flex',
          flexWrap: 'wrap',
          gap: '14px',
          fontSize: '12px',
          fontWeight: 600,
          background: theme === 'dark' ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.88)',
          padding: '4px 10px',
          borderRadius: '4px',
          pointerEvents: 'none',
        }}
      >
        <span style={{ color: '#38bdf8', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '3px', background: '#38bdf8', borderRadius: '1px' }} />
          A (Chronos-2 門檻): {pointsA.at(-1)?.equity.toFixed(2) ?? initialCapital.toFixed(2)} USDT
        </span>
        <span style={{ color: '#a855f7', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '10px', height: '3px', background: '#a855f7', borderRadius: '1px' }} />
          B (LightGBM 基準): {pointsB.at(-1)?.equity.toFixed(2) ?? initialCapital.toFixed(2)} USDT
        </span>
      </div>
      <div
        ref={container}
        className="equity-chart-canvas"
        role="img"
        aria-label="模型前向測試帳戶 A 與帳戶 B 淨值比較圖"
      />
    </div>
  );
}

function statusBadgeClass(status: ExperimentStatus): string {
  if (status === 'RUNNING') return 'mp-badge mp-badge-running';
  if (status === 'PAUSED') return 'mp-badge mp-badge-paused';
  if (status === 'AWAITING_RESUME') return 'mp-badge mp-badge-awaiting';
  if (status === 'STOPPING') return 'mp-badge mp-badge-stopping';
  return 'mp-badge mp-badge-stopped';
}

function AccountCard({
  accountId,
  title,
  subtitle,
  detail,
}: {
  accountId: AccountId;
  title: string;
  subtitle: string;
  detail: ModelPaperAccountDetail;
}) {
  const { state, metrics } = detail;
  const skipEntries = Object.entries(metrics.skipReasonCounts) as Array<[SkipReason, number]>;
  const retTone = metrics.netReturn > 0 ? 'mp-pos' : metrics.netReturn < 0 ? 'mp-neg' : '';
  const realizedTone = metrics.realizedPnl > 0 ? 'mp-pos' : metrics.realizedPnl < 0 ? 'mp-neg' : '';
  const unrealTone = metrics.unrealizedPnl > 0 ? 'mp-pos' : metrics.unrealizedPnl < 0 ? 'mp-neg' : '';

  const profitFactorDisplay =
    metrics.profitFactor === Infinity
      ? '∞'
      : metrics.profitFactor !== null && Number.isFinite(metrics.profitFactor)
        ? metrics.profitFactor.toFixed(2)
        : metrics.completedTrades > 0 && metrics.winRatePct === 100
          ? '∞'
          : '--';

  return (
    <section className="mp-account-card" data-testid={`mp-account-card-${accountId}`}>
      <div className="mp-account-head">
        <div className="mp-account-title">
          <h3>{title}</h3>
          <small>{subtitle}</small>
        </div>
        <div className="mp-account-tags">
          {state.bankrupt && <span className="mp-badge mp-badge-danger">已破產 (bankrupt)</span>}
          {state.degraded && <span className="mp-badge mp-badge-awaiting">行情過期 / 估值不完整</span>}
          {state.fundingPending && <span className="mp-badge mp-badge-awaiting">成本待結算</span>}
          {!state.bankrupt && !state.degraded && !state.fundingPending && (
            <span className="mp-badge mp-badge-running">正常計價</span>
          )}
        </div>
      </div>

      <div className="mp-metrics-grid">
        <div className="mp-metric-cell">
          <span>總淨值 (USDT)</span>
          <strong>{formatNumber(metrics.equity)}</strong>
        </div>
        <div className="mp-metric-cell">
          <span>淨報酬 / 報酬率</span>
          <strong className={retTone}>
            {metrics.netReturn >= 0 ? '+' : ''}
            {formatNumber(metrics.netReturn)} ({metrics.netReturnPct >= 0 ? '+' : ''}
            {metrics.netReturnPct.toFixed(2)}%)
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>可用現金 / 保留本金</span>
          <strong>
            {formatNumber(metrics.cash)} / {formatNumber(metrics.reserved)}
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>已實現損益</span>
          <strong className={realizedTone}>
            {metrics.realizedPnl >= 0 ? '+' : ''}
            {formatNumber(metrics.realizedPnl)}
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>未實現損益</span>
          <strong className={unrealTone}>
            {metrics.unrealizedPnl >= 0 ? '+' : ''}
            {formatNumber(metrics.unrealizedPnl)}
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>手續費 / 資金費 / 滑價</span>
          <strong>
            {formatNumber(metrics.fees)} / {formatNumber(metrics.funding)} / {formatNumber(metrics.slippageCost)}
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>最大回撤 (MDD)</span>
          <strong className={metrics.maxDrawdown > 0 ? 'mp-neg' : ''}>
            -{formatNumber(metrics.maxDrawdown)} ({metrics.maxDrawdownPct.toFixed(2)}%)
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>完成交易 / 勝率 / PF</span>
          <strong>
            {metrics.completedTrades} 筆 /{' '}
            {metrics.winRatePct !== null ? `${metrics.winRatePct.toFixed(1)}%` : '--'} / {profitFactorDisplay}
          </strong>
        </div>
        <div className="mp-metric-cell">
          <span>平均持倉 / 有效觀測</span>
          <strong>
            {formatDurationMs(metrics.avgHoldDurationMs)} / {formatDurationMs(metrics.effectiveObservationMs)}
          </strong>
        </div>
      </div>

      {skipEntries.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
            略過原因統計（含執行失敗 {metrics.executionFailureCount} 次）：
          </div>
          <div className="mp-skip-chips">
            {skipEntries.map(([reason, count]) => (
              <span key={reason} className="mp-skip-chip">
                {SKIP_REASON_LABELS[reason] ?? reason}: {count}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export interface ModelPaperPanelProps {
  theme?: 'dark' | 'light';
}

export default function ModelPaperPanel({ theme = 'dark' }: ModelPaperPanelProps) {
  const [rollingPipeline, setRollingPipeline] = useState<RollingPipelineStatus | null>(null);
  const [adaptersAvailable, setAdaptersAvailable] = useState<boolean>(true);
  const [adaptersReason, setAdaptersReason] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<ModelPaperExperimentListItem[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModelPaperExperimentDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'positions' | 'fills' | 'decisions' | 'history'>('positions');

  const selectedExpIdRef = useRef<string | null>(null);
  selectedExpIdRef.current = selectedExpId;
  const refreshSeqRef = useRef<number>(0);

  const refreshData = useCallback(async (explicitId?: string | null) => {
    const reqSeq = ++refreshSeqRef.current;
    try {
      const [adaptersRes, listRes] = await Promise.all([
        collectorClient.getModelPaperAdapters(),
        collectorClient.listModelPaperExperiments(),
      ]);
      if (reqSeq !== refreshSeqRef.current) return;

      setRollingPipeline(adaptersRes.rollingPipeline ?? null);
      setAdaptersAvailable(adaptersRes.available ?? true);
      setAdaptersReason(adaptersRes.availabilityReason ?? null);

      const expList = listRes.experiments ?? [];
      setExperiments(expList);

      const targetId =
        explicitId !== undefined
          ? explicitId
          : pickPreferredExperimentId(expList, selectedExpIdRef.current);

      if (targetId) {
        setSelectedExpId(targetId);
        const expDetail = await collectorClient.getModelPaperExperiment(targetId);
        if (reqSeq !== refreshSeqRef.current) return;
        setDetail(expDetail);
        if (expDetail.rollingPipeline) {
          setRollingPipeline(expDetail.rollingPipeline);
        }
      } else {
        setSelectedExpId(null);
        setDetail(null);
      }
      setErrorMsg(null);
    } catch (err: any) {
      if (reqSeq !== refreshSeqRef.current) return;
      setErrorMsg(err?.message || '無法連線至 Collector 模型前向測試服務');
    } finally {
      if (reqSeq === refreshSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshData();
    const timer = setInterval(() => {
      void refreshData();
    }, 5_000);
    return () => clearInterval(timer);
  }, [refreshData]);

  const activeExp = useMemo(() => findActiveExperiment(experiments), [experiments]);
  const chronosReady = Boolean(rollingPipeline?.chronos2?.ready);
  const isChronosTraining = Boolean(rollingPipeline?.chronos2?.isTraining || rollingPipeline?.autoSchedule?.isTrainingChronos);

  const handleBootstrapChronos = async () => {
    setBusyAction('retrain');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const res = await collectorClient.triggerChronosRetrain(6);
      setInfoMsg(res.message);
      await refreshData();
    } catch (err: any) {
      setErrorMsg(err?.message || '啟動本機 Chronos-2 GPU 訓練失敗');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreate = async () => {
    if (!chronosReady) {
      setErrorMsg('本機 Chronos-2 LoRA 尚未完成首次 GPU 訓練，請先點擊「執行本機 GPU 訓練 (6h)」');
      return;
    }
    if (!window.confirm('確定要啟動全本機滾動模型前向模擬對照嗎？\n將以 180 天滑動視窗：每小時重訓 LightGBM＋每 6 小時於本機 GPU 重訓 Chronos-2 LoRA，並立即執行最近一小時推論。')) {
      return;
    }
    setBusyAction('create');
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const requestId = generateModelPaperRequestId('mp_create');
      refreshSeqRef.current += 1;
      const created = await collectorClient.createModelPaperExperiment({
        requestId,
        retrainIntervalHours: 6,
      });
      setDetail(created);
      setSelectedExpId(created.experiment.id);
      await refreshData(created.experiment.id);
    } catch (err: any) {
      setErrorMsg(err?.message || '建立前向測試實驗失敗');
    } finally {
      setBusyAction(null);
    }
  };

  const handleControl = async (action: 'pause' | 'resume' | 'stop') => {
    if (!detail) return;
    const confirmMessages: Record<'pause' | 'resume' | 'stop', string> = {
      pause: '確定要暫停新進場嗎？（既有持倉停損與資金費結算仍會照常運作）',
      resume: '請確認即時行情串流與標的報價正常。確定要繼續前向測試嗎？',
      stop: '確定要停止實驗並依市價＋滑價規則全數平倉嗎？此操作不可恢復。',
    };
    if (!window.confirm(confirmMessages[action])) return;

    setBusyAction(action);
    setErrorMsg(null);
    try {
      const requestId = generateModelPaperRequestId(`mp_${action}`);
      refreshSeqRef.current += 1;
      const updated =
        action === 'pause'
          ? await collectorClient.pauseModelPaperExperiment(detail.experiment.id, requestId)
          : action === 'resume'
            ? await collectorClient.resumeModelPaperExperiment(detail.experiment.id, requestId)
            : await collectorClient.stopModelPaperExperiment(detail.experiment.id, requestId);
      setDetail(updated);
      await refreshData(updated.experiment.id);
    } catch (err: any) {
      setErrorMsg(err?.message || '控制實驗操作失敗');
    } finally {
      setBusyAction(null);
    }
  };

  const handleExport = async (
    kind: 'decisions' | 'fills' | 'equity' | 'config' | 'all',
    format: 'csv' | 'json',
  ) => {
    if (!detail) return;
    setErrorMsg(null);
    try {
      const file = await collectorClient.exportModelPaperExperiment(detail.experiment.id, kind, format);
      const blob = new Blob([file.content], { type: file.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setErrorMsg(err?.message || '匯出檔案失敗');
    }
  };

  const chartPointsA = useMemo(
    () => (detail ? normalizeEquitySeriesPoints(detail.accounts.A.equityCurve) : []),
    [detail],
  );
  const chartPointsB = useMemo(
    () => (detail ? normalizeEquitySeriesPoints(detail.accounts.B.equityCurve) : []),
    [detail],
  );

  const combinedPositions = useMemo(() => {
    if (!detail) return [];
    const listA = detail.accounts.A.openPositions.map(p => ({
      ...p,
      lastPrice: detail.accounts.A.lastPrices[p.symbol] ?? p.entryPrice,
    }));
    const listB = detail.accounts.B.openPositions.map(p => ({
      ...p,
      lastPrice: detail.accounts.B.lastPrices[p.symbol] ?? p.entryPrice,
    }));
    return [...listA, ...listB].sort((a, b) => a.account.localeCompare(b.account) || a.openedAt - b.openedAt);
  }, [detail]);

  const combinedPendingOrders = useMemo(() => {
    if (!detail) return [];
    return [...detail.accounts.A.pendingOrders, ...detail.accounts.B.pendingOrders].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }, [detail]);

  const combinedFills = useMemo(() => {
    if (!detail) return [];
    return [...detail.accounts.A.fills, ...detail.accounts.B.fills].sort(
      (a, b) => b.receivedAt - a.receivedAt || b.aggId - a.aggId,
    );
  }, [detail]);

  const latestDecision = detail?.decisions?.[0] ?? null;
  const detailIsActive = isDetailActive(detail);

  return (
    <section className="mp-panel" data-testid="model-paper-panel">
      {/* Header & Experiment Controls */}
      <header className="mp-header">
        <div className="mp-title-block">
          <Activity size={20} style={{ color: 'var(--accent-secondary)', marginTop: '2px', flexShrink: 0 }} />
          <div>
            <h2>模型前向測試：Chronos-2 微調版 vs LightGBM 基準（1x 永續模擬）</h2>
            <span className="mp-subtitle">
              180 天滑動視窗・每小時整點 +30s 自動重訓 LightGBM 並同步推論・每 6 小時本機 GPU 重訓 Chronos-2 LoRA，獨立於手動模擬倉與 AI A/B 批次。
            </span>
          </div>
        </div>

        <div className="mp-controls">
          {detail && (
            <span className={statusBadgeClass(detail.experiment.status)}>
              {EXPERIMENT_STATUS_LABELS[detail.experiment.status]}
            </span>
          )}

          {!activeExp && (
            <>
              <span className="mp-status-badge" style={{ background: 'rgba(59, 130, 246, 0.14)', color: '#93c5fd' }}>
                {isChronosTraining
                  ? 'Chronos-2 本機 GPU 訓練中...'
                  : chronosReady
                    ? `本機就緒：${rollingPipeline?.chronos2?.versionId}`
                    : '尚未完成本機 Chronos-2 首次 GPU 微調'}
              </span>
              {!chronosReady && (
                <button
                  type="button"
                  className="mp-btn mp-btn-warn"
                  disabled={Boolean(busyAction) || isChronosTraining}
                  onClick={() => void handleBootstrapChronos()}
                >
                  <RefreshCw size={14} className={isChronosTraining ? 'spinning' : ''} />
                  <span>{isChronosTraining ? 'GPU 微調中...' : '執行首次本機 GPU 微調'}</span>
                </button>
              )}
              <button
                type="button"
                className="mp-btn mp-btn-primary"
                disabled={Boolean(busyAction) || !chronosReady || !adaptersAvailable || isChronosTraining}
                onClick={() => void handleCreate()}
              >
                <Play size={14} />
                <span>{busyAction === 'create' ? '啟動中...' : '開始測試'}</span>
              </button>
            </>
          )}

          {detailIsActive && detail && (
            <>
              {detail.experiment.status === 'RUNNING' && (
                <button
                  type="button"
                  className="mp-btn mp-btn-warn"
                  disabled={Boolean(busyAction)}
                  onClick={() => void handleControl('pause')}
                >
                  <Pause size={14} />
                  <span>{busyAction === 'pause' ? '處理中...' : '暫停新進場'}</span>
                </button>
              )}
              {(detail.experiment.status === 'PAUSED' || detail.experiment.status === 'AWAITING_RESUME') && (
                <button
                  type="button"
                  className="mp-btn mp-btn-primary"
                  disabled={Boolean(busyAction)}
                  onClick={() => void handleControl('resume')}
                >
                  <Play size={14} />
                  <span>{busyAction === 'resume' ? '恢復中...' : '繼續測試'}</span>
                </button>
              )}
              {detail.experiment.status !== 'STOPPING' && (
                <button
                  type="button"
                  className="mp-btn mp-btn-danger"
                  disabled={Boolean(busyAction)}
                  onClick={() => void handleControl('stop')}
                >
                  <Square size={14} />
                  <span>{busyAction === 'stop' ? '平倉中...' : '停止並平倉'}</span>
                </button>
              )}
            </>
          )}

          {activeExp && detail && detail.experiment.id !== activeExp.experiment.id && (
            <button
              type="button"
              className="mp-btn"
              onClick={() => void refreshData(activeExp.experiment.id)}
            >
              回到進行中實驗
            </button>
          )}

          <button
            type="button"
            className="mp-btn"
            title="立即重新整理狀態"
            onClick={() => void refreshData()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* Availability / Error / Status Banners */}
      {errorMsg && (
        <div className="mp-banner mp-banner-danger" role="alert">
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} />
            {errorMsg}
          </span>
        </div>
      )}

      {(infoMsg || isChronosTraining) && (
        <div className="mp-banner" role="status" style={{ background: 'rgba(59, 130, 246, 0.12)', borderColor: 'rgba(96, 165, 250, 0.35)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <RefreshCw size={15} className={isChronosTraining ? 'spinning' : ''} />
            {isChronosTraining ? '本機 GPU 正在背景重新訓練 Chronos-2 LoRA…既有模型將持續服務直到新版驗收切換。' : infoMsg}
          </span>
        </div>
      )}

      {((detail && !detail.available) || (!detail && !adaptersAvailable)) && (
        <div className="mp-banner mp-banner-warn" role="alert">
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={16} />
            模型前向測試未就緒：{(detail?.availabilityReason ?? adaptersReason) || '缺少研究幣種清單或資料集'}
          </span>
        </div>
      )}

      {detail && detail.experiment.status === 'AWAITING_RESUME' && (
        <div className="mp-banner mp-banner-warn" role="alert" data-testid="mp-awaiting-resume-banner">
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldAlert size={18} />
            <span>
              <strong>實驗已進入中斷恢復待確認狀態（AWAITING_RESUME）：</strong>
              {detail.experiment.statusReason || 'Collector 重啟或 Futures 即時行情串流曾發生中斷，排程已暫停；既有持倉停損與資金費照常運行。確認行情穩定後請按「繼續測試」。'}
            </span>
          </span>
        </div>
      )}

      {detail && !detail.comparability.comparable && (
        <div className="mp-banner mp-banner-danger" role="status" data-testid="mp-non-comparable-banner">
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={17} />
            <span>
              <strong>不可作為正式比較：</strong>
              {detail.comparability.reasons.join('；')}
            </span>
          </span>
        </div>
      )}

      {loading && !detail && (
        <div className="mp-card">
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>正在載入模型前向測試狀態...</span>
        </div>
      )}

      {!loading && !detail && (
        <div className="mp-card">
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            {chronosReady
              ? `本機滾動模型管線已就緒（LightGBM 1h 重訓・Chronos-2 6h GPU 重訓，當前版本 ${rollingPipeline?.chronos2?.versionId}）。請確認 Futures 串流連線後直接按「開始測試」。`
              : '尚未建立模型前向測試實驗，且本機尚未完成 Chronos-2 LoRA 首次 GPU 訓練（完全獨立於 Colab 實驗包）。請先按上方「執行首次本機 GPU 微調」，完成後即可開始測試。'}
          </span>
        </div>
      )}

      {detail && (
        <>
          {/* Metadata & Schedule Strip */}
          <div className="mp-meta-grid">
            <div className="mp-meta-card">
              <span>實驗 ID / 策略版本</span>
              <strong>
                {detail.experiment.id}（{detail.experiment.config.strategyVersion}）
              </strong>
            </div>
            <div className="mp-meta-card">
              <span>線上滾動模型版本（180d 滑動視窗）</span>
              <strong>
                LGBM: {rollingPipeline?.lgbm?.versionId || '--'}
                <br />
                Chronos-2: {rollingPipeline?.chronos2?.versionId || detail.experiment.modelSource.adapterRunId}
                <br />
                <small style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                  {rollingPipeline?.chronos2?.nextRetrainAt
                    ? `下次 GPU 重訓: ${formatUtcTaipei(rollingPipeline.chronos2.nextRetrainAt)}`
                    : `rev: ${detail.experiment.modelSource.baseRevision.slice(0, 12)}`}
                  {' ・ '}研究池 {detail.experiment.universe.length} 幣
                </small>
              </strong>
            </div>
            <div className="mp-meta-card">
              <span>最近決策小時與推論狀態</span>
              <strong>
                {latestDecision
                  ? `${formatUtcTaipei(latestDecision.decisionHour)} ・ ${DECISION_STATUS_LABELS[latestDecision.status]}（第 ${latestDecision.attempts} 次）`
                  : '尚未產生決策'}
                {latestDecision?.reason && (
                  <>
                    <br />
                    <small style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>{latestDecision.reason}</small>
                  </>
                )}
              </strong>
            </div>
            <div className="mp-meta-card">
              <span>下次排程時間 / 中斷紀錄</span>
              <strong>
                {detail.nextScheduleAt ? formatUtcTaipei(detail.nextScheduleAt) : '--'}
                <br />
                <small style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                  Gaps: {detail.gaps.length} 筆
                  {detail.comparability.comparable ? ' ・ 兩帳戶可正式比較' : ' ・ 不可作為正式比較'}
                </small>
              </strong>
            </div>
          </div>

          {/* Account A & B Cards */}
          <div className="mp-ab-grid">
            <AccountCard
              accountId="A"
              title="帳戶 A：LightGBM + Chronos-2 (> 0.25%)"
              subtitle="多空各 Top 3 去重排除衝突 + Chronos-2 同向且預期報酬嚴格 > 0.25%"
              detail={detail.accounts.A}
            />
            <AccountCard
              accountId="B"
              title="帳戶 B：LightGBM 基準對照組"
              subtitle="相同 LightGBM 候選池，不套用 Chronos-2 方向／門檻過濾"
              detail={detail.accounts.B}
            />
          </div>

          {/* Dual Equity Curve */}
          <section className="mp-card">
            <div className="mp-card-head">
              <h3>
                <Clock size={16} />
                <span>雙帳戶淨值走勢比較（初始本金 {formatNumber(detail.experiment.config.initialCash)} USDT）</span>
              </h3>
              <div className="mp-export-bar">
                <button type="button" className="mp-btn" onClick={() => void handleExport('all', 'json')}>
                  <Download size={13} /> 匯出全部 JSON
                </button>
                <button type="button" className="mp-btn" onClick={() => void handleExport('decisions', 'csv')}>
                  <Download size={13} /> 決策 CSV
                </button>
                <button type="button" className="mp-btn" onClick={() => void handleExport('fills', 'csv')}>
                  <Download size={13} /> 成交 CSV
                </button>
                <button type="button" className="mp-btn" onClick={() => void handleExport('equity', 'csv')}>
                  <Download size={13} /> 淨值 CSV
                </button>
                <button type="button" className="mp-btn" onClick={() => void handleExport('config', 'csv')}>
                  <Download size={13} /> 設定 CSV
                </button>
              </div>
            </div>
            {chartPointsA.length > 0 || chartPointsB.length > 0 ? (
              <ModelPaperEquityChart
                key={detail.experiment.id}
                pointsA={chartPointsA}
                pointsB={chartPointsB}
                initialCapital={detail.experiment.config.initialCash}
                theme={theme}
              />
            ) : (
              <div className="empty-state" style={{ padding: '24px' }}>尚無淨值時間序列資料</div>
            )}
          </section>

          {/* Gaps Notice Table if any */}
          {detail.gaps.length > 0 && (
            <section className="mp-card">
              <div className="mp-card-head">
                <h3>
                  <AlertTriangle size={16} style={{ color: '#fbbf24' }} />
                  <span>行情中斷與重啟紀錄 ({detail.gaps.length})</span>
                </h3>
              </div>
              <div className="mp-table-wrap">
                <table className="mp-table">
                  <thead>
                    <tr>
                      <th>類型</th>
                      <th>帳戶</th>
                      <th>開始時間</th>
                      <th>結束時間</th>
                      <th>說明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.gaps.map(g => (
                      <tr key={g.id}>
                        <td>{g.kind}</td>
                        <td>{g.account}</td>
                        <td>{formatUtcTaipei(g.startedAt)}</td>
                        <td>{g.endedAt ? formatUtcTaipei(g.endedAt) : '進行中'}</td>
                        <td>{g.detail || '--'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Positions / Fills / Decisions / History Tabs */}
          <section className="mp-card">
            <div className="mp-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeSubTab === 'positions'}
                className={`mp-tab-btn ${activeSubTab === 'positions' ? 'active' : ''}`}
                onClick={() => setActiveSubTab('positions')}
              >
                目前持倉 ({combinedPositions.length}) / 掛單 ({combinedPendingOrders.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSubTab === 'fills'}
                className={`mp-tab-btn ${activeSubTab === 'fills' ? 'active' : ''}`}
                onClick={() => setActiveSubTab('fills')}
              >
                成交明細 ({combinedFills.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSubTab === 'decisions'}
                className={`mp-tab-btn ${activeSubTab === 'decisions' ? 'active' : ''}`}
                onClick={() => setActiveSubTab('decisions')}
              >
                每小時決策紀錄 ({detail.decisions.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSubTab === 'history'}
                className={`mp-tab-btn ${activeSubTab === 'history' ? 'active' : ''}`}
                onClick={() => setActiveSubTab('history')}
              >
                歷史實驗清單 ({experiments.length})
              </button>
            </div>

            {activeSubTab === 'positions' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="mp-table-wrap">
                  <table className="mp-table">
                    <thead>
                      <tr>
                        <th>帳戶</th>
                        <th>標的</th>
                        <th>方向</th>
                        <th>數量</th>
                        <th>進場均價</th>
                        <th>固定停損價</th>
                        <th>最新成交價</th>
                        <th>未實現損益</th>
                        <th>開倉時間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combinedPositions.length === 0 ? (
                        <tr>
                          <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                            目前無持倉部位
                          </td>
                        </tr>
                      ) : (
                        combinedPositions.map(pos => {
                          const dir = pos.side === 'LONG' ? 1 : -1;
                          const unreal = dir * (pos.lastPrice - pos.entryPrice) * pos.qty;
                          return (
                            <tr key={pos.id}>
                              <td><strong>{pos.account}</strong></td>
                              <td><strong>{pos.symbol}</strong></td>
                              <td className={pos.side === 'LONG' ? 'mp-pos' : 'mp-neg'}>
                                {pos.side === 'LONG' ? '做多 LONG' : '做空 SHORT'}
                              </td>
                              <td>{pos.qty}</td>
                              <td>${formatCryptoPrice(pos.entryPrice)}</td>
                              <td>${formatCryptoPrice(pos.stopPrice)}</td>
                              <td>${formatCryptoPrice(pos.lastPrice)}</td>
                              <td className={unreal >= 0 ? 'mp-pos' : 'mp-neg'}>
                                {unreal >= 0 ? '+' : ''}
                                {formatNumber(unreal)}
                              </td>
                              <td>{formatUtcTaipei(pos.openedAt)}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {combinedPendingOrders.length > 0 && (
                  <div className="mp-table-wrap">
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      等待成交委託 ({combinedPendingOrders.length})：
                    </div>
                    <table className="mp-table">
                      <thead>
                        <tr>
                          <th>帳戶</th>
                          <th>標的</th>
                          <th>動作 / 方向</th>
                          <th>原因</th>
                          <th>數量</th>
                          <th>參考價</th>
                          <th>建立時間</th>
                        </tr>
                      </thead>
                      <tbody>
                        {combinedPendingOrders.map(ord => (
                          <tr key={ord.id}>
                            <td>{ord.account}</td>
                            <td><strong>{ord.symbol}</strong></td>
                            <td>{ord.action} ({ord.side})</td>
                            <td>{ord.reason}</td>
                            <td>{ord.qty}</td>
                            <td>${formatCryptoPrice(ord.refPrice)}</td>
                            <td>{formatUtcTaipei(ord.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeSubTab === 'fills' && (
              <div className="mp-table-wrap">
                <table className="mp-table">
                  <thead>
                    <tr>
                      <th>成交接收時間</th>
                      <th>帳戶</th>
                      <th>標的</th>
                      <th>動作</th>
                      <th>原始成交價</th>
                      <th>含滑價成交價</th>
                      <th>數量</th>
                      <th>手續費</th>
                      <th>滑價成本</th>
                      <th>已實現損益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combinedFills.length === 0 ? (
                      <tr>
                        <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                          尚無成交紀錄
                        </td>
                      </tr>
                    ) : (
                      combinedFills.map(f => (
                        <tr key={f.orderId}>
                          <td>{formatUtcTaipei(f.receivedAt)}</td>
                          <td><strong>{f.account}</strong></td>
                          <td><strong>{f.symbol}</strong></td>
                          <td>{f.action || '--'}</td>
                          <td>${formatCryptoPrice(f.rawPrice)}</td>
                          <td>${formatCryptoPrice(f.fillPrice)}</td>
                          <td>{f.qty}</td>
                          <td>{formatNumber(f.fee, 4)}</td>
                          <td>{formatNumber(f.slippageCost, 4)}</td>
                          <td className={f.realizedPnl > 0 ? 'mp-pos' : f.realizedPnl < 0 ? 'mp-neg' : ''}>
                            {f.realizedPnl !== 0 ? `${f.realizedPnl >= 0 ? '+' : ''}${formatNumber(f.realizedPnl, 4)}` : '--'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeSubTab === 'decisions' && (
              <div className="mp-table-wrap">
                <table className="mp-table">
                  <thead>
                    <tr>
                      <th>決策小時 (H)</th>
                      <th>狀態</th>
                      <th>嘗試次數</th>
                      <th>A 有效訊號</th>
                      <th>B 有效訊號</th>
                      <th>A 略過項目</th>
                      <th>當輪模型版本 (LGBM / Chronos)</th>
                      <th>說明 / 原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.decisions.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                          尚無小時決策紀錄
                        </td>
                      </tr>
                    ) : (
                      detail.decisions.map(dec => {
                        const mv = dec.modelVersions ?? dec.signals?.modelVersions;
                        return (
                          <tr key={dec.id}>
                            <td>{formatUtcTaipei(dec.decisionHour)}</td>
                            <td>{DECISION_STATUS_LABELS[dec.status]}</td>
                            <td>{dec.attempts}</td>
                            <td>{dec.signals?.signalsA?.map(s => `${s.symbol}(${s.side[0]})`).join(', ') || '--'}</td>
                            <td>{dec.signals?.signalsB?.map(s => `${s.symbol}(${s.side[0]})`).join(', ') || '--'}</td>
                            <td>
                              {dec.signals?.skippedA?.map(s => `${s.symbol}:${s.reason}`).join(', ') || '--'}
                            </td>
                            <td style={{ fontSize: '11px', fontFamily: 'monospace' }}>
                              {mv ? `${mv.lgbmVersionId || mv.lgbmLongSha256?.slice(0, 8)} / ${mv.chronosVersionId || '--'}` : '--'}
                            </td>
                            <td>{dec.reason || '--'}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeSubTab === 'history' && (
              <div className="mp-table-wrap">
                <table className="mp-table">
                  <thead>
                    <tr>
                      <th>實驗 ID</th>
                      <th>狀態</th>
                      <th>模型來源 / Pipeline</th>
                      <th>開始時間</th>
                      <th>帳戶 A 淨值 (報酬率)</th>
                      <th>帳戶 B 淨值 (報酬率)</th>
                      <th>可比性</th>
                    </tr>
                  </thead>
                  <tbody>
                    {experiments.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                          尚無歷史實驗紀錄
                        </td>
                      </tr>
                    ) : (
                      experiments.map(item => {
                        const isSelected = detail.experiment.id === item.experiment.id;
                        return (
                          <tr
                            key={item.experiment.id}
                            className={isSelected ? 'mp-row-selected' : ''}
                            style={{ cursor: 'pointer' }}
                            onClick={() => void refreshData(item.experiment.id)}
                          >
                            <td><strong>{item.experiment.id}</strong></td>
                            <td>
                              <span className={statusBadgeClass(item.experiment.status)}>
                                {EXPERIMENT_STATUS_LABELS[item.experiment.status]}
                              </span>
                            </td>
                            <td>
                              {item.experiment.modelSource.pipelineMode === 'local-rolling'
                                ? `本機滾動 (${item.experiment.modelSource.retrainIntervalHours ?? 6}h GPU)`
                                : item.experiment.modelSource.adapterRunId}
                            </td>
                            <td>{formatUtcTaipei(item.experiment.startedAt)}</td>
                            <td className={item.returnPctA >= 0 ? 'mp-pos' : 'mp-neg'}>
                              {formatNumber(item.equityA)} ({item.returnPctA >= 0 ? '+' : ''}
                              {item.returnPctA.toFixed(2)}%)
                            </td>
                            <td className={item.returnPctB >= 0 ? 'mp-pos' : 'mp-neg'}>
                              {formatNumber(item.equityB)} ({item.returnPctB >= 0 ? '+' : ''}
                              {item.returnPctB.toFixed(2)}%)
                            </td>
                            <td>
                              {item.comparable ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--trend-up)' }}>
                                  <CheckCircle2 size={13} /> 可比較
                                </span>
                              ) : (
                                <span style={{ color: '#f87171' }}>不可作為正式比較</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
