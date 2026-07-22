import { useState, useEffect } from 'react';
import { X, Info } from 'lucide-react';
import { formatCryptoPrice, getPricePrecision } from '../services/utils';

interface TradingModalProps {
  isOpen: boolean;
  symbol: string;
  suggestedSide: 'LONG' | 'SHORT';
  suggestedPrice: number;
  availableBalance: number;
  onClose: () => void;
  onSubmit: (
    symbol: string,
    side: 'LONG' | 'SHORT',
    type: 'MARKET' | 'LIMIT',
    leverage: number,
    price: number,
    size: number,
    takeProfit?: number,
    stopLoss?: number
  ) => void;
  suggestedTp?: number;
  suggestedSl?: number;
  conservativeEntry?: number;
  aggressiveEntry?: number;
}

export default function TradingModal({
  isOpen,
  symbol,
  suggestedSide,
  suggestedPrice,
  availableBalance,
  onClose,
  onSubmit,
  suggestedTp,
  suggestedSl,
  conservativeEntry,
  aggressiveEntry
}: TradingModalProps) {
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG');
  const [price, setPrice] = useState<number>(suggestedPrice);
  const [leverage, setLeverage] = useState<number>(20);
  const [size, setSize] = useState<string>('1000'); // position size in USDT
  
  const [useTpSl, setUseTpSl] = useState<boolean>(false);
  const [takeProfit, setTakeProfit] = useState<string>('');
  const [stopLoss, setStopLoss] = useState<string>('');

  // Update side and price when suggested suggestions change (e.g. user clicks another coin)
  useEffect(() => {
    setSide(suggestedSide);
    setPrice(suggestedPrice);
    // Suggest default TP/SL based on direction
    if (suggestedPrice > 0) {
      const prec = getPricePrecision(suggestedPrice);
      
      if (suggestedTp !== undefined && suggestedTp > 0) {
        setTakeProfit(suggestedTp.toFixed(prec));
        setUseTpSl(true);
      } else {
        const tp = suggestedSide === 'LONG' ? (suggestedPrice * 1.05).toFixed(prec) : (suggestedPrice * 0.95).toFixed(prec);
        setTakeProfit(tp);
      }

      if (suggestedSl !== undefined && suggestedSl > 0) {
        setStopLoss(suggestedSl.toFixed(prec));
        setUseTpSl(true);
      } else {
        const sl = suggestedSide === 'LONG' ? (suggestedPrice * 0.97).toFixed(prec) : (suggestedPrice * 1.03).toFixed(prec);
        setStopLoss(sl);
      }
    }
  }, [suggestedSide, suggestedPrice, symbol, suggestedTp, suggestedSl]);

  if (!isOpen) return null;

  const currentPrice = price || suggestedPrice || 0;
  const numSize = parseFloat(size) || 0;
  const estMargin = numSize / leverage;
  const isBalanceSufficient = availableBalance >= estMargin;

  // Calculate liquidation price
  const calculateLiqPrice = () => {
    if (currentPrice <= 0 || leverage <= 0) return 0;
    // Standard contract liquidation formula:
    // LONG: Liq = Entry * (1 - 1/L + maintenance_margin_rate (e.g. 0.4%))
    // SHORT: Liq = Entry * (1 + 1/L - maintenance_margin_rate (e.g. 0.4%))
    if (side === 'LONG') {
      return currentPrice * (1 - 1 / leverage + 0.004);
    } else {
      return currentPrice * (1 + 1 / leverage - 0.004);
    }
  };

  const liqPrice = calculateLiqPrice();

  // Sizing percentage handler
  const handleQuickPercent = (pct: number) => {
    // Max size in USDT is availableBalance * leverage
    const maxSize = availableBalance * leverage * 0.98; // 98% for safety margin
    const computedSize = Math.floor(maxSize * pct);
    setSize(computedSize > 10 ? computedSize.toString() : '10');
  };

  // Preset leverage handler
  const handlePresetLeverage = (lev: number) => {
    setLeverage(lev);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (numSize <= 0) {
      alert('請輸入有效的倉位大小！');
      return;
    }

    if (estMargin < 5) {
      alert('保證金必須大於 $5 USDT！');
      return;
    }

    if (!isBalanceSufficient) {
      alert('可用餘額不足以支付保證金！');
      return;
    }

    const finalTp = useTpSl && takeProfit ? parseFloat(takeProfit) : undefined;
    const finalSl = useTpSl && stopLoss ? parseFloat(stopLoss) : undefined;

    // Validate TP/SL prices
    if (finalTp) {
      if (side === 'LONG' && finalTp <= currentPrice) {
        alert('做多止盈價格必須高於委託價格！');
        return;
      }
      if (side === 'SHORT' && finalTp >= currentPrice) {
        alert('做空止盈價格必須低於委託價格！');
        return;
      }
    }

    if (finalSl) {
      if (side === 'LONG' && finalSl >= currentPrice) {
        alert('做多止損價格必須低於委託價格！');
        return;
      }
      if (side === 'SHORT' && finalSl <= currentPrice) {
        alert('做空止損價格必須高於委託價格！');
        return;
      }
    }

    onSubmit(
      symbol,
      side,
      orderType,
      leverage,
      currentPrice,
      numSize,
      finalTp,
      finalSl
    );
    onClose();
  };

  const coinName = symbol.replace('USDT', '');

  return (
    <div className="modal-overlay">
      <div className="modal-card trading-modal-card">
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className={`side-indicator-dot ${side}`} />
            <h3 className="modal-title">
              模擬合約委託下單 - <strong>{coinName} / USDT</strong>
            </h3>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Order Type Toggle (Market / Limit) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', background: 'rgba(0,0,0,0.2)', padding: '4px', borderRadius: 'var(--radius-sm)' }}>
            <button
              type="button"
              className={`trade-toggle-btn ${orderType === 'MARKET' ? 'active' : ''}`}
              onClick={() => setOrderType('MARKET')}
            >
              市價委託 (Market)
            </button>
            <button
              type="button"
              className={`trade-toggle-btn ${orderType === 'LIMIT' ? 'active' : ''}`}
              onClick={() => setOrderType('LIMIT')}
            >
              限價委託 (Limit)
            </button>
          </div>

          {/* Side Toggle (LONG / SHORT) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button
              type="button"
              className={`side-toggle-btn long ${side === 'LONG' ? 'active' : ''}`}
              onClick={() => {
                setSide('LONG');
                if (price > 0) {
                  const prec = getPricePrecision(price);
                  setTakeProfit((price * 1.05).toFixed(prec));
                  setStopLoss((price * 0.97).toFixed(prec));
                }
              }}
            >
              買入 / 做多 (LONG)
            </button>
            <button
              type="button"
              className={`side-toggle-btn short ${side === 'SHORT' ? 'active' : ''}`}
              onClick={() => {
                setSide('SHORT');
                if (price > 0) {
                  const prec = getPricePrecision(price);
                  setTakeProfit((price * 0.95).toFixed(prec));
                  setStopLoss((price * 1.03).toFixed(prec));
                }
              }}
            >
              賣出 / 做空 (SHORT)
            </button>
          </div>

          {/* Limit Price Input (Only for LIMIT type) */}
          <div className="form-group" style={{ display: orderType === 'LIMIT' ? 'block' : 'none' }}>
            <label>委託價格 (USDT)</label>
            <input
              type="number"
              step="any"
              className="form-input"
              value={price}
              onChange={(e) => {
                const val = parseFloat(e.target.value) || 0;
                setPrice(val);
                if (val > 0) {
                  const prec = getPricePrecision(val);
                  setTakeProfit(side === 'LONG' ? (val * 1.05).toFixed(prec) : (val * 0.95).toFixed(prec));
                  setStopLoss(side === 'LONG' ? (val * 0.97).toFixed(prec) : (val * 1.03).toFixed(prec));
                }
              }}
              required={orderType === 'LIMIT'}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '4px', color: 'var(--text-secondary)' }}>
              <span>最新價格: ${formatCryptoPrice(suggestedPrice)}</span>
              <span style={{ cursor: 'pointer', color: 'var(--accent-secondary)' }} onClick={() => setPrice(suggestedPrice)}>使用市價</span>
            </div>
            {(conservativeEntry || aggressiveEntry) && (
              <div style={{ display: 'flex', gap: '8px', fontSize: '11px', marginTop: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)' }}>AI 建議入場:</span>
                {conservativeEntry && (
                  <button
                    type="button"
                    className="preset-btn"
                    style={{ padding: '2px 6px', fontSize: '10px', height: 'auto', width: 'auto', display: 'inline-flex' }}
                    onClick={() => {
                      setPrice(conservativeEntry);
                      const prec = getPricePrecision(conservativeEntry);
                      if (!suggestedTp) {
                        setTakeProfit(side === 'LONG' ? (conservativeEntry * 1.05).toFixed(prec) : (conservativeEntry * 0.95).toFixed(prec));
                      }
                      if (!suggestedSl) {
                        setStopLoss(side === 'LONG' ? (conservativeEntry * 0.97).toFixed(prec) : (conservativeEntry * 1.03).toFixed(prec));
                      }
                    }}
                  >
                    保守 (${formatCryptoPrice(conservativeEntry)})
                  </button>
                )}
                {aggressiveEntry && (
                  <button
                    type="button"
                    className="preset-btn"
                    style={{ padding: '2px 6px', fontSize: '10px', height: 'auto', width: 'auto', display: 'inline-flex' }}
                    onClick={() => {
                      setPrice(aggressiveEntry);
                      const prec = getPricePrecision(aggressiveEntry);
                      if (!suggestedTp) {
                        setTakeProfit(side === 'LONG' ? (aggressiveEntry * 1.05).toFixed(prec) : (aggressiveEntry * 0.95).toFixed(prec));
                      }
                      if (!suggestedSl) {
                        setStopLoss(side === 'LONG' ? (aggressiveEntry * 0.97).toFixed(prec) : (aggressiveEntry * 1.03).toFixed(prec));
                      }
                    }}
                  >
                    激進 (${formatCryptoPrice(aggressiveEntry)})
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Leverage Selector (Slider + Presets) */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <label>槓桿倍數 (Leverage)</label>
              <span style={{ color: 'var(--accent-primary)', fontWeight: 700, fontFamily: 'var(--font-display)' }}>{leverage}x</span>
            </div>
            <input
              type="range"
              min="1"
              max="125"
              className="leverage-slider"
              value={leverage}
              onChange={(e) => setLeverage(parseInt(e.target.value))}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', marginTop: '6px' }}>
              {[5, 10, 20, 50, 100].map((lev) => (
                <button
                  key={lev}
                  type="button"
                  className={`preset-btn ${leverage === lev ? 'active' : ''}`}
                  onClick={() => handlePresetLeverage(lev)}
                >
                  {lev}x
                </button>
              ))}
            </div>
          </div>

          {/* Sizing Input (USDT + Percentages) */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <label>名義價值 (Position Size in USDT)</label>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                餘額: ${availableBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
            </div>
            <div style={{ position: 'relative' }}>
              <input
                type="number"
                step="any"
                className="form-input"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="輸入交易價值"
                required
              />
              <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>USDT</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', marginTop: '6px' }}>
              {[0.1, 0.25, 0.5, 1.0].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="preset-btn"
                  onClick={() => handleQuickPercent(pct)}
                  title={`使用最大可開倉的 ${pct * 100}%`}
                >
                  {pct * 100}%
                </button>
              ))}
            </div>
          </div>

          {/* TP / SL Checkbox Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' }}>
            <input
              type="checkbox"
              id="use-tpsl-checkbox"
              checked={useTpSl}
              onChange={(e) => setUseTpSl(e.target.checked)}
              style={{ cursor: 'pointer', width: '15px', height: '15px' }}
            />
            <label htmlFor="use-tpsl-checkbox" style={{ margin: 0, cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
              啟用止盈 / 止損 (TP / SL Settings)
            </label>
          </div>

          {/* TP / SL Inputs */}
          {useTpSl && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', animation: 'fadeIn 0.2s' }}>
              <div className="form-group">
                <label style={{ color: 'var(--trend-up)' }}>止盈價格 (Take Profit)</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder="達此價格自動結算"
                />
                {suggestedTp !== undefined && suggestedTp > 0 && (
                  <div style={{ display: 'flex', gap: '4px', fontSize: '10px', marginTop: '4px', color: 'var(--text-secondary)' }}>
                    <span>AI 建議:</span>
                    <span 
                      style={{ cursor: 'pointer', color: 'var(--trend-up)', textDecoration: 'underline' }} 
                      onClick={() => setTakeProfit(suggestedTp.toString())}
                    >
                      ${formatCryptoPrice(suggestedTp)}
                    </span>
                  </div>
                )}
              </div>
              <div className="form-group">
                <label style={{ color: 'var(--trend-down)' }}>止損價格 (Stop Loss)</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="達此價格自動退場"
                />
                {suggestedSl !== undefined && suggestedSl > 0 && (
                  <div style={{ display: 'flex', gap: '4px', fontSize: '10px', marginTop: '4px', color: 'var(--text-secondary)' }}>
                    <span>AI 建議:</span>
                    <span 
                      style={{ cursor: 'pointer', color: 'var(--trend-down)', textDecoration: 'underline' }} 
                      onClick={() => setStopLoss(suggestedSl.toString())}
                    >
                      ${formatCryptoPrice(suggestedSl)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Details Dashboard Card */}
          <div className="trading-details-card">
            <div className="detail-row">
              <span>委託類型</span>
              <strong style={{ color: 'var(--text-primary)' }}>{orderType === 'MARKET' ? '市價委託' : '限價委託'}</strong>
            </div>
            <div className="detail-row">
              <span>方向</span>
              <strong className={side === 'LONG' ? 'trend-up' : 'trend-down'}>{side === 'LONG' ? '買入做多 (LONG)' : '賣出做空 (SHORT)'}</strong>
            </div>
            <div className="detail-row">
              <span>預估占用保證金</span>
              <strong style={{ color: isBalanceSufficient ? 'var(--text-primary)' : 'var(--trend-down)', fontFamily: 'var(--font-display)' }}>
                ${estMargin.toFixed(2)} USDT
              </strong>
            </div>
            <div className="detail-row">
              <span>預估強平價格 (Est. Liq)</span>
              <strong style={{ color: 'var(--trend-down)', fontFamily: 'var(--font-display)' }}>
                ${liqPrice > 0 ? formatCryptoPrice(liqPrice) : '--'} USDT
              </strong>
            </div>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
              <Info size={10} />
              <span>注意：當行情觸及強平價時，部位保證金將會全數清算歸零。</span>
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            className="btn-primary"
            style={{
              background: side === 'LONG' ? 'var(--trend-up)' : 'var(--trend-down)',
              padding: '12px',
              fontSize: '14px',
              marginTop: '6px'
            }}
          >
            {orderType === 'MARKET' ? '確認市價開倉' : '送出限價掛單'}
          </button>
        </form>
      </div>
    </div>
  );
}
