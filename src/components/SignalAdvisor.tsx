import { useState } from 'react';
import { Compass, TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { deriveSuggestedTradeLevels } from '../services/tradeLevels';
import { formatCryptoPrice } from '../services/utils';

interface SignalAdvisorProps {
  symbol: string;
  currentPrice: number | null;
  indicators: {
    rsi: number | null;
    sma20: number | null;
    ema50: number | null;
    bb: { middle: number; upper: number; lower: number } | null;
    macd: { macd: number; signal: number; histogram: number } | null;
  };
  openInterest?: number | null; // open interest in USD
  onOpenPaperTrade?: (
    symbol: string,
    side?: 'LONG' | 'SHORT',
    price?: number,
    suggestedTp?: number,
    suggestedSl?: number,
    conservativeEntry?: number,
    aggressiveEntry?: number
  ) => void;
  onQuickFollowTrade?: (
    symbol: string,
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    type: 'MARKET' | 'LIMIT',
    takeProfitPrice?: number,
    stopLossPrice?: number
  ) => void;
}

function formatLargeNumber(num: number): string {
  if (num >= 1e9) {
    return `${(num / 1e9).toFixed(2)}B`;
  }
  if (num >= 1e6) {
    return `${(num / 1e6).toFixed(2)}M`;
  }
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function SignalAdvisor({ 
  symbol, 
  currentPrice, 
  indicators, 
  openInterest,
  onOpenPaperTrade,
  onQuickFollowTrade 
}: SignalAdvisorProps) {
  const { rsi, sma20, ema50, bb, macd } = indicators;
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (id: string, value: number) => {
    navigator.clipboard.writeText(value.toString());
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId(null);
    }, 1500);
  };

  if (currentPrice === null || !bb || !macd) {
    return (
      <div className="card" style={{ marginTop: '24px', textAlign: 'center', padding: '40px' }}>
        <div style={{ color: 'var(--text-secondary)' }}>正在計算技術指標並生成交易決策分析...</div>
      </div>
    );
  }

  // 1. Calculate individual indicator signals (-1 for Bearish, 0 for Neutral, 1 for Bullish)
  let rsiScore = 0;
  let rsiSignal = '中性';
  if (rsi !== null) {
    if (rsi <= 35) {
      rsiScore = 1;
      rsiSignal = '超賣 (看多)';
    } else if (rsi >= 65) {
      rsiScore = -1;
      rsiSignal = '超買 (看空)';
    } else {
      rsiSignal = '中性整理';
    }
  }

  let macdScore = 0;
  let macdSignal = '中性';
  if (macd.macd > macd.signal) {
    macdScore = 1;
    macdSignal = '黃金交叉 (看多)';
  } else if (macd.macd < macd.signal) {
    macdScore = -1;
    macdSignal = '死亡交叉 (看空)';
  }

  let bbScore = 0;
  let bbSignal: string;
  const bbRange = bb.upper - bb.lower;
  const bbPosition = bbRange > 0 ? (currentPrice - bb.lower) / bbRange : 0.5;
  if (bbPosition <= 0.2) {
    bbScore = 1;
    bbSignal = '接近下軌支撐 (看多)';
  } else if (bbPosition >= 0.8) {
    bbScore = -1;
    bbSignal = '接近上軌壓力 (看空)';
  } else {
    bbSignal = '軌道中震盪';
  }

  let trendScore = 0;
  let trendSignal = '盤整';
  if (sma20 !== null && ema50 !== null) {
    if (currentPrice > sma20 && sma20 > ema50) {
      trendScore = 1;
      trendSignal = '多頭排列 (看多)';
    } else if (currentPrice < sma20 && sma20 < ema50) {
      trendScore = -1;
      trendSignal = '空頭排列 (看空)';
    }
  }

  // 2. Compute Weighted Sentiment Score
  const totalScore = (rsiScore * 1.5) + (macdScore * 1.5) + (bbScore * 1.0) + (trendScore * 1.0);

  const signalScores = [rsiScore, macdScore, bbScore, trendScore];
  const bullishVotes = signalScores.filter(score => score > 0).length;
  const bearishVotes = signalScores.filter(score => score < 0).length;
  const isMixedSignal = bullishVotes > 0 && bearishVotes > 0;

  let sentiment = '觀望 / 中性';
  let sentimentColor = '#ffb300'; // Amber
  let sentimentDesc = '市場目前動能方向不夠明確，建議在區間內低買高賣或等待突破信號。';
  let side: 'LONG' | 'SHORT' = 'LONG';

  if (totalScore >= 2.0 && bullishVotes >= 3 && bearishVotes === 0) {
    sentiment = '強力買入';
    sentimentColor = 'var(--trend-up)';
    sentimentDesc = '目前圖表週期內，多數核心指標同向看多，屬於較完整的做多訊號。仍需用更大週期確認方向。';
    side = 'LONG';
  } else if (totalScore >= 0.5 && bullishVotes >= 2) {
    sentiment = isMixedSignal ? '偏多觀察' : '買入';
    sentimentColor = '#a3e635'; // Light green
    sentimentDesc = isMixedSignal
      ? '本週期分數偏多，但仍有反向指標，不適合直接追多；等待回踩或多週期同步後再考慮。'
      : '本週期短線偏多，可把下方入場窗口當成觀察區，而不是立即市價追單。';
    side = 'LONG';
  } else if (totalScore <= -2.0 && bearishVotes >= 3 && bullishVotes === 0) {
    sentiment = '強力賣出';
    sentimentColor = 'var(--trend-down)';
    sentimentDesc = '目前圖表週期內，多數核心指標同向看空，屬於較完整的做空訊號。仍需用更大週期確認方向。';
    side = 'SHORT';
  } else if (totalScore <= -0.5 && bearishVotes >= 2) {
    sentiment = isMixedSignal ? '偏空觀察' : '賣出';
    sentimentColor = '#f87171'; // Light red
    sentimentDesc = isMixedSignal
      ? '本週期分數偏空，但仍有反向指標，不適合直接追空；等待反彈壓力或多週期同步後再考慮。'
      : '本週期短線偏空，可把上方入場窗口當成觀察區，而不是立即市價追空。';
    side = 'SHORT';
  } else if (isMixedSignal) {
    sentiment = '多空混雜';
    sentimentColor = '#ffb300';
    sentimentDesc = '指標方向互相衝突，這種情況不是明確買點或賣點；先觀望，等短週期與大週期方向一致。';
  }

  // 3. Compute Suggested Trading Points based on direction (LONG / SHORT)
  const levels = deriveSuggestedTradeLevels(currentPrice, indicators);
  if (!levels) return null;
  side = levels.side;
  const isLong = levels.side === 'LONG';
  const entryConservative = levels.conservativeEntry;
  const entryAggressive = levels.aggressiveEntry;
  const stopLoss = levels.stopLoss;
  const takeProfit1 = levels.takeProfit1;
  const takeProfit2 = levels.takeProfit2;
  const canQuickFollow = !isMixedSignal && (
    (side === 'LONG' && bullishVotes >= 2 && totalScore >= 0.5) ||
    (side === 'SHORT' && bearishVotes >= 2 && totalScore <= -0.5)
  );

  const coinSymbol = symbol.replace('USDT', '');


  return (
    <div className="card" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <h2 className="card-title" style={{ gap: '8px', margin: 0 }}>
          <Compass size={20} color="var(--accent-primary)" />
          單週期交易訊號與點位分析 ({coinSymbol}/USDT)
        </h2>
        {onOpenPaperTrade && (
          <button 
            className="action-btn"
            style={{ 
              background: 'var(--accent-gradient)', 
              color: 'white', 
              border: 'none', 
              padding: '8px 16px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 4px 12px rgba(124, 77, 255, 0.3)'
            }}
            onClick={() => onOpenPaperTrade(symbol, side, currentPrice, takeProfit1, stopLoss, entryConservative, entryAggressive)}
            title={canQuickFollow ? '依照目前單週期訊號建立模擬單' : '目前訊號未共振，仍可手動開單但不建議直接跟單'}
          >
            <Zap size={14} />
            <span>{canQuickFollow ? '模擬合約交易' : '手動規劃委託'}</span>
          </button>
        )}
      </div>

      {onQuickFollowTrade && (
        <div style={{
          display: 'flex',
          gap: '12px',
          padding: '12px 16px',
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-glass)',
          borderRadius: 'var(--radius-sm)',
          marginBottom: '20px',
          alignItems: 'center',
          flexWrap: 'wrap'
        }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Zap size={14} color="var(--accent-primary)" />
            {canQuickFollow ? '一鍵模擬跟單:' : '訊號未共振:'}
          </span>
          {canQuickFollow ? (
            <>
              <button
                onClick={() => onQuickFollowTrade(symbol, side, currentPrice, 'MARKET', takeProfit1, stopLoss)}
                className="action-btn"
                style={{
                  fontSize: '12px',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  background: side === 'LONG' ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 23, 68, 0.15)',
                  color: side === 'LONG' ? 'var(--trend-up)' : 'var(--trend-down)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                一鍵市價跟單
              </button>
              <button
                onClick={() => onQuickFollowTrade(symbol, side, entryConservative, 'LIMIT', takeProfit1, stopLoss)}
                className="action-btn"
                style={{
                  fontSize: '12px',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  background: 'rgba(0, 229, 255, 0.12)',
                  color: 'var(--accent-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                一鍵保守限價跟單
              </button>
              <button
                onClick={() => onQuickFollowTrade(symbol, side, entryAggressive, 'LIMIT', takeProfit1, stopLoss)}
                className="action-btn"
                style={{
                  fontSize: '12px',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  background: 'rgba(124, 77, 255, 0.12)',
                  color: 'var(--accent-primary)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              >
                一鍵激進限價跟單
              </button>
            </>
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              不建議直接買或賣。先等多週期方向一致，或只把下方點位當作觀察區。
            </span>
          )}
        </div>
      )}

      <div className="advisor-grid-layout" style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '24px',
      }}>
        
        {/* Left Card: Sentiment & OI Velocities */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          <div style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: 'var(--radius-md)',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center'
          }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' }}>
              本圖表週期訊號
            </span>
            <div style={{
              fontSize: '32px',
              fontWeight: 800,
              color: sentimentColor,
              fontFamily: 'var(--font-display)',
              margin: '16px 0',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              {totalScore > 0 ? <TrendingUp size={28} /> : totalScore < 0 ? <TrendingDown size={28} /> : null}
              {sentiment}
            </div>
            
            {/* Visual Gauge Bar */}
            <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', position: 'relative', margin: '12px 0 20px 0' }}>
              <div style={{
                position: 'absolute',
                height: '12px',
                width: '12px',
                borderRadius: '50%',
                background: sentimentColor,
                top: '-3px',
                left: `${((totalScore + 5) / 10) * 100}%`,
                transform: 'translateX(-50%)',
                transition: 'left 0.5s ease-out',
                boxShadow: `0 0 8px ${sentimentColor}`
              }} />
            </div>
            
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
              {sentimentDesc}
            </p>
            <div style={{
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap',
              justifyContent: 'center',
              marginTop: '12px',
              fontSize: '11px',
              color: 'var(--text-secondary)'
            }}>
              <span>看多 {bullishVotes}/4</span>
              <span>看空 {bearishVotes}/4</span>
              <span>{isMixedSignal ? '有衝突' : '無明顯衝突'}</span>
            </div>
          </div>

        </div>

        {/* Right Card: Four Gates and Target Levels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          

          {/* Target Levels Grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '16px'
          }}>
             {/* Entry point 1 */}
            <div 
              className="suggested-level-card"
              style={{ 
                background: isLong ? 'rgba(0, 229, 255, 0.04)' : 'rgba(244, 63, 94, 0.04)', 
                border: isLong ? '1px solid rgba(0, 229, 255, 0.15)' : '1px solid rgba(244, 63, 94, 0.15)', 
                padding: '14px', 
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                transition: 'transform 0.2s, background-color 0.2s'
              }}
              onClick={() => handleCopy('conservative', entryConservative)}
              title="點擊複製價格到剪貼簿"
            >
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{isLong ? '建議做多 (保守 - 下軌)' : '建議做空 (保守 - 上軌)'}</span>
                <span style={{ 
                  fontSize: '9px', 
                  opacity: copiedId === 'conservative' ? 1 : 0.6, 
                  background: copiedId === 'conservative' ? 'rgba(0,230,118,0.15)' : 'rgba(255,255,255,0.08)', 
                  color: copiedId === 'conservative' ? 'var(--trend-up)' : 'inherit',
                  padding: '1px 4px', 
                  borderRadius: '3px',
                  fontWeight: copiedId === 'conservative' ? 'bold' : 'normal'
                }}>
                  {copiedId === 'conservative' ? '已複製!' : '點擊複製'}
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: isLong ? 'var(--accent-secondary)' : 'var(--trend-down)', fontFamily: 'var(--font-display)' }}>
                ${formatCryptoPrice(entryConservative)}
              </div>
            </div>

            {/* Entry point 2 */}
            <div 
              className="suggested-level-card"
              style={{ 
                background: 'rgba(124, 77, 255, 0.04)', 
                border: '1px solid rgba(124, 77, 255, 0.15)', 
                padding: '14px', 
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                transition: 'transform 0.2s, background-color 0.2s'
              }}
              onClick={() => handleCopy('aggressive', entryAggressive)}
              title="點擊複製價格到剪貼簿"
            >
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{isLong ? '建議做多 (激進 - 中軌)' : '建議做空 (激進 - 中軌)'}</span>
                <span style={{ 
                  fontSize: '9px', 
                  opacity: copiedId === 'aggressive' ? 1 : 0.6, 
                  background: copiedId === 'aggressive' ? 'rgba(0,230,118,0.15)' : 'rgba(255,255,255,0.08)', 
                  color: copiedId === 'aggressive' ? 'var(--trend-up)' : 'inherit',
                  padding: '1px 4px', 
                  borderRadius: '3px',
                  fontWeight: copiedId === 'aggressive' ? 'bold' : 'normal'
                }}>
                  {copiedId === 'aggressive' ? '已複製!' : '點擊複製'}
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-primary)', fontFamily: 'var(--font-display)' }}>
                ${formatCryptoPrice(entryAggressive)}
              </div>
            </div>

            {/* Take Profit target */}
            <div 
              className="suggested-level-card"
              style={{ 
                background: 'rgba(0, 230, 118, 0.04)', 
                border: '1px solid rgba(0, 230, 118, 0.15)', 
                padding: '14px', 
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                transition: 'transform 0.2s, background-color 0.2s'
              }}
              onClick={() => handleCopy('tp', takeProfit1)}
              title="點擊複製價格到剪貼簿"
            >
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{isLong ? '做多止盈目標 (TP1 / TP2)' : '做空止盈目標 (TP1 / TP2)'}</span>
                <span style={{ 
                  fontSize: '9px', 
                  opacity: copiedId === 'tp' ? 1 : 0.6, 
                  background: copiedId === 'tp' ? 'rgba(0,230,118,0.15)' : 'rgba(255,255,255,0.08)', 
                  color: copiedId === 'tp' ? 'var(--trend-up)' : 'inherit',
                  padding: '1px 4px', 
                  borderRadius: '3px',
                  fontWeight: copiedId === 'tp' ? 'bold' : 'normal'
                }}>
                  {copiedId === 'tp' ? '已複製!' : '點擊複製'}
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--trend-up)', fontFamily: 'var(--font-display)' }}>
                ${formatCryptoPrice(takeProfit1)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500, fontFamily: 'var(--font-display)', marginTop: '2px' }}>
                TP2: ${formatCryptoPrice(takeProfit2)}
              </div>
            </div>

            {/* Stop Loss target */}
            <div 
              className="suggested-level-card"
              style={{ 
                background: 'rgba(255, 23, 68, 0.04)', 
                border: '1px solid rgba(255, 23, 68, 0.15)', 
                padding: '14px', 
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                transition: 'transform 0.2s, background-color 0.2s'
              }}
              onClick={() => handleCopy('sl', stopLoss)}
              title="點擊複製價格到剪貼簿"
            >
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{isLong ? '做多止損點位 (SL)' : '做空止損點位 (SL)'}</span>
                <span style={{ 
                  fontSize: '9px', 
                  opacity: copiedId === 'sl' ? 1 : 0.6, 
                  background: copiedId === 'sl' ? 'rgba(0,230,118,0.15)' : 'rgba(255,255,255,0.08)', 
                  color: copiedId === 'sl' ? 'var(--trend-up)' : 'inherit',
                  padding: '1px 4px', 
                  borderRadius: '3px',
                  fontWeight: copiedId === 'sl' ? 'bold' : 'normal'
                }}>
                  {copiedId === 'sl' ? '已複製!' : '點擊複製'}
                </span>
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--trend-down)', fontFamily: 'var(--font-display)' }}>
                ${formatCryptoPrice(stopLoss)}
              </div>
            </div>
            
            {/* Open Interest dynamic statistic (Futures only) */}
            {openInterest !== undefined && openInterest !== null && (
              <div style={{ background: 'rgba(255, 179, 0, 0.04)', border: '1px solid rgba(255, 179, 0, 0.15)', padding: '14px', borderRadius: 'var(--radius-sm)', gridColumn: 'span 2' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' }}>合約持倉量 (Open Interest)</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: '#ffb300', fontFamily: 'var(--font-display)' }}>
                  ${formatLargeNumber(openInterest)}
                </div>
              </div>
            )}
          </div>

        </div>

      </div>

      {/* Indicator Checklist Table */}
      <div className="crypto-table-container" style={{ border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', marginTop: '20px' }}>
        <table className="crypto-table" style={{ fontSize: '13px' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 12px' }}>技術指標</th>
              <th style={{ padding: '8px 12px' }}>當前數值</th>
              <th style={{ padding: '8px 12px' }}>解讀訊號</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>多空偏向</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: '8px 12px', fontWeight: 600 }}>相對強弱指數 RSI (14)</td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--font-display)' }}>{rsi ? rsi.toFixed(2) : '計算中...'}</td>
              <td style={{ padding: '8px 12px' }}>{rsiSignal}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                <span className={`trend-indicator ${rsiScore > 0 ? 'trend-up' : rsiScore < 0 ? 'trend-down' : ''}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                  {rsiScore > 0 ? '看多' : rsiScore < 0 ? '看空' : '中立'}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ padding: '8px 12px', fontWeight: 600 }}>平滑異同均線 MACD</td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--font-display)', fontSize: '12px' }}>
                Diff: {macd.macd.toFixed(4)} | Dea: {macd.signal.toFixed(4)}
              </td>
              <td style={{ padding: '8px 12px' }}>{macdSignal}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                <span className={`trend-indicator ${macdScore > 0 ? 'trend-up' : macdScore < 0 ? 'trend-down' : ''}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                  {macdScore > 0 ? '看多' : macdScore < 0 ? '看空' : '中立'}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ padding: '8px 12px', fontWeight: 600 }}>布林通道位置 BB (20, 2)</td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--font-display)' }}>
                寬度: {((bbRange/bb.middle)*100).toFixed(2)}% | 位置: {(bbPosition*100).toFixed(0)}%
              </td>
              <td style={{ padding: '8px 12px' }}>{bbSignal}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                <span className={`trend-indicator ${bbScore > 0 ? 'trend-up' : bbScore < 0 ? 'trend-down' : ''}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                  {bbScore > 0 ? '看多' : bbScore < 0 ? '看空' : '中立'}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ padding: '8px 12px', fontWeight: 600 }}>均線排列趨勢 (SMA/EMA)</td>
              <td style={{ padding: '8px 12px', fontFamily: 'var(--font-display)', fontSize: '12px' }}>
                SMA20: {sma20 ? `$${formatCryptoPrice(sma20)}` : 'N/A'}
              </td>
              <td style={{ padding: '8px 12px' }}>{trendSignal}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                <span className={`trend-indicator ${trendScore > 0 ? 'trend-up' : trendScore < 0 ? 'trend-down' : ''}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                  {trendScore > 0 ? '多頭' : trendScore < 0 ? '空頭' : '整理'}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
