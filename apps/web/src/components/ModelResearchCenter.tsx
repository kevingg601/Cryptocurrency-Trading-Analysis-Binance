import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Cpu,
  Play,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
  Layers,
  XCircle,
} from 'lucide-react';
import {
  type KronosCandlePoint,
  type KronosModelKey,
  type KronosSymbolForecast,
  type MarketType,
  type ModelResearchJobRecord,
  type ModelResearchRunResult,
  type ModelResearchStatusResponse,
  type ResearchRankingEntry,
  type ResearchRunValidityStatus,
  deriveResearchPanelState,
} from '@fadachi/core';
import { collectorClient } from '../api/collectorClient';
import { formatCryptoPrice } from '../services/utils';
import './ModelResearchCenter.css';

export interface ModelResearchCenterProps {
  marketType: MarketType;
  theme: 'dark' | 'light';
  selectedSymbol?: string;
  onSelectSymbol?: (symbol: string) => void;
  onSwitchToFutures?: () => void;
}

function formatUtcAndTaipei(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const utcStr = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const tpeStr = d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${utcStr}（台北 ${tpeStr}）`;
}

function formatPct(val?: number | null, digits = 2): string {
  if (val === undefined || val === null || !Number.isFinite(val)) return '--';
  const pct = val * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

const STATUS_LABELS: Record<ResearchRunValidityStatus, string> = {
  UNCONFIGURED: '未設定 (UNCONFIGURED)',
  LOADING: '載入／推論中 (LOADING)',
  EMPTY: '尚無推論結果 (EMPTY)',
  INSUFFICIENT_DATA: '資料不足 (INSUFFICIENT_DATA)',
  MODEL_MISSING: '模型缺失 (MODEL_MISSING)',
  FAILED: '推論失敗 (FAILED)',
  SUCCESS: '有效結果 (SUCCESS)',
  EXPIRED: '結果已過期 (EXPIRED)',
};

function ChronosCloseChart({ forecast }: { forecast: KronosSymbolForecast }) {
  const history = forecast.historicalCandles.map(c => c.close);
  const predicted = forecast.predictedCloses?.map(c => c.close) ?? [];
  const values = [...history, ...predicted];
  if (!values.length) return null;
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  const point = (v: number, i: number) => `${20 + i / Math.max(values.length - 1, 1) * 760},${220 - (v - min) / span * 190}`;
  return <svg viewBox="0 0 800 250" width="100%" role="img" aria-label={`${forecast.symbol} 歷史收盤價與 Chronos-2 未來四小時收盤價預測`}>
    <polyline fill="none" stroke="#94a3b8" strokeWidth="2" points={history.map(point).join(' ')} />
    <polyline fill="none" stroke="#60a5fa" strokeWidth="3" strokeDasharray="6 4"
      points={[history[history.length - 1], ...predicted].map((v,i) => point(v, history.length - 1 + i)).join(' ')} />
    <text x="20" y="245" fill="#94a3b8" fontSize="12">灰線：歷史收盤價 / 藍色虛線：未來 4 小時收盤價中位數預測</text>
  </svg>;
}

function KronosForecastSvgChart({
  forecast,
}: {
  forecast: KronosSymbolForecast;
}) {
  const hist = forecast.historicalCandles.slice(-64);
  const pred = forecast.predictedCandles;
  const totalCount = hist.length + pred.length;
  if (totalCount === 0) {
    return <div className="mr-note">無可繪製之 K 線資料</div>;
  }

  const allLows: number[] = [
    ...hist.map((c) => c.low),
    ...pred.map((c) => Math.min(c.low, c.sampleDispersion?.closeMin ?? c.low)),
  ];
  const allHighs: number[] = [
    ...hist.map((c) => c.high),
    ...pred.map((c) => Math.max(c.high, c.sampleDispersion?.closeMax ?? c.high)),
  ];
  const minPrice = Math.min(...allLows);
  const maxPrice = Math.max(...allHighs);
  const pad = Math.max((maxPrice - minPrice) * 0.08, minPrice * 0.002, 1e-6);
  const yMin = minPrice - pad;
  const yMax = maxPrice + pad;

  const width = 760;
  const height = 240;
  const leftPad = 14;
  const rightPad = 72;
  const topPad = 16;
  const bottomPad = 24;
  const plotW = width - leftPad - rightPad;
  const plotH = height - topPad - bottomPad;

  const xForIndex = (idx: number) =>
    leftPad + ((idx + 0.5) / Math.max(totalCount, 1)) * plotW;
  const yForPrice = (p: number) =>
    topPad + (1 - (p - yMin) / Math.max(yMax - yMin, 1e-9)) * plotH;

  const barW = Math.max(3, Math.min(10, (plotW / Math.max(totalCount, 1)) * 0.62));
  const cutoffX = hist.length > 0 ? (xForIndex(hist.length - 1) + xForIndex(hist.length)) / 2 : leftPad;

  // Build sample dispersion polygon (from last historical close -> 4 predicted dispersion min/max)
  const anchorIdx = hist.length > 0 ? hist.length - 1 : 0;
  const anchorClose = hist.length > 0 ? hist[hist.length - 1].close : pred[0]?.open ?? 0;

  const upperPoints: string[] = [`${xForIndex(anchorIdx)},${yForPrice(anchorClose)}`];
  const lowerPoints: string[] = [`${xForIndex(anchorIdx)},${yForPrice(anchorClose)}`];
  const meanLinePoints: string[] = [`${xForIndex(anchorIdx)},${yForPrice(anchorClose)}`];

  pred.forEach((c, i) => {
    const idx = hist.length + i;
    const x = xForIndex(idx);
    const hi = c.sampleDispersion?.closeMax ?? c.high;
    const lo = c.sampleDispersion?.closeMin ?? c.low;
    upperPoints.push(`${x},${yForPrice(hi)}`);
    lowerPoints.unshift(`${x},${yForPrice(lo)}`);
    meanLinePoints.push(`${x},${yForPrice(c.close)}`);
  });

  const dispersionPolygon = [...upperPoints, ...lowerPoints].join(' ');

  return (
    <div className="mr-chart-box">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mr-svg-chart"
        role="img"
        aria-label={`${forecast.symbol} 歷史 K 線與 所選模型未來 4 小時預測路徑`}
      >
        {/* Horizontal price grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const priceVal = yMax - ratio * (yMax - yMin);
          const y = topPad + ratio * plotH;
          return (
            <g key={ratio}>
              <line
                x1={leftPad}
                y1={y}
                x2={width - rightPad}
                y2={y}
                stroke="rgba(148, 163, 184, 0.14)"
                strokeDasharray="3 3"
              />
              <text
                x={width - rightPad + 6}
                y={y + 4}
                fontSize="10"
                fill="rgba(148, 163, 184, 0.85)"
              >
                ${formatCryptoPrice(priceVal)}
              </text>
            </g>
          );
        })}

        {/* Sample dispersion shaded area (strictly labeled as sample dispersion) */}
        {pred.length > 0 && (
          <polygon
            points={dispersionPolygon}
            fill="rgba(59, 130, 246, 0.18)"
            stroke="rgba(59, 130, 246, 0.35)"
            strokeDasharray="2 2"
          />
        )}

        {/* Cutoff vertical divider */}
        <line
          x1={cutoffX}
          y1={topPad}
          x2={cutoffX}
          y2={height - bottomPad}
          stroke="#f59e0b"
          strokeWidth={1.2}
          strokeDasharray="4 4"
        />
        <text x={cutoffX + 5} y={topPad + 11} fontSize="10" fill="#fbbf24" fontWeight={600}>
          截止點 → 未來 4h 預測
        </text>

        {/* Historical closed 1h candles */}
        {hist.map((c: KronosCandlePoint, i: number) => {
          const x = xForIndex(i);
          const isUp = c.close >= c.open;
          const color = isUp ? '#10b981' : '#ef4444';
          const bodyTop = yForPrice(Math.max(c.open, c.close));
          const bodyBot = yForPrice(Math.min(c.open, c.close));
          const bodyH = Math.max(1.5, bodyBot - bodyTop);
          return (
            <g key={`h-${c.openTime}`}>
              <line x1={x} y1={yForPrice(c.high)} x2={x} y2={yForPrice(c.low)} stroke={color} strokeWidth={1} />
              <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH} fill={color} opacity={0.85} />
            </g>
          );
        })}

        {/* Kronos predicted 4 candles */}
        {pred.map((c: KronosCandlePoint, i: number) => {
          const idx = hist.length + i;
          const x = xForIndex(idx);
          const isUp = c.close >= c.open;
          const color = isUp ? '#38bdf8' : '#f472b6';
          const bodyTop = yForPrice(Math.max(c.open, c.close));
          const bodyBot = yForPrice(Math.min(c.open, c.close));
          const bodyH = Math.max(2, bodyBot - bodyTop);
          return (
            <g key={`p-${c.openTime}`}>
              <line
                x1={x}
                y1={yForPrice(c.high)}
                x2={x}
                y2={yForPrice(c.low)}
                stroke={color}
                strokeWidth={1.4}
              />
              <rect
                x={x - barW / 2}
                y={bodyTop}
                width={barW}
                height={bodyH}
                fill={color}
                stroke="#ffffff"
                strokeWidth={0.5}
              />
              <text x={x - 8} y={height - 6} fontSize="10" fill="#93c5fd">
                +{i + 1}h
              </text>
            </g>
          );
        })}

        {/* Mean predicted close trajectory */}
        {pred.length > 0 && (
          <polyline
            fill="none"
            stroke="#60a5fa"
            strokeWidth={2}
            points={meanLinePoints.join(' ')}
          />
        )}
      </svg>
    </div>
  );
}

export default function ModelResearchCenter({
  marketType,
  selectedSymbol: propSymbol,
  onSelectSymbol,
  onSwitchToFutures,
}: ModelResearchCenterProps) {
  const [selectedKronosModel, setSelectedKronosModel] = useState<KronosModelKey>('chronos2');
  const [statusData, setStatusData] = useState<ModelResearchStatusResponse | null>(null);
  const [latestResult, setLatestResult] = useState<ModelResearchRunResult | null>(null);
  const [activeJob, setActiveJob] = useState<ModelResearchJobRecord | null>(null);
  const [loadingInitial, setLoadingInitial] = useState<boolean>(true);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [retrainFeedback, setRetrainFeedback] = useState<string | null>(null);
  const [triggeringRetrain, setTriggeringRetrain] = useState<boolean>(false);
  const [focusSymbol, setFocusSymbol] = useState<string>(propSymbol || 'BTCUSDT');

  const refreshAll = useCallback(async () => {
    try {
      const [statusRes, latestRes] = await Promise.all([
        collectorClient.getResearchStatus(),
        collectorClient.getResearchLatest(),
      ]);
      setStatusData(statusRes);
      const latestGenAt = latestRes?.result?.generatedAt ?? 0;
      const lastJob = statusRes.lastJob ?? null;
      const lastJobTime = lastJob?.completedAt ?? lastJob?.createdAt ?? 0;

      if (statusRes.activeJob && statusRes.activeJob.status === 'RUNNING') {
        setActiveJob(statusRes.activeJob);
        setLatestResult(latestRes?.result ?? null);
      } else if (lastJob && lastJobTime >= latestGenAt && (lastJob.status === 'FAILED' || lastJob.result?.status === 'INSUFFICIENT_DATA')) {
        setActiveJob(lastJob);
        setLatestResult(lastJob.result ?? latestRes?.result ?? null);
      } else {
        setActiveJob((prev) => (prev?.status === 'FAILED' && (prev.completedAt ?? prev.createdAt) >= latestGenAt ? prev : null));
        setLatestResult(latestRes?.result ?? null);
      }
    } catch (err: any) {
      setTriggerError(`無法取得模型研究狀態：${err?.message || '連線失敗'}`);
    } finally {
      setLoadingInitial(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => {
      void refreshAll();
    }, 20_000);
    return () => clearInterval(timer);
  }, [refreshAll]);

  // Poll active RUNNING job until completion or failure
  useEffect(() => {
    if (!activeJob || activeJob.status !== 'RUNNING') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await collectorClient.getResearchJob(activeJob.jobId);
        if (cancelled) return;
        setActiveJob(job);
        if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
          await refreshAll();
        }
      } catch (err: any) {
        if (!cancelled) {
          setTriggerError(err?.message || '查詢推論工作狀態失敗');
        }
      }
    };
    const interval = setInterval(() => {
      void poll();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeJob, refreshAll]);

  // Keep focusSymbol synced with available forecast symbols
  useEffect(() => {
    if (!latestResult?.forecasts) return;
    const keys = Object.keys(latestResult.forecasts);
    if (keys.length > 0 && !keys.includes(focusSymbol)) {
      setFocusSymbol(keys[0]);
    }
  }, [latestResult, focusSymbol]);

  const handleRunInference = async () => {
    if (marketType !== 'futures') {
      setTriggerError('模型選幣研究僅支援 Binance USDT 永續合約（futures），請先切換至合約模式。');
      return;
    }
    try {
      setTriggerError(null);
      const started = await collectorClient.runResearchInference({
        kronosModel: selectedKronosModel,
        market: 'futures',
      });
      setActiveJob({
        jobId: started.jobId,
        runId: started.runId,
        kronosModel: started.kronosModel,
        status: 'RUNNING',
        createdAt: started.startedAt,
        startedAt: started.startedAt,
      });
    } catch (err: any) {
      setTriggerError(err?.message || '啟動模型推論失敗');
    }
  };

  const handleTriggerChronosRetrain = async () => {
    try {
      setTriggerError(null);
      setTriggeringRetrain(true);
      const res = await collectorClient.triggerChronosRetrain(6);
      setRetrainFeedback(res.message);
      await refreshAll();
    } catch (err: any) {
      setTriggerError(err?.message || '啟動本機 Chronos-2 GPU 重訓失敗');
    } finally {
      setTriggeringRetrain(false);
    }
  };

  // Compute overall panel validity status covering all 8 required states
  const panelState: ResearchRunValidityStatus = useMemo(
    () =>
      deriveResearchPanelState({
        marketType,
        loadingInitial,
        statusData,
        activeJob,
        latestResult,
        selectedKronosModel,
      }),
    [marketType, loadingInitial, statusData, activeJob, selectedKronosModel, latestResult],
  );

  const forecastSymbols = useMemo(
    () => (latestResult?.forecasts ? Object.keys(latestResult.forecasts) : []),
    [latestResult],
  );
  const selectedForecast = latestResult?.forecasts?.[focusSymbol] ?? null;
  const offlineComp = latestResult?.offlineComparison ?? statusData?.offlineComparison ?? null;

  const rolling = statusData?.rollingPipeline ?? null;
  const isChronosTraining = Boolean(rolling?.chronos2?.isTraining || rolling?.autoSchedule?.isTrainingChronos);

  return (
    <div className="mr-container" data-testid="model-research-center">
      {/* Header Bar */}
      <header className="mr-header">
        <div className="mr-header-title">
          <Cpu size={22} color="#60a5fa" />
          <div>
            <h2>模型選幣研究（LightGBM 排名 + 時序模型預測）</h2>
            <span className="mr-subtitle">
              USDT 永續合約・180 天滑動視窗・LightGBM 每小時自動重訓・Chronos-2 LoRA 每 6 小時本機 GPU 重訓
            </span>
          </div>
        </div>

        <div className="mr-header-controls">
          <span className={`mr-status-badge status-${panelState}`} data-testid="mr-validity-badge">
            {panelState === 'SUCCESS' && <CheckCircle2 size={14} />}
            {panelState === 'EXPIRED' && <Clock size={14} />}
            {(panelState === 'FAILED' || panelState === 'MODEL_MISSING') && <XCircle size={14} />}
            {panelState === 'LOADING' && <RefreshCw size={14} className="spinning" />}
            <span>{STATUS_LABELS[panelState]}</span>
          </span>

          <div className="mr-model-selector" role="group" aria-label="選擇預測模型">
            <button type="button" className={`mr-model-btn ${selectedKronosModel === 'chronos2' ? 'active' : ''}`}
              disabled={panelState === 'LOADING'} onClick={() => setSelectedKronosModel('chronos2')}>
              Chronos-2 微調版
            </button>
            <button
              type="button"
              className={`mr-model-btn ${selectedKronosModel === 'small' ? 'active' : ''}`}
              disabled={panelState === 'LOADING'}
              onClick={() => setSelectedKronosModel('small')}
              title="預設載入 Kronos-small (24.7M)，不與 base 共駐顯存"
            >
              Kronos-small
            </button>
            <button
              type="button"
              className={`mr-model-btn ${selectedKronosModel === 'base' ? 'active' : ''}`}
              disabled={panelState === 'LOADING'}
              onClick={() => setSelectedKronosModel('base')}
              title="明確選取後才載入 Kronos-base (102.3M)，載入前自動釋放 small 顯存"
            >
              Kronos-base
            </button>
          </div>

          <button
            type="button"
            className="mr-run-btn"
            disabled={panelState === 'LOADING' || marketType !== 'futures' || isChronosTraining}
            onClick={() => void handleRunInference()}
            title={
              marketType !== 'futures'
                ? '此功能僅支援 USDT 永續合約模式'
                : `更新 180 天資料、重訓 LightGBM 並執行 ${selectedKronosModel === 'chronos2' ? 'Chronos-2 本機微調版' : `Kronos-${selectedKronosModel}`} 推論`
            }
          >
            <Play size={14} />
            <span>{panelState === 'LOADING' ? '更新／重訓／推論中...' : `立即更新並推論 (${selectedKronosModel})`}</span>
          </button>

          <button
            type="button"
            className="mr-secondary-btn"
            disabled={triggeringRetrain || isChronosTraining || panelState === 'LOADING'}
            onClick={() => void handleTriggerChronosRetrain()}
            title="立即於背景使用本機 GPU 重新訓練 Chronos-2 LoRA（預設每 6 小時自動執行）"
          >
            <RefreshCw size={14} className={isChronosTraining ? 'spinning' : ''} />
            <span>{isChronosTraining ? 'GPU 微調中...' : '重訓 Chronos-2 (GPU)'}</span>
          </button>

          <button
            type="button"
            className="mr-refresh-btn"
            onClick={() => void refreshAll()}
            title="重新整理研究狀態"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      {/* Spot Market Warning Banner */}
      {marketType === 'spot' && (
        <div className="mr-banner spot-warning" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={18} />
            <span>
              <strong>現貨模式提示：</strong>
              「模型選幣研究」僅支援 <strong>Binance USDT 永續合約（Perpetual Futures）</strong> 研究。目前處於現貨模式，已停用推論觸發；請切換至「合約」模式後執行。
            </span>
          </div>
          {onSwitchToFutures && (
            <button type="button" className="mr-run-btn" onClick={onSwitchToFutures}>
              切換至合約模式
            </button>
          )}
        </div>
      )}

      {/* Explicit Job Failure / Error Banner (never disguises old result as success) */}
      {(triggerError || activeJob?.status === 'FAILED') && (
        <div className="mr-banner error-banner" role="alert">
          <div>
            <strong>
              <XCircle size={15} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
              推論工作失敗
              {activeJob?.errorCode ? ` [${activeJob.errorCode}]` : ''}：
            </strong>
            <span>
              {triggerError || activeJob?.errorMessage || 'Worker 執行失敗'}
              （依規範保留明確失敗狀態，絕不以舊結果冒充本次推論成功；OOM 不靜默縮短窗口、換模型或改 CPU）
            </span>
          </div>
        </div>
      )}

      {(retrainFeedback || isChronosTraining) && (
        <div className="mr-banner" role="status" style={{ background: 'rgba(59, 130, 246, 0.12)', borderColor: 'rgba(96, 165, 250, 0.35)' }}>
          <div>
            <RefreshCw size={15} className={isChronosTraining ? 'spinning' : ''} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
            <span>
              {isChronosTraining
                ? '正在背景使用本機 GPU 重新訓練 Chronos-2 LoRA（180 天滑動視窗）…期間既有模型可照常推論。'
                : retrainFeedback}
            </span>
          </div>
        </div>
      )}

      {rolling && (
        <section className="mr-meta-strip">
          <div className="mr-meta-card">
            <span>LightGBM 滾動重訓（每 1 小時 / CPU）</span>
            <strong>
              {rolling.lgbm?.ready
                ? `${rolling.lgbm.versionId} ・ ${formatUtcAndTaipei(rolling.lgbm.trainedAt)}`
                : '尚未完成滾動訓練（將於下次整點或手動觸發建立）'}
            </strong>
            {rolling.lgbm?.valNdcg5Long != null && rolling.lgbm?.valNdcg5Short != null && (
              <span className="mr-note">
                Val NDCG@5：多 {rolling.lgbm.valNdcg5Long.toFixed(4)} / 空 {rolling.lgbm.valNdcg5Short.toFixed(4)}
              </span>
            )}
          </div>
          <div className="mr-meta-card">
            <span>Chronos-2 LoRA（每 {rolling.chronos2?.retrainIntervalHours ?? 6} 小時 / 本機 GPU）</span>
            <strong>
              {rolling.chronos2?.ready
                ? `${rolling.chronos2.versionId} ・ ${formatUtcAndTaipei(rolling.chronos2.trainedAt)}`
                : rolling.chronos2?.isTraining
                  ? '首次本機 GPU 訓練進行中...'
                  : `尚未就緒（${rolling.chronos2?.reason || '請點擊「重訓 Chronos-2 (GPU)」'}）`}
            </strong>
            <span className="mr-note">
              {rolling.chronos2?.valReturnMae != null ? `Val 4h MAE：${(rolling.chronos2.valReturnMae * 100).toFixed(3)}% ・ ` : ''}
              下次 GPU 重訓：{rolling.chronos2?.nextRetrainAt ? formatUtcAndTaipei(rolling.chronos2.nextRetrainAt) : '--'}
            </span>
          </div>
          <div className="mr-meta-card">
            <span>每小時自動更新排程 / 滑動視窗</span>
            <strong>
              {rolling.autoSchedule?.enabled ? '自動運作中' : '待機'} ・ {rolling.windowDays} 天滾動視窗
            </strong>
            <span className="mr-note">
              下次整點更新：{rolling.autoSchedule?.nextRunAt ? formatUtcAndTaipei(rolling.autoSchedule.nextRunAt) : '--'}
            </span>
          </div>
        </section>
      )}

      {/* Expired Result Banner */}
      {panelState === 'EXPIRED' && latestResult && (
        <div className="mr-banner expired-banner" role="status">
          <div>
            <Clock size={15} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
            <strong>研究結果已過期：</strong>
            資料截止時間為 {formatUtcAndTaipei(latestResult.cutoffTime)}，已超過下一小時截止點（{formatUtcAndTaipei(latestResult.expiresAt)}）。系統將於每小時整點自動同步與推論，亦可點擊右上方「立即更新並推論」馬上同步 180 天資料並重訓 LightGBM。
          </div>
        </div>
      )}

      {/* Unconfigured / Model Missing / Empty / Insufficient Data States */}
      {panelState === 'UNCONFIGURED' && (
        <section className="mr-card" role="status">
          <h3>環境或研究資料集尚未設定 (UNCONFIGURED)</h3>
          <p className="mr-note">
            {statusData?.statusReason || '尚未準備 180 天 1 小時 K 線與資金費率資料集。請先確認研究環境與幣種種子資料，或執行資料準備：'}
          </p>
          <pre style={{ background: 'var(--bg-primary)', padding: '10px', borderRadius: '8px', fontSize: '12px', overflowX: 'auto' }}>
            {`.\\.venv\\Scripts\\python.exe -m research.model_research.cli prepare-data\n.\\.venv\\Scripts\\python.exe -m research.model_research.cli download-weights --model all`}
          </pre>
        </section>
      )}

      {panelState === 'MODEL_MISSING' && (
        <section className="mr-card" role="alert">
          <h3>模型權重或排名模型缺失 (MODEL_MISSING)</h3>
          <p className="mr-note">
            Chronos-2（本機滾動 LoRA）：{statusData?.chronos2?.installed ? '已就緒' : '未就緒'}（{statusData?.chronos2?.reason ?? statusData?.chronos2?.runId ?? '尚未完成本機 GPU 微調'}）｜ LightGBM 滾動排名：{statusData?.lightgbmReady ? '已就緒（每小時自動重訓）' : '將在首次更新與推論時自動訓練'} ｜ Kronos-small：{statusData?.kronosModels?.small?.installed ? '已安裝' : '未安裝'} ｜ Kronos-base：{statusData?.kronosModels?.base?.installed ? '已安裝' : '未安裝'}。
          </p>
          {selectedKronosModel === 'chronos2' && !statusData?.chronos2?.installed && (
            <div>
              <button
                type="button"
                className="mr-secondary-btn"
                disabled={triggeringRetrain || isChronosTraining}
                onClick={() => void handleTriggerChronosRetrain()}
              >
                <RefreshCw size={14} className={isChronosTraining ? 'spinning' : ''} />
                <span>{isChronosTraining ? '正在背景執行本機 GPU 微調...' : '立即於本機 GPU 訓練 Chronos-2 LoRA'}</span>
              </button>
            </div>
          )}
        </section>
      )}

      {panelState === 'EMPTY' && (
        <section className="mr-card" role="status">
          <h3>尚無研究推論紀錄 (EMPTY)</h3>
          <p className="mr-note">
            環境與模型已就緒。系統將於每小時整點自動更新，或點擊右上角「立即更新並推論」以產生最新決策小時的 LightGBM 多空 Top 5 排名與所選模型未來 4 小時預測。
          </p>
        </section>
      )}

      {panelState === 'INSUFFICIENT_DATA' && (
        <section className="mr-card" role="alert">
          <h3>合格標的資料不足 (INSUFFICIENT_DATA)</h3>
          <p className="mr-note">
            {latestResult?.reason || '該決策時間點合格標的少於 10 檔，依研究規則略過排名。'}
          </p>
          {latestResult?.dataset?.insufficientSymbols && latestResult.dataset.insufficientSymbols.length > 0 && (
            <ul className="mr-warnings-list">
              {latestResult.dataset.insufficientSymbols.map((item) => (
                <li key={item.symbol}>
                  <strong>{item.symbol}</strong>：{item.reason || item.reasons?.join('；')}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Metadata Strip when latestResult is available */}
      {statusData?.artifactWarnings?.map(warning => (
        <div className="mr-banner expired-banner" role="alert" key={warning}>{warning}</div>
      ))}
      {latestResult && (
        <section className="mr-meta-strip">
          <div className="mr-meta-card">
            <span>Run ID / 模型版本</span>
            <strong>
              {latestResult.runId} ({latestResult.kronosModel})
            </strong>
          </div>
          <div className="mr-meta-card">
            <span>資料截止時間 (已收盤 1h K)</span>
            <strong>{formatUtcAndTaipei(latestResult.cutoffTime)}</strong>
          </div>
          <div className="mr-meta-card">
            <span>結果有效期限 (下一小時截止點)</span>
            <strong>{formatUtcAndTaipei(latestResult.expiresAt)}</strong>
          </div>
          <div className="mr-meta-card">
            <span>合格排名標的數 / 衝突數</span>
            <strong>
              {latestResult.dataset?.eligibleCount ?? 0} 幣（衝突 {latestResult.rankings.conflictSymbols.length} 幣）
            </strong>
          </div>
          <div className="mr-meta-card">
            <span>時序模型推論耗時 / 峰值顯存</span>
            <strong>
              {latestResult.models?.kronos?.totalElapsedMs ?? '--'} ms /{' '}
              {latestResult.models?.kronos?.peakVramAllocatedMb ?? '--'} MiB
            </strong>
          </div>
        </section>
      )}

      {/* Section 1: LightGBM Long Top 5 & Short Top 5 Ranking Tables */}
      {latestResult && latestResult.rankings && (
        <div className="mr-grid-2col">
          {/* Long Top 5 */}
          <section className="mr-card">
            <div className="mr-card-header">
              <h3>
                <TrendingUp size={17} color="#10b981" />
                <span>LightGBM 做多候選排名 Top 5 (Long Ranker)</span>
              </h3>
              <span className="mr-note">標籤：下一根 1h 開盤做多持有 4h 扣成本淨報酬分級 (0~4)</span>
            </div>
            <div className="mr-note">
              ⚠️ 「排名分數」僅代表同一決策小時內之相對排序高低，<strong>不得解釋為勝率或預期報酬率</strong>。點擊標的切換下方模型預測圖。
            </div>
            <div className="mr-table-wrapper">
              <table className="mr-table">
                <thead>
                  <tr>
                    <th>名次</th>
                    <th>標的</th>
                    <th>排名分數</th>
                    <th>收盤價</th>
                    <th>1h / 4h / 24h 報酬</th>
                    <th>大週期趨勢 (4h / 24h)</th>
                    <th>資金費 Z-Score (7d)</th>
                    <th>RSI(14)</th>
                    <th>空頭榜名次</th>
                  </tr>
                </thead>
                <tbody>
                  {latestResult.rankings.longTop5.map((row: ResearchRankingEntry) => {
                    const hasKronos = Boolean(latestResult.forecasts?.[row.symbol]);
                    return (
                      <tr
                        key={`long-${row.symbol}`}
                        className={`clickable-row ${focusSymbol === row.symbol ? 'selected-row' : ''}`}
                        onClick={() => {
                          setFocusSymbol(row.symbol);
                          onSelectSymbol?.(row.symbol);
                        }}
                      >
                        <td>#{row.rank}</td>
                        <td>
                          <strong>{row.symbol}</strong>
                          {row.conflict && <span className="mr-conflict-tag">多空排名衝突</span>}
                          {hasKronos && <span className="mr-kronos-tag">預測 Top3</span>}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700, color: '#10b981' }}>
                          {row.rankingScore.toFixed(4)}
                        </td>
                        <td>${formatCryptoPrice(row.closePrice)}</td>
                        <td>
                          {formatPct(row.ret1h)} / {formatPct(row.ret4h)} / {formatPct(row.ret24h)}
                        </td>
                        <td>
                          {formatPct(row.trend4hSma6Dist)} / {formatPct(row.trend24hSma4Dist)}
                        </td>
                        <td style={{ fontFamily: 'monospace' }}>
                          {row.fundingRateZScore7d !== undefined && Number.isFinite(row.fundingRateZScore7d)
                            ? `${row.fundingRateZScore7d >= 0 ? '+' : ''}${row.fundingRateZScore7d.toFixed(2)}`
                            : '--'}
                        </td>
                        <td>{row.rsi14.toFixed(1)}</td>
                        <td>#{row.shortRank}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Short Top 5 */}
          <section className="mr-card">
            <div className="mr-card-header">
              <h3>
                <TrendingDown size={17} color="#ef4444" />
                <span>LightGBM 做空候選排名 Top 5 (Short Ranker)</span>
              </h3>
              <span className="mr-note">標籤：下一根 1h 開盤做空持有 4h 扣成本淨報酬分級 (0~4)</span>
            </div>
            <div className="mr-note">
              ⚠️ 兩榜分別獨立訓練，若同一標的同時進入多空 Top 5 會明確標示「多空排名衝突」（通常發生於高波動分歧標的）。
            </div>
            <div className="mr-table-wrapper">
              <table className="mr-table">
                <thead>
                  <tr>
                    <th>名次</th>
                    <th>標的</th>
                    <th>排名分數</th>
                    <th>收盤價</th>
                    <th>1h / 4h / 24h 報酬</th>
                    <th>大週期趨勢 (4h / 24h)</th>
                    <th>資金費 Z-Score (7d)</th>
                    <th>RSI(14)</th>
                    <th>多頭榜名次</th>
                  </tr>
                </thead>
                <tbody>
                  {latestResult.rankings.shortTop5.map((row: ResearchRankingEntry) => {
                    const hasKronos = Boolean(latestResult.forecasts?.[row.symbol]);
                    return (
                      <tr
                        key={`short-${row.symbol}`}
                        className={`clickable-row ${focusSymbol === row.symbol ? 'selected-row' : ''}`}
                        onClick={() => {
                          setFocusSymbol(row.symbol);
                          onSelectSymbol?.(row.symbol);
                        }}
                      >
                        <td>#{row.rank}</td>
                        <td>
                          <strong>{row.symbol}</strong>
                          {row.conflict && <span className="mr-conflict-tag">多空排名衝突</span>}
                          {hasKronos && <span className="mr-kronos-tag">預測 Top3</span>}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontWeight: 700, color: '#ef4444' }}>
                          {row.rankingScore.toFixed(4)}
                        </td>
                        <td>${formatCryptoPrice(row.closePrice)}</td>
                        <td>
                          {formatPct(row.ret1h)} / {formatPct(row.ret4h)} / {formatPct(row.ret24h)}
                        </td>
                        <td>
                          {formatPct(row.trend4hSma6Dist)} / {formatPct(row.trend24hSma4Dist)}
                        </td>
                        <td style={{ fontFamily: 'monospace' }}>
                          {row.fundingRateZScore7d !== undefined && Number.isFinite(row.fundingRateZScore7d)
                            ? `${row.fundingRateZScore7d >= 0 ? '+' : ''}${row.fundingRateZScore7d.toFixed(2)}`
                            : '--'}
                        </td>
                        <td>{row.rsi14.toFixed(1)}</td>
                        <td>#{row.longRank}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* Section 2: Selected Symbol Historical Klines & Kronos 4h Forecast Path */}
      {latestResult && forecastSymbols.length > 0 && (
        <section className="mr-card">
          <div className="mr-card-header">
            <h3>
              <Activity size={17} color="#60a5fa" />
              <span>
                {latestResult.kronosModel === 'chronos2' ? 'Chronos-2 微調版：未來 4 小時收盤價路徑' : `Kronos-${latestResult.kronosModel}：未來 4 小時 K 線預測路徑`}
              </span>
            </h3>
            <div className="mr-symbol-tabs" role="tablist" aria-label="模型推論候選標的">
              {forecastSymbols.map((sym) => (
                <button
                  key={sym}
                  type="button"
                  role="tab"
                  aria-selected={focusSymbol === sym}
                  className={`mr-symbol-tab ${focusSymbol === sym ? 'active' : ''}`}
                  onClick={() => {
                    setFocusSymbol(sym);
                    onSelectSymbol?.(sym);
                  }}
                >
                  {sym}
                </button>
              ))}
            </div>
          </div>

          {selectedForecast ? (
            <>
              <div className="mr-note">
                標的：<strong>{selectedForecast.symbol}</strong> ｜ 模型：<code>{selectedForecast.repoId}</code> (revision:{' '}
                <code>{selectedForecast.revision.slice(0, 12)}</code>) ｜ 截止收盤價：
                <strong>${formatCryptoPrice(selectedForecast.lastClosePrice)}</strong> ｜ 預測第 4 根收盤價：
                <strong>${formatCryptoPrice(selectedForecast.predictedClose4h)}</strong>（
                <strong>{formatPct(selectedForecast.predictedReturn4h, 3)}</strong>）｜ 單幣耗時：
                <strong>{selectedForecast.elapsedMs} ms</strong> ｜ 峰值顯存：
                <strong>{selectedForecast.peakVramAllocatedMb} MiB</strong>（保留 {selectedForecast.peakVramReservedMb} MiB）
              </div>
              {selectedForecast.forecastType === 'close' ? (
                <>
                  <div className="mr-note">{selectedForecast.dispersionDisclaimer} 輸入連續 256 根已收盤 1h 收盤價。</div>
                  <ChronosCloseChart forecast={selectedForecast} />
                  <table className="mr-table"><thead><tr><th>步數</th><th>預測收盤時間（UTC）</th><th>收盤價中位數預測</th><th>相較截止收盤價</th></tr></thead>
                    <tbody>{selectedForecast.predictedCloses?.map(c => <tr key={c.step}>
                      <td>+{c.step}h</td><td>{new Date(c.closeTime + 1).toISOString().slice(0,16).replace('T',' ')}</td>
                      <td>${formatCryptoPrice(c.close)}</td><td>{formatPct(c.close / selectedForecast.lastClosePrice - 1, 3)}</td>
                    </tr>)}</tbody></table>
                </>
              ) : (<>
              <div className="mr-note">
                📌 <strong>抽樣離散程度聲明：</strong>圖中藍色陰影與下表範圍為固定{' '}
                <code>batch=1, sample_count=5, seed=42, T=1.0, top_p=0.9</code> 下之{' '}
                <strong>抽樣離散程度（Sample Dispersion）</strong>，僅顯示平均預測路徑與 5 次抽樣落點範圍，
                <strong>不得稱為校準信賴區間（Calibrated Confidence Interval）</strong>。
              </div>

              <KronosForecastSvgChart forecast={selectedForecast} />

              <div className="mr-table-wrapper">
                <table className="mr-table">
                  <thead>
                    <tr>
                      <th>預測步數</th>
                      <th>時間區間 (UTC)</th>
                      <th>平均預測 Open</th>
                      <th>平均預測 High</th>
                      <th>平均預測 Low</th>
                      <th>平均預測 Close</th>
                      <th>相較截止收盤漲跌</th>
                      <th>抽樣離散程度 (5 次抽樣 Close Min ~ Max / Std)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedForecast.predictedCandles.map((c) => {
                      const stepRet = (c.close - selectedForecast.lastClosePrice) / selectedForecast.lastClosePrice;
                      return (
                        <tr key={c.openTime}>
                          <td>
                            <strong>+{c.step}h</strong>
                          </td>
                          <td>{new Date(c.openTime).toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
                          <td>${formatCryptoPrice(c.open)}</td>
                          <td>${formatCryptoPrice(c.high)}</td>
                          <td>${formatCryptoPrice(c.low)}</td>
                          <td>
                            <strong>${formatCryptoPrice(c.close)}</strong>
                          </td>
                          <td style={{ color: stepRet >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                            {formatPct(stepRet, 3)}
                          </td>
                          <td>
                            {c.sampleDispersion
                              ? `$${formatCryptoPrice(c.sampleDispersion.closeMin)} ~ $${formatCryptoPrice(c.sampleDispersion.closeMax)} (Std: ${formatCryptoPrice(c.sampleDispersion.closeStd)})`
                              : '--'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>)}
            </>
          ) : (
            <div className="mr-note">
              目前選取標的（{focusSymbol}）不在本次多空各 Top 3 去重候選清單（{forecastSymbols.join(', ')}）內；請點擊上方候選標籤檢視模型預測。
            </div>
          )}
        </section>
      )}

      {/* Section 3: Offline Comparison Report (Kronos-small vs Kronos-base vs LightGBM vs Baselines) */}
      {offlineComp && (
        <section className="mr-card">
          <div className="mr-card-header">
            <h3>
              <BarChart3 size={17} color="#a78bfa" />
              <span>離線公平比較報告（測試集 30 天每日 UTC 00:00 共同有效時點）</span>
            </h3>
            <span className="mr-note">
              GPU：{offlineComp.gpuEnvironment?.gpuName || statusData?.gpuEnvironment?.gpuName || 'RTX 4050'}（總顯存{' '}
              {offlineComp.gpuEnvironment?.totalVramMb || statusData?.gpuEnvironment?.totalVramMb || 6141} MiB）
            </span>
          </div>

          <div className="mr-note">
            ⚖️ <strong>公平比較與評估規則：</strong>
            成本假設為 1 倍槓桿、單邊手續費 5 bps + 單邊不利滑價 5 bps（來回 20 bps），資金費按持有 4 小時期間實際結算及多空方向計算（缺資金費樣本不當作零成本，直接排除並另報比例）。
            LightGBM 排名分數不計算報酬 MAE；第一版不產生模擬帳戶淨值曲線，避免將重疊 4 小時研究樣本誤當成可累加交易績效。
          </div>

          {/* 3A. Kronos 4th-bar Close Return MAE & Hardware Comparison */}
          {offlineComp.kronosForecastComparison && (
            <div className="mr-table-wrapper">
              <table className="mr-table">
                <thead>
                  <tr>
                    <th>預測模型／基準</th>
                    <th>共同樣本數</th>
                    <th>未來第 4 根收盤報酬 MAE ↓</th>
                    <th>方向命中率 ↑</th>
                    <th>總推論耗時 (ms)</th>
                    <th>單筆平均耗時 (ms)</th>
                    <th>峰值分配顯存 (MiB)</th>
                    <th>峰值保留顯存 (MiB)</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      label: 'Kronos-small (24.7M)',
                      m: offlineComp.kronosForecastComparison.kronosSmall,
                      count: offlineComp.kronosForecastComparison.samplePairCount,
                    },
                    {
                      label: 'Kronos-base (102.3M)',
                      m: offlineComp.kronosForecastComparison.kronosBase,
                      count: offlineComp.kronosForecastComparison.samplePairCount,
                    },
                    {
                      label: '價格不變基準 (0 報酬)',
                      m: offlineComp.kronosForecastComparison.baselineNoChange as any,
                      count: offlineComp.kronosForecastComparison.samplePairCount,
                    },
                    {
                      label: '過去 4 小時動能基準',
                      m: offlineComp.kronosForecastComparison.baselineMomentum4h as any,
                      count: offlineComp.kronosForecastComparison.samplePairCount,
                    },
                  ].map((item) => (
                    <tr key={item.label}>
                      <td>
                        <strong>{item.label}</strong>
                      </td>
                      <td>{item.count}</td>
                      <td>{item.m ? (item.m.mae4hReturn * 100).toFixed(4) + '%' : '--'}</td>
                      <td>{item.m ? (item.m.directionalHitRate * 100).toFixed(2) + '%' : '--'}</td>
                      <td>{item.m?.totalElapsedMs !== undefined ? item.m.totalElapsedMs.toFixed(0) : '-'}</td>
                      <td>{item.m?.avgSampleElapsedMs !== undefined ? item.m.avgSampleElapsedMs.toFixed(1) : '-'}</td>
                      <td>{item.m?.peakVramAllocatedMb !== undefined ? item.m.peakVramAllocatedMb.toFixed(2) : '-'}</td>
                      <td>{item.m?.peakVramReservedMb !== undefined ? item.m.peakVramReservedMb.toFixed(2) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 3B. Cross-Model Same-Time Same-Symbol Ranking Comparison */}
          {offlineComp.crossModelRankingComparison && (
            <div className="mr-table-wrapper">
              <table className="mr-table">
                <thead>
                  <tr>
                    <th>跨模型同時間同標的排名比較</th>
                    <th>共同時點數</th>
                    <th>未來 4h 收盤 Spearman IC</th>
                    <th>多頭 NDCG@5</th>
                    <th>多頭 Top 5 平均淨報酬</th>
                    <th>多頭 Top 5 正淨報酬率</th>
                    <th>空頭 NDCG@5</th>
                    <th>空頭 Top 5 平均淨報酬</th>
                    <th>空頭 Top 5 正淨報酬率</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'LightGBM Ranker (CPU)', r: offlineComp.crossModelRankingComparison.lightgbm },
                    { label: 'Kronos-small (GPU)', r: offlineComp.crossModelRankingComparison.kronosSmall },
                    { label: 'Kronos-base (GPU)', r: offlineComp.crossModelRankingComparison.kronosBase },
                    { label: '過去 4h 動能基準', r: offlineComp.crossModelRankingComparison.baselineMomentum4h },
                  ].map(({ label, r }) => (
                    <tr key={label}>
                      <td>
                        <strong>{label}</strong>
                      </td>
                      <td>{r.groupCount}</td>
                      <td>{r.spearmanIcClose4h.toFixed(4)}</td>
                      <td>{r.long.ndcgAt5NetReturn.toFixed(4)}</td>
                      <td>{formatPct(r.long.top5MeanNetReturn, 3)}</td>
                      <td>{(r.long.top5PositiveNetRate * 100).toFixed(2)}%</td>
                      <td>{r.short.ndcgAt5NetReturn.toFixed(4)}</td>
                      <td>{formatPct(r.short.top5MeanNetReturn, 3)}</td>
                      <td>{(r.short.top5PositiveNetRate * 100).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Section 4: Data Quality, Insufficient Symbols & Research Disclaimers */}
      <section className="mr-card">
        <div className="mr-card-header">
          <h3>
            <Layers size={16} color="#94a3b8" />
            <span>資料品質、缺口紀錄與研究限制聲明</span>
          </h3>
          {statusData?.datasetVersion && (
            <span className="mr-note">資料版本：{statusData.datasetVersion}</span>
          )}
        </div>

        <ul className="mr-warnings-list">
          {latestResult?.warnings?.map((warning, index) => <li key={`run-warning-${index}`}>{warning}</li>)}
          <li>
            <strong>存活與選擇偏差：</strong>
            本試驗以準備資料當下可交易之 Binance USDT 永續合約按 24h 成交額選取最多 20 幣，屬於「目前可交易幣種的歷史試驗」，存在存活與選擇偏差，不得稱為歷史全市場驗證。
          </li>
          <li>
            <strong>Kronos 預訓練重疊未知：</strong>
            Kronos 官方預訓練權重之訓練期間與標的可能與本研究期間重疊，不宣稱是完全獨立的樣本外驗證。
          </li>
          <li>
            <strong>不自動升級為交易訊號：</strong>
            本面板所有模型分數與預測僅供研究比較，即使部分指標未優於基準亦如實呈現，不接入下單、模擬帳戶或 A/B 自動交易。
          </li>
          {(latestResult?.dataset?.insufficientSymbols?.length
            ? latestResult.dataset.insufficientSymbols
            : statusData?.insufficientSymbols ?? []
          ).map((item) => (
            <li key={`insuf-${item.symbol}`}>
              <strong>資料缺口／不足標的 ({item.symbol})：</strong>
              {item.reason || item.reasons?.join('；')}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
