import React, { useState, useEffect, useCallback } from 'react';
import {
  BrainCircuit,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  MinusCircle,
  Clock,
  History,
  Layers,
  Activity,
} from 'lucide-react';
import type { MarketType, CoinMetadata } from '../services/binance';
import { collectorClient } from '../api/collectorClient';
import type { AIAnalysisResult, AIDataSnapshot } from '@fadachi/core';
import './AIAnalysisCenter.css';

export interface AIAnalysisCenterProps {
  marketType: MarketType;
  theme: 'dark' | 'light';
  coins: CoinMetadata[];
  onSelectSymbol?: (symbol: string) => void;
  selectedSymbol?: string;
}

export default function AIAnalysisCenter({
  marketType,
  theme: _theme,
  coins,
  onSelectSymbol,
  selectedSymbol: propSymbol,
}: AIAnalysisCenterProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string>(propSymbol || 'BTCUSDT');
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<{
    market: MarketType;
    quota: {
      dailyCallsUsed: number;
      dailyCallsLimit: number;
      cooldownRemainingSeconds: number;
      eventTriggersInLastHour: number;
      maxEventTriggersPerHour: number;
      isBusy: boolean;
      hasPending: boolean;
    };
    models: string[];
    isolationVerified: boolean;
    isolationReason?: string;
    trackedSymbols: string[];
    scope?: { symbols: string[]; market: MarketType; model: string; locked: boolean };
    latestAnalyses: Record<string, AIAnalysisResult>;
  } | null>(null);

  const [history, setHistory] = useState<AIAnalysisResult[]>([]);
  const [activeSnapshot, setActiveSnapshot] = useState<AIDataSnapshot | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (propSymbol) setSelectedSymbol(propSymbol);
  }, [propSymbol]);

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await collectorClient.getAIStatus(marketType);
      setStatusData(res);
      setError(null);
    } catch (err: any) {
      setError(`無法取得 AI 狀態：${err.message || '連線失敗'}`);
    } finally {
      setLoading(false);
    }
  }, [marketType]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 15000); // 15s refresh
    return () => clearInterval(interval);
  }, [loadStatus]);

  // Load history when selectedSymbol changes
  useEffect(() => {
    let active = true;
    void collectorClient.getAIHistory(selectedSymbol, marketType, 20).then(res => {
      if (active) setHistory(res);
    }).catch(() => {});
    return () => { active = false; };
  }, [selectedSymbol, marketType]);

  const handleTrigger = async () => {
    try {
      setTriggering(true);
      setError(null);
      const model = statusData?.models?.[0];
      if (!model) throw new Error(statusData?.isolationReason || '隔離 profile 尚無可用模型，請先登入');
      const res = await collectorClient.triggerAIAnalysis({
        symbol: selectedSymbol,
        market: marketType,
        model,
      });
      if (res?.snapshot) setActiveSnapshot(res.snapshot);
      await loadStatus();
      const updatedHistory = await collectorClient.getAIHistory(selectedSymbol, marketType, 20);
      setHistory(updatedHistory);
    } catch (err: any) {
      setError(err.message || 'AI 分析觸發失敗');
    } finally {
      setTriggering(false);
    }
  };

  const marketStatus = statusData?.market === marketType ? statusData : null;
  const visibleHistory = history.filter(item => item.symbol === selectedSymbol && item.marketType === marketType);
  const currentAnalysis = marketStatus?.latestAnalyses?.[selectedSymbol] || visibleHistory[0];
  const snapshot = activeSnapshot?.id === currentAnalysis?.snapshotId
    && activeSnapshot?.marketType === marketType && activeSnapshot?.symbol === selectedSymbol ? activeSnapshot : null;
  useEffect(() => {
    let active = true;
    if (currentAnalysis?.snapshotId) {
      void collectorClient.getAISnapshot(currentAnalysis.snapshotId).then(result => {
        if (active) setActiveSnapshot(result);
      }).catch(() => { if (active) setActiveSnapshot(null); });
    }
    return () => { active = false; };
  }, [currentAnalysis?.snapshotId]);
  const canTrigger = Boolean(marketStatus?.isolationVerified && marketStatus.models.length)
    && (marketStatus?.quota.dailyCallsUsed ?? 144) < (marketStatus?.quota.dailyCallsLimit ?? 144) && !triggering;
  const isExpired = currentAnalysis ? Date.now() > currentAnalysis.expiresAt : false;
  const expiryMinutesRemaining = currentAnalysis
    ? Math.max(0, Math.ceil((currentAnalysis.expiresAt - Date.now()) / 60000))
    : 0;

  const trackedSymbols = marketStatus?.trackedSymbols?.length
    ? marketStatus.trackedSymbols
    : marketStatus?.scope?.symbols ?? [];

  return (
    <div className="ai-center-container">
      {/* Top Status & Quota Bar */}
      <header className="ai-center-header">
        <div className="ai-header-title">
          <BrainCircuit size={22} className="ai-icon-pulse" />
          <div>
            <h2>AI 分析中心</h2>
            <span className="ai-subtitle">多來源客觀市場分析・嚴格權限隔離・雙帳戶對照依據</span>
          </div>
        </div>

        <div className="ai-header-controls">
          <div className="ai-quota-badge">
            <span className="ai-quota-label">呼叫額度</span>
            <span className="ai-quota-value">
              {statusData?.quota?.dailyCallsUsed ?? 0} / {statusData?.quota?.dailyCallsLimit ?? 144} 次
            </span>
          </div>

          <div className="ai-cooldown-badge">
            <Clock size={14} />
            <span>
              {statusData?.quota?.cooldownRemainingSeconds
                ? `冷卻 ${statusData.quota.cooldownRemainingSeconds}s`
                : '冷卻完畢'}
            </span>
          </div>

          <div className={`ai-isolation-tag ${statusData?.isolationVerified ? 'verified' : 'unverified'}`}>
            {statusData?.isolationVerified ? (
              <>
                <ShieldCheck size={14} />
                <span>CLI 沙盒隔離已驗證</span>
              </>
            ) : (
              <>
                <ShieldAlert size={14} />
                <span>隔離未驗證</span>
              </>
            )}
          </div>
          {!statusData?.isolationVerified && statusData?.isolationReason && (
            <span className="ai-isolation-reason">{statusData.isolationReason}</span>
          )}

          <button
            className="ai-refresh-btn"
            onClick={loadStatus}
            disabled={loading}
            title="重新整理狀態"
          >
            <RefreshCw size={15} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </header>

      {error && (
        <div className="ai-notice-error" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Main Two-Column Layout */}
      <div className="ai-center-content">
        {/* Left Column: Tracked Coins List */}
        <aside className="ai-symbols-sidebar">
          <div className="ai-sidebar-header">
            <Layers size={16} />
            <span>追蹤幣種清單（上限 10 個）</span>
          </div>

          <ul className="ai-symbols-list">
            {trackedSymbols.map((sym) => {
              const analysis = marketStatus?.latestAnalyses?.[sym];
              const coin = coins.find(c => c.symbol === sym);
              const isSelected = sym === selectedSymbol;
              const expired = analysis ? Date.now() > analysis.expiresAt : false;

              return (
                <li
                  key={sym}
                  className={`ai-symbol-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedSymbol(sym);
                    onSelectSymbol?.(sym);
                  }}
                >
                  <div className="ai-symbol-info">
                    <span className="ai-symbol-name">{sym.replace('USDT', '')}</span>
                    <span className="ai-symbol-fullname">{coin?.name || 'USDT 永續'}</span>
                  </div>

                  <div className="ai-symbol-state">
                    {analysis ? (
                      <span
                        className={`ai-dir-pill ${analysis.direction.toLowerCase()} ${expired ? 'expired' : ''}`}
                      >
                        {expired
                          ? '已過期'
                          : analysis.direction === 'LONG'
                          ? '多'
                          : analysis.direction === 'SHORT'
                          ? '空'
                          : '觀望'}
                      </span>
                    ) : (
                      <span className="ai-dir-pill none">未分析</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Right Column: Active Coin Analysis Detail */}
        <main className="ai-detail-main">
          <div className="ai-detail-card">
            {/* Detail Card Header */}
            <div className="ai-card-header">
              <div className="ai-card-title">
                <h3>{selectedSymbol} 市場綜合分析</h3>
                <span className="ai-model-tag">
                  {currentAnalysis?.model || statusData?.models?.[0] || '尚無可用模型'}
                </span>
              </div>

              <div className="ai-card-actions">
                <button
                  className="ai-trigger-btn"
                  onClick={handleTrigger}
                  disabled={!canTrigger}
                >
                  <RefreshCw size={14} className={triggering ? 'spinning' : ''} />
                  <span>
                    {triggering
                      ? '分析中...'
                      : !marketStatus?.isolationVerified
                      ? 'Provider 已停用'
                      : '立即重新分析'}
                  </span>
                </button>

                <button
                  className={`ai-history-toggle-btn ${showHistory ? 'active' : ''}`}
                  onClick={() => setShowHistory(prev => !prev)}
                >
                  <History size={15} />
                  <span>歷史紀錄 ({visibleHistory.length})</span>
                </button>
              </div>
            </div>

            {/* Analysis Result Display */}
            {currentAnalysis ? (
              <div className="ai-analysis-body">
                {/* Direction & Validity Banner */}
                <div className={`ai-direction-banner ${currentAnalysis.direction.toLowerCase()}`}>
                  <div className="ai-dir-icon">
                    {currentAnalysis.direction === 'LONG' ? (
                      <TrendingUp size={36} />
                    ) : currentAnalysis.direction === 'SHORT' ? (
                      <TrendingDown size={36} />
                    ) : (
                      <MinusCircle size={36} />
                    )}
                  </div>
                  <div className="ai-dir-details">
                    <div className="ai-dir-headline">
                      <span className="ai-dir-text">
                        {currentAnalysis.direction === 'LONG'
                          ? 'AI 許可方向：偏多（LONG）'
                          : currentAnalysis.direction === 'SHORT'
                          ? 'AI 許可方向：偏空（SHORT）'
                          : 'AI 建議方向：觀望（NEUTRAL）'}
                      </span>
                      <span className="ai-confidence">信心度 {currentAnalysis.confidence}%</span>
                    </div>

                    <div className="ai-validity-meta">
                      <span>
                        分析時間：{new Date(currentAnalysis.generatedAt).toLocaleTimeString('zh-TW')}
                      </span>
                      <span>・</span>
                      <span className={isExpired ? 'ai-text-expired' : 'ai-text-valid'}>
                        {isExpired
                          ? '已過期（需重新分析以供 B 帳戶進場）'
                          : `有效期剩餘約 ${expiryMinutesRemaining} 分鐘`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Reasoning summary */}
                <div className="ai-section">
                  <h4 className="ai-section-title">核心邏輯摘要</h4>
                  <p className="ai-reasoning-text">{currentAnalysis.reasoning}</p>
                </div>

                {/* Bullish & Bearish Evidence Grid */}
                <div className="ai-evidence-grid">
                  <div className="ai-evidence-col bullish">
                    <div className="ai-col-header">
                      <TrendingUp size={16} />
                      <span>多方佐證 ({currentAnalysis.bullishEvidence.length})</span>
                    </div>
                    {currentAnalysis.bullishEvidence.length > 0 ? (
                      <ul className="ai-evidence-list">
                        {currentAnalysis.bullishEvidence.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="ai-empty-text">無顯著多方依據</p>
                    )}
                  </div>

                  <div className="ai-evidence-col bearish">
                    <div className="ai-col-header">
                      <TrendingDown size={16} />
                      <span>空方佐證 ({currentAnalysis.bearishEvidence.length})</span>
                    </div>
                    {currentAnalysis.bearishEvidence.length > 0 ? (
                      <ul className="ai-evidence-list">
                        {currentAnalysis.bearishEvidence.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="ai-empty-text">無顯著空方依據</p>
                    )}
                  </div>
                </div>

                {/* Risks & Disclosures */}
                <div className="ai-section risks">
                  <h4 className="ai-section-title">
                    <AlertTriangle size={15} />
                    <span>風險提示與資料缺漏揭露</span>
                  </h4>
                  {currentAnalysis.risks.length > 0 ? (
                    <ul className="ai-risks-list">
                      {currentAnalysis.risks.map((risk, idx) => (
                        <li key={idx}>{risk}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="ai-empty-text">無特定風險警示</p>
                  )}
                  {currentAnalysis.missingData.length > 0 && (
                    <div className="ai-missing-disclosures">
                      <span className="ai-disclosure-badge">
                        缺漏降級：{currentAnalysis.missingData.join(', ')}
                      </span>
                      <span className="ai-disclosure-note">
                        依計畫規定，非必要資料缺失時降級分析，不冒充完整全市場覆蓋。
                      </span>
                    </div>
                  )}
                </div>

                {/* Data Pipeline Health */}
                <div className="ai-section pipeline">
                  <h4 className="ai-section-title">
                    <Activity size={15} />
                    <span>資料來源健康與透明度</span>
                  </h4>
                  <div className="ai-pipeline-grid">
                    {([
                      ['market', 'Binance 行情'], ['klines', '已收盤 K 線'], ['indicators', '技術指標'],
                      ['openInterest', 'Binance 未平倉合約 (OI)'], ['fundingRate', 'Binance 資金費率'],
                      ['liquidations', '清算觀測樣本'], ['news', 'RSS 新聞'], ['onChain', '鏈上日度統計'],
                    ] as const).map(([key, label]) => (
                      <div className="ai-pipeline-item" key={key}>
                        <span className="pipeline-name">{label}</span>
                        <span className={`pipeline-status ${snapshot?.sources[key] ? 'ok' : 'notice'}`}>
                          {snapshot ? (snapshot.sources[key] ? '快照有資料' : '缺漏／不適用') : '尚未取得快照'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="ai-legal-disclaimer">
                    {snapshot && <p>快照截止：{new Date(snapshot.cutoffTime).toLocaleString('zh-TW')}・行情資料：{snapshot.market.priceTimestamp ? new Date(snapshot.market.priceTimestamp).toLocaleString('zh-TW') : '時間未提供'}</p>}
                    {snapshot?.news.filter(item => /^https?:\/\//i.test(item.link)).map(item => (
                      <p key={item.id}><a href={item.link} target="_blank" rel="noopener noreferrer">{item.source}：{item.title}</a></p>
                    ))}
                    備註：清算僅代表本系統實際觀測紀錄，非全市場總量；鏈上指標為社群版日度資料，非即時大單資金流。
                  </div>
                </div>
              </div>
            ) : (
              <div className="ai-empty-state">
                <BrainCircuit size={48} />
                <p>目前尚無 {selectedSymbol} 的分析快照</p>
                <button className="ai-trigger-btn primary" onClick={handleTrigger} disabled={!canTrigger}>
                  {triggering ? '正在產生首次分析...' : !marketStatus?.isolationVerified ? 'Provider 已停用' : '立即取得首次分析'}
                </button>
              </div>
            )}
          </div>

          {/* History Drawer */}
          {showHistory && (
            <div className="ai-history-drawer">
              <div className="ai-history-header">
                <h4>{selectedSymbol} 歷史分析紀錄</h4>
                <button className="ai-close-btn" onClick={() => setShowHistory(false)}>關閉</button>
              </div>

              {visibleHistory.length > 0 ? (
                <ul className="ai-history-list">
                  {visibleHistory.map((h) => (
                    <li key={h.id} className="ai-history-item">
                      <div className="ai-hist-top">
                        <span className={`ai-dir-pill small ${h.direction.toLowerCase()}`}>
                          {h.direction}
                        </span>
                        <span className="ai-hist-time">
                          {new Date(h.generatedAt).toLocaleString('zh-TW')}
                        </span>
                        <span className="ai-hist-conf">信心 {h.confidence}%</span>
                      </div>
                      <p className="ai-hist-reason">{h.reasoning}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ai-empty-history">查無此幣種的歷史分析</p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
