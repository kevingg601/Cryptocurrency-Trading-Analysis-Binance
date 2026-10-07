import { useState } from 'react';
import { X, Info } from 'lucide-react';
import { formatCryptoPrice, getPricePrecision } from '../services/utils';
import type { MarketType } from '../services/binance';
import { describeEntry, validatePaperOrder, validateProtection } from '../services/orderValidation';

interface TradingModalProps {
  isOpen: boolean;
  marketType: MarketType;
  marketPrice: number | null;
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
  ) => boolean | void;
  suggestedTp?: number;
  suggestedSl?: number;
  conservativeEntry?: number;
  aggressiveEntry?: number;
}

export default function TradingModal({
  isOpen,
  marketType,
  marketPrice,
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
  const initialSide = marketType === 'spot' ? 'LONG' : suggestedSide;
  const initialReference = marketPrice ?? suggestedPrice;
  const suggestionsValid = validateProtection(initialSide, initialReference, suggestedTp, suggestedSl) === null;
  const precision = getPricePrecision(initialReference);
  const [side, setSide] = useState<'LONG' | 'SHORT'>(initialSide);
  const [price, setPrice] = useState<number>(suggestedPrice);
  const [chosenLeverage, setLeverage] = useState<number>(20);
  const leverage = marketType === 'spot' ? 1 : chosenLeverage;
  const [size, setSize] = useState<string>('1000'); // position size in USDT
  
  const [useTpSl, setUseTpSl] = useState<boolean>(suggestionsValid && (suggestedTp !== undefined || suggestedSl !== undefined));
  const [takeProfit, setTakeProfit] = useState<string>(() => (suggestionsValid && suggestedTp !== undefined ? suggestedTp : initialReference * (initialSide === 'LONG' ? 1.05 : 0.95)).toFixed(precision));
  const [stopLoss, setStopLoss] = useState<string>(() => (suggestionsValid && suggestedSl !== undefined ? suggestedSl : initialReference * (initialSide === 'LONG' ? 0.97 : 1.03)).toFixed(precision));

  if (!isOpen) return null;

  const livePrice = marketPrice ?? 0;
  const currentPrice = orderType === 'MARKET' ? livePrice : price;
  const numSize = parseFloat(size) || 0;
  const estMargin = numSize / leverage;
  const isBalanceSufficient = availableBalance >= estMargin;
  const finalTp = useTpSl && takeProfit !== '' ? Number(takeProfit) : undefined;
  const finalSl = useTpSl && stopLoss !== '' ? Number(stopLoss) : undefined;
  const validationError = validatePaperOrder(side, orderType, price, livePrice, finalTp, finalSl)
    ?? (!Number.isFinite(numSize) || numSize <= 0 ? '請輸入有效的倉位大小。' : estMargin < 5 ? '模擬保證金至少為 5 USDT。' : !isBalanceSufficient ? '可用餘額不足以支付保證金。' : null);
  const conservativePlan = conservativeEntry ? describeEntry(side, conservativeEntry, livePrice) : null;
  const aggressivePlan = aggressiveEntry ? describeEntry(side, aggressiveEntry, livePrice) : null;
  const currentSuggestionValid = side === initialSide && validateProtection(side, currentPrice, suggestedTp, suggestedSl) === null;

  // Calculate liquidation price
  const calculateLiqPrice = () => {
    if (marketType === 'spot' || currentPrice <= 0 || leverage <= 0) return 0;
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
    if (validationError) return;
    const submitted = onSubmit(
      symbol,
      side,
      orderType,
      leverage,
      currentPrice,
      numSize,
      finalTp,
      finalSl
    );
    if (submitted !== false) onClose();
  };

  const coinName = symbol.replace('USDT', '');

  return (
    <div className="modal-overlay">
      <div className="modal-card trading-modal-card" role="dialog" aria-modal="true" aria-labelledby="paper-order-title">
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className={`side-indicator-dot ${side}`} />
            <h3 className="modal-title" id="paper-order-title">
              模擬{marketType === 'spot' ? '現貨' : '合約'}委託 - <strong>{coinName} / USDT</strong>
            </h3>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="關閉模擬委託">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px 20px 20px' }}>
          <div className="entry-condition-label">最新價格 ${livePrice > 0 ? formatCryptoPrice(livePrice) : '--'} · {orderType === 'MARKET' ? '依送出時最新行情模擬成交' : '僅支援回撤限價，未提供突破觸發單'}</div>
          {validationError && <div className="order-validation-message" role="alert">{validationError}</div>}
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
                if (currentPrice > 0) {
                  const prec = getPricePrecision(currentPrice);
                  setTakeProfit((currentPrice * 1.05).toFixed(prec));
                  setStopLoss((currentPrice * 0.97).toFixed(prec));
                }
              }}
            >
              買入 / 做多 (LONG)
            </button>
            <button
              type="button"
              className={`side-toggle-btn short ${side === 'SHORT' ? 'active' : ''}`}
              disabled={marketType === 'spot'}
              onClick={() => {
                setSide('SHORT');
                if (currentPrice > 0) {
                  const prec = getPricePrecision(currentPrice);
                  setTakeProfit((currentPrice * 0.95).toFixed(prec));
                  setStopLoss((currentPrice * 1.03).toFixed(prec));
                }
              }}
            >
              賣出 / 做空 (SHORT)
            </button>
          </div>

          {/* Limit Price Input (Only for LIMIT type) */}
          <div className="form-group" style={{ display: orderType === 'LIMIT' ? 'block' : 'none' }}>
            <label htmlFor="paper-order-price">委託價格 (USDT)</label>
            <input
              type="number"
              id="paper-order-price"
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
              <span>最新價格: ${formatCryptoPrice(livePrice)}</span>
              <button type="button" className="preset-btn" onClick={() => setPrice(livePrice)}>帶入現價</button>
            </div>
            {(conservativeEntry || aggressiveEntry) && (
              <div style={{ display: 'flex', gap: '8px', fontSize: '11px', marginTop: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)' }}>觀察價（非觸發單）:</span>
                {conservativeEntry && (
                  <button
                    type="button"
                    className="preset-btn"
                    disabled={side !== initialSide || conservativePlan?.mode !== 'LIMIT'}
                    title={conservativePlan?.label}
                    style={{ padding: '2px 6px', fontSize: '10px', height: 'auto', width: 'auto', display: 'inline-flex' }}
                    onClick={() => {
                      setPrice(conservativeEntry);
                      const prec = getPricePrecision(conservativeEntry);
                      if (!suggestedTp || !currentSuggestionValid) {
                        setTakeProfit(side === 'LONG' ? (conservativeEntry * 1.05).toFixed(prec) : (conservativeEntry * 0.95).toFixed(prec));
                      }
                      if (!suggestedSl || !currentSuggestionValid) {
                        setStopLoss(side === 'LONG' ? (conservativeEntry * 0.97).toFixed(prec) : (conservativeEntry * 1.03).toFixed(prec));
                      }
                    }}
                  >
                    保守 (${formatCryptoPrice(conservativeEntry)}){conservativePlan?.mode !== 'LIMIT' ? ' · 待確認' : ''}
                  </button>
                )}
                {aggressiveEntry && (
                  <button
                    type="button"
                    className="preset-btn"
                    disabled={side !== initialSide || aggressivePlan?.mode !== 'LIMIT'}
                    title={aggressivePlan?.label}
                    style={{ padding: '2px 6px', fontSize: '10px', height: 'auto', width: 'auto', display: 'inline-flex' }}
                    onClick={() => {
                      setPrice(aggressiveEntry);
                      const prec = getPricePrecision(aggressiveEntry);
                      if (!suggestedTp || !currentSuggestionValid) {
                        setTakeProfit(side === 'LONG' ? (aggressiveEntry * 1.05).toFixed(prec) : (aggressiveEntry * 0.95).toFixed(prec));
                      }
                      if (!suggestedSl || !currentSuggestionValid) {
                        setStopLoss(side === 'LONG' ? (aggressiveEntry * 0.97).toFixed(prec) : (aggressiveEntry * 1.03).toFixed(prec));
                      }
                    }}
                  >
                    激進 (${formatCryptoPrice(aggressiveEntry)}){aggressivePlan?.mode !== 'LIMIT' ? ' · 待確認' : ''}
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
              disabled={marketType === 'spot'}
              value={leverage}
              onChange={(e) => setLeverage(parseInt(e.target.value))}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', marginTop: '6px' }}>
              {[5, 10, 20, 50, 100].map((lev) => (
                <button
                  key={lev}
                  type="button"
                  className={`preset-btn ${leverage === lev ? 'active' : ''}`}
                  disabled={marketType === 'spot'}
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
              <label htmlFor="paper-order-size">名義價值 (Position Size in USDT)</label>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                餘額: ${availableBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </span>
            </div>
            <div style={{ position: 'relative' }}>
              <input
                type="number"
                id="paper-order-size"
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
                <label htmlFor="paper-order-tp" style={{ color: 'var(--trend-up)' }}>止盈價格 (Take Profit)</label>
                <input
                  type="number"
                  id="paper-order-tp"
                  step="any"
                  className="form-input"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder="達此價格自動結算"
                />
                {currentSuggestionValid && suggestedTp !== undefined && suggestedTp > 0 && (
                  <div style={{ display: 'flex', gap: '4px', fontSize: '10px', marginTop: '4px', color: 'var(--text-secondary)' }}>
                    <span>觀察參考:</span>
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
                <label htmlFor="paper-order-sl" style={{ color: 'var(--trend-down)' }}>止損價格 (Stop Loss)</label>
                <input
                  type="number"
                  id="paper-order-sl"
                  step="any"
                  className="form-input"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="達此價格自動退場"
                />
                {currentSuggestionValid && suggestedSl !== undefined && suggestedSl > 0 && (
                  <div style={{ display: 'flex', gap: '4px', fontSize: '10px', marginTop: '4px', color: 'var(--text-secondary)' }}>
                    <span>觀察參考:</span>
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
            {marketType === 'futures' && <div className="detail-row">
              <span>預估強平價格 (Est. Liq)</span>
              <strong style={{ color: 'var(--trend-down)', fontFamily: 'var(--font-display)' }}>
                ${liqPrice > 0 ? formatCryptoPrice(liqPrice) : '--'} USDT
              </strong>
            </div>}
            {marketType === 'futures' && <div style={{ display: 'flex', gap: '4px', alignItems: 'center', fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px' }}>
              <Info size={10} />
              <span>注意：當行情觸及強平價時，部位保證金將會全數清算歸零。</span>
            </div>}
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={validationError !== null}
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
