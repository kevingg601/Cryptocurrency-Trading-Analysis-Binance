import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Activity,
  ArrowLeft,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  LockKeyhole,
  Pause,
  Play,
  Settings2,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import type { AutoTradingConfig, AutoTradingSnapshot } from '../services/autoTrading';
import { calculateAutoMetrics } from '../services/autoTrading';
import { ABComparisonCoordinator } from '@fadachi/core';
import type { ABTradingBatch, ABComparisonMetrics, AIAnalysisResult } from '@fadachi/core';
import { collectorClient } from '../api/collectorClient';
import EquityChart from './EquityChart';
import ABEquityChart from './ABEquityChart';
import './AutoTrading.css';

export interface AutoTradingProps {
  snapshot: AutoTradingSnapshot;
  onStart: (config: AutoTradingConfig) => void;
  onPause: () => void;
  onResume: () => void;
  onDrain: () => void;
  onCloseAll: () => void;
  onSelectSymbol: (symbol: string, planId?: string) => void;
  theme: 'dark' | 'light';
  storageError: string | null;
  history: AutoTradingSnapshot[];
  ready?: boolean;
  statusMessage?: string;

  // A/B mode props
  abSnapshot?: ABTradingBatch;
  abHistory?: ABTradingBatch[];
  abMetrics?: ABComparisonMetrics;
  onStartAB?: (config: AutoTradingConfig, selectedCoins: string[], model: string) => void;
  onPauseAB?: () => void;
  onResumeAB?: () => void;
  onDrainAB?: () => void;
  onCloseAllAB?: () => void;
  tradingMode?: 'single' | 'ab';
  onToggleTradingMode?: (mode: 'single' | 'ab') => void;
  availableModels?: string[];
  isolationVerified?: boolean;
  universeSymbols?: string[];
  latestAnalyses?: Record<string, AIAnalysisResult>;
}

const STATUS_LABELS: Record<AutoTradingSnapshot['status'], string> = {
  IDLE: '尚未啟動',
  RUNNING: '執行中',
  PAUSED: '已暫停',
  DRAINING: '收尾中',
  COMPLETED: '已完成',
  INTERRUPTED: '已中斷',
};
const ACTIVE_STATUSES = new Set(['RUNNING', 'PAUSED', 'DRAINING']);
const FUNDING_LABELS: Record<AutoTradingSnapshot['fundingStatus'], string> = {
  NOT_REQUIRED: '現貨不適用',
  PENDING: '核對中',
  SETTLED: '已核對',
  ERROR: '核對失敗',
};
const PAGE_SIZE = 50;
const numberFormat = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const priceFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 8 });
const dateFormat = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const money = (value: number) => (Number.isFinite(value) ? numberFormat.format(value) : '--');
const price = (value: number) => (Number.isFinite(value) ? priceFormat.format(value) : '--');
const percent = (value: number | null) => (value !== null && Number.isFinite(value) ? `${value.toFixed(2)}%` : '--');
const tone = (value: number) => (value > 0 ? 'at-positive' : value < 0 ? 'at-negative' : '');
const date = (value?: number) =>
  value && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? dateFormat.format(value) : '--';
const iso = (value?: number) =>
  value && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : '';
const sideLabel = (side: string) => (side === 'LONG' ? '做多' : side === 'SHORT' ? '做空' : side);
const isSkipped = (event: AutoTradingSnapshot['events'][number]) => /skip|reject|ignore|miss|cancel/i.test(event.type);

type ConfigKey = Exclude<keyof AutoTradingConfig, 'marketType'>;
const FIELDS: { key: ConfigKey; label: string; min: number; max?: number; step: number }[] = [
  { key: 'initialCapital', label: '初始資金（USDT）', min: 100, step: 0.01 },
  { key: 'riskPct', label: '單筆風險（%）', min: 0.01, max: 5, step: 0.01 },
  { key: 'maxNotionalPct', label: '單筆名目金額上限（%）', min: 0.01, max: 20, step: 0.01 },
  { key: 'maxPositions', label: '同時持倉上限', min: 1, max: 3, step: 1 },
  { key: 'feeBps', label: '單邊手續費（bps）', min: 0, max: 100, step: 0.1 },
  { key: 'slippageBps', label: '單邊滑價（bps）', min: 0, max: 100, step: 0.1 },
  { key: 'latencyMs', label: '模擬延遲（ms）', min: 250, max: 4999, step: 1 },
];

function Settings({
  config,
  locked,
  historical,
  ready,
  onStart,
  formId,
}: {
  config: AutoTradingConfig;
  locked: boolean;
  historical: boolean;
  ready: boolean;
  onStart: AutoTradingProps['onStart'];
  formId: string;
}) {
  const [draft, setDraft] = useState<Record<ConfigKey, string>>(() =>
    Object.fromEntries(FIELDS.map((field) => [field.key, String(config[field.key])])) as Record<ConfigKey, string>
  );
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <form
      id={formId}
      className="at-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || historical || !ready) return;
        const values = Object.fromEntries(
          FIELDS.map((field) => [field.key, Number(draft[field.key])])
        ) as Record<ConfigKey, number>;
        const invalid = FIELDS.find(
          (field) =>
            draft[field.key].trim() === '' ||
            !Number.isFinite(values[field.key]) ||
            values[field.key] < field.min ||
            (field.max !== undefined && values[field.key] > field.max) ||
            ((field.key === 'maxPositions' || field.key === 'latencyMs') && !Number.isInteger(values[field.key]))
        );
        if (invalid) {
          setError(`請檢查「${invalid.label}」的數值。`);
          return;
        }
        setError(null);
        onStart({ ...values, marketType: config.marketType });
      }}
    >
      <fieldset disabled={locked || historical}>
        <legend>
          <Settings2 size={16} aria-hidden="true" />
          {historical ? '批次設定' : '風控與成交設定'}
        </legend>
        <div className="at-fields">
          {FIELDS.map((field) => (
            <label key={field.key} htmlFor={`${id}-${field.key}`}>
              <span>{field.label}</span>
              <input
                id={`${id}-${field.key}`}
                type="number"
                inputMode={field.step < 1 ? 'decimal' : 'numeric'}
                min={field.min}
                max={field.max}
                step={field.step}
                required
                value={locked || historical ? config[field.key] : draft[field.key]}
                onChange={(event) => {
                  setDraft((previous) => ({ ...previous, [field.key]: event.target.value }));
                  setError(null);
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="at-settings-footer">
        {(locked || historical) && (
          <span>
            <LockKeyhole size={14} aria-hidden="true" />
            {historical ? '歷史批次・唯讀' : '批次進行中・設定已鎖定'}
          </span>
        )}
        <span>1 bps = 0.01%</span>
      </div>
      {error && (
        <p className="at-notice at-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// Single mode CSV export
function downloadCsv(batches: AutoTradingSnapshot[], filename: string, scope: 'all' | 'fill' | 'trade' = 'all') {
  const columns = [
    'record_type',
    'batch_id',
    'market_type',
    'status',
    'id',
    'timestamp_utc',
    'symbol',
    'side',
    'plan_id',
    'position_id',
    'kind',
    'reason',
    'message',
    'entry_price',
    'exit_price',
    'current_price',
    'quantity',
    'remaining_quantity',
    'stop_loss',
    'take_profit_1',
    'take_profit_2',
    'tp1_hit',
    'opened_at_utc',
    'closed_at_utc',
    'last_received_at_utc',
    'eligible_at_utc',
    'expires_at_utc',
    'entry_fee_usdt',
    'gross_pnl_usdt',
    'fees_usdt',
    'funding_usdt',
    'net_pnl_usdt',
    'realized_pnl_usdt',
    'unrealized_pnl_usdt',
    'equity_usdt',
    'cash_usdt',
    'return_pct',
    'max_drawdown_pct',
    'win_rate_pct',
    'profit_factor',
    'completed_trades',
    'incomplete_positions',
    'incomplete',
    'initial_capital_usdt',
    'risk_pct',
    'max_notional_pct',
    'max_positions',
    'fee_bps',
    'slippage_bps',
    'latency_ms',
    'started_at_utc',
    'ended_at_utc',
    'schema_version',
    'strategy_version',
    'signal_settings_json',
    'funding_status',
    'funding_through_utc',
    'action',
    'fill_price',
    'trade_timestamp_utc',
    'source_trade_id',
    'fee_usdt',
    'funding_charge_usdt',
    'exit_notional_usdt',
    'exit_fees_usdt',
    'signal_timestamp_utc',
    'plan_json',
    'equity_peak_usdt',
    'recorded_max_drawdown_pct',
    'peak_timestamp_utc',
  ];
  type Row = Record<string, string | number | boolean | null | undefined>;
  const rows: Row[] = [];
  for (const batch of batches) {
    const metrics = calculateAutoMetrics(batch);
    const base = {
      batch_id: batch.id,
      market_type: batch.config.marketType,
      status: batch.status,
      schema_version: batch.schemaVersion,
      strategy_version: batch.strategyVersion,
      funding_status: batch.fundingStatus,
      funding_through_utc: iso(batch.fundingThrough),
    };
    const add = (record_type: string, row: Row) => rows.push({ ...base, record_type, ...row });
    add('batch', {
      reason: batch.reason,
      started_at_utc: iso(batch.startedAt),
      ended_at_utc: iso(batch.endedAt),
      signal_settings_json: batch.signalSettings ? JSON.stringify(batch.signalSettings) : '',
      initial_capital_usdt: batch.config.initialCapital,
      risk_pct: batch.config.riskPct,
      max_notional_pct: batch.config.maxNotionalPct,
      max_positions: batch.config.maxPositions,
      fee_bps: batch.config.feeBps,
      slippage_bps: batch.config.slippageBps,
      latency_ms: batch.config.latencyMs,
      equity_usdt: metrics.equity,
      cash_usdt: batch.cash,
      return_pct: metrics.returnPct,
      realized_pnl_usdt: metrics.realizedPnl,
      unrealized_pnl_usdt: metrics.unrealizedPnl,
      fees_usdt: metrics.fees,
      funding_usdt: metrics.funding,
      max_drawdown_pct: metrics.maxDrawdownPct,
      win_rate_pct: metrics.winRate,
      profit_factor: metrics.profitFactor,
      completed_trades: metrics.completedTrades,
      incomplete_positions: metrics.incompletePositions,
      equity_peak_usdt: batch.equityPeak,
      recorded_max_drawdown_pct: batch.maxDrawdownPct,
      peak_timestamp_utc: iso(batch.peakTimestamp),
    });
    for (const plan of batch.plans) {
      add('plan', { id: plan.id, plan_id: plan.id, symbol: plan.symbol, side: plan.side, plan_json: JSON.stringify(plan) });
    }
    for (const position of batch.positions) {
      add('position', {
        id: position.id,
        plan_id: position.planId,
        symbol: position.symbol,
        side: position.side,
        entry_price: position.entryPrice,
        current_price: position.currentPrice,
        quantity: position.quantity,
        remaining_quantity: position.remainingQuantity,
        stop_loss: position.stopLoss,
        take_profit_1: position.takeProfit1,
        take_profit_2: position.takeProfit2,
        tp1_hit: position.tp1Hit,
        opened_at_utc: iso(position.openedAt),
        last_received_at_utc: iso(position.lastReceivedAt),
        entry_fee_usdt: position.entryFee,
        realized_pnl_usdt: position.realizedPnl,
        incomplete: !!position.incomplete,
        exit_notional_usdt: position.exitNotional,
        exit_fees_usdt: position.exitFees,
        funding_usdt: position.funding,
      });
    }
    for (const order of batch.orders) {
      add('order', {
        id: order.id,
        plan_id: order.planId,
        position_id: order.positionId,
        symbol: order.symbol,
        side: order.side,
        kind: order.kind,
        reason: order.reason,
        quantity: order.quantity,
        timestamp_utc: iso(order.createdAt),
        eligible_at_utc: iso(order.eligibleAt),
        expires_at_utc: iso(order.expiresAt),
        signal_timestamp_utc: iso(order.signalTimestamp),
        source_trade_id: order.signalTradeId,
      });
    }
    for (const fill of batch.fills) {
      add('fill', {
        id: fill.id,
        position_id: fill.positionId,
        symbol: fill.symbol,
        side: fill.side,
        action: fill.action,
        plan_id:
          batch.positions.find((position) => position.id === fill.positionId)?.planId ??
          batch.trades.find((trade) => trade.id === fill.positionId)?.planId,
        timestamp_utc: iso(fill.timestamp),
        trade_timestamp_utc: iso(fill.tradeTimestamp),
        source_trade_id: fill.tradeId,
        fill_price: fill.price,
        quantity: fill.quantity,
        fee_usdt: fill.fee,
        gross_pnl_usdt: fill.grossPnl,
        reason: fill.reason,
      });
    }
    for (const trade of batch.trades) {
      add('trade', {
        id: trade.id,
        plan_id: trade.planId,
        symbol: trade.symbol,
        side: trade.side,
        entry_price: trade.entryPrice,
        exit_price: trade.exitPrice,
        quantity: trade.quantity,
        opened_at_utc: iso(trade.openedAt),
        closed_at_utc: iso(trade.closedAt),
        gross_pnl_usdt: trade.grossPnl,
        fees_usdt: trade.fees,
        funding_usdt: trade.funding,
        net_pnl_usdt: trade.netPnl,
        reason: trade.reason,
        incomplete: !!trade.incomplete,
      });
    }
    for (const event of batch.events) {
      add('event', {
        id: event.id,
        timestamp_utc: iso(event.timestamp),
        kind: event.type,
        symbol: event.symbol,
        message: event.message,
      });
    }
    for (const charge of batch.fundingCharges) {
      add('funding_charge', {
        id: charge.id,
        position_id: charge.positionId,
        symbol: charge.symbol,
        timestamp_utc: iso(charge.timestamp),
        funding_charge_usdt: charge.amount,
      });
    }
    for (const point of batch.equity) {
      add('equity', { timestamp_utc: iso(point.timestamp), equity_usdt: point.value });
    }
    for (const point of batch.riskExtrema ?? []) {
      add('equity_extremum', { timestamp_utc: iso(point.timestamp), equity_usdt: point.value });
    }
  }
  const escape = (value: Row[string]) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const selectedRows = scope === 'all' ? rows : rows.filter((row) => row.record_type === scope);
  const csv = [
    columns.map(escape).join(','),
    ...selectedRows.map((row) => columns.map((column) => escape(row[column])).join(',')),
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Tab = 'positions' | 'trades' | 'events';
function Records({
  snapshot,
  onSelectSymbol,
  onExport,
  inspectLocked,
}: Pick<AutoTradingProps, 'snapshot' | 'onSelectSymbol'> & {
  onExport: (scope: 'fill' | 'trade') => void;
  inspectLocked: boolean;
}) {
  const [tab, setTab] = useState<Tab>('positions');
  const [page, setPage] = useState(0);
  const [skippedOnly, setSkippedOnly] = useState(false);
  const [tradeView, setTradeView] = useState<'fill' | 'trade'>('fill');
  const id = useId();
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'positions', label: '持倉', count: snapshot.positions.length },
    { key: 'trades', label: '交易', count: snapshot.fills.length },
    { key: 'events', label: '事件', count: snapshot.events.length },
  ];
  const events = skippedOnly ? snapshot.events.filter(isSkipped) : snapshot.events;
  const count =
    tab === 'positions'
      ? snapshot.positions.length
      : tab === 'trades'
      ? tradeView === 'fill'
        ? snapshot.fills.length
        : snapshot.trades.length
      : events.length;
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const from = currentPage * PAGE_SIZE;
  const symbolButton = (symbol: string, planId?: string) => (
    <button
      type="button"
      className="at-symbol"
      disabled={inspectLocked}
      onClick={() => onSelectSymbol(symbol, planId)}
      title={inspectLocked ? '目前批次執行中，市場已鎖定' : `查看 ${symbol}${planId ? ' 的批次計畫' : ''}`}
    >
      {symbol}
    </button>
  );
  const selectTab = (next: Tab) => {
    setTab(next);
    setPage(0);
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[next].key);
    document.getElementById(`${id}-${tabs[next].key}`)?.focus();
  };
  return (
    <section className="at-records" aria-label="批次紀錄">
      <div className="at-records-heading">
        <div className="at-tabs" role="tablist" aria-label="紀錄類別">
          {tabs.map((item, index) => (
            <button
              type="button"
              role="tab"
              id={`${id}-${item.key}`}
              key={item.key}
              aria-selected={tab === item.key}
              aria-controls={`${id}-panel`}
              tabIndex={tab === item.key ? 0 : -1}
              onClick={() => selectTab(item.key)}
              onKeyDown={(event) => handleTabKey(event, index)}
            >
              {item.label}
              <span>{item.count}</span>
            </button>
          ))}
        </div>
        <span className="at-caption">時間：臺北（UTC+8）</span>
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
        {tab === 'trades' && (
          <div className="at-trade-toolbar">
            <div className="at-trade-views" role="group" aria-label="交易紀錄範圍">
              <button
                type="button"
                aria-pressed={tradeView === 'fill'}
                onClick={() => {
                  setTradeView('fill');
                  setPage(0);
                }}
              >
                成交帳本（{snapshot.fills.length}）
              </button>
              <button
                type="button"
                aria-pressed={tradeView === 'trade'}
                onClick={() => {
                  setTradeView('trade');
                  setPage(0);
                }}
              >
                已平倉彙總（{snapshot.trades.length}）
              </button>
            </div>
            <button type="button" className="at-button" onClick={() => onExport(tradeView)}>
              <Download size={15} aria-hidden="true" />
              {tradeView === 'fill' ? '成交 CSV' : '已平倉 CSV'}
            </button>
          </div>
        )}
        {tab === 'events' && (
          <label className="at-filter">
            <input
              type="checkbox"
              checked={skippedOnly}
              onChange={(event) => {
                setSkippedOnly(event.target.checked);
                setPage(0);
              }}
            />
            只看略過／拒絕／取消訊號
          </label>
        )}
        <div
          className="at-table-scroll"
          role="region"
          aria-label={`${tabs.find((item) => item.key === tab)?.label}明細`}
          tabIndex={0}
        >
          {tab === 'positions' && (
            <table className="at-table">
              <caption className="at-sr-only">持倉明細，浮動損益未扣除成本</caption>
              <thead>
                <tr>
                  {[
                    '幣種／方向',
                    '進場時間',
                    '進場／現價',
                    '剩餘／原始數量',
                    '止損',
                    'TP1／TP2',
                    '浮動損益（未扣成本）',
                    '進場費用',
                    '資料狀態',
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.positions.slice(from, from + PAGE_SIZE).map((position) => {
                  const floating =
                    (position.currentPrice - position.entryPrice) *
                    position.remainingQuantity *
                    (position.side === 'LONG' ? 1 : -1);
                  return (
                    <tr key={position.id}>
                      <td>
                        {symbolButton(position.symbol, position.planId)}
                        <small>{sideLabel(position.side)}</small>
                      </td>
                      <td>{date(position.openedAt)}</td>
                      <td>
                        {price(position.entryPrice)}
                        <small>{price(position.currentPrice)}</small>
                      </td>
                      <td>
                        {price(position.remainingQuantity)}
                        <small>／{price(position.quantity)}</small>
                      </td>
                      <td>{price(position.stopLoss)}</td>
                      <td>
                        {price(position.takeProfit1)}
                        {position.tp1Hit && <span className="at-tag">已達 TP1</span>}
                        <small>{price(position.takeProfit2)}</small>
                      </td>
                      <td className={tone(floating)}>{money(floating)}</td>
                      <td>{money(position.entryFee)}</td>
                      <td>
                        {position.incomplete ? <span className="at-warning">資料不完整</span> : '報價接收'}
                        <small>{date(position.lastReceivedAt)}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {tab === 'trades' && tradeView === 'fill' && (
            <table className="at-table">
              <caption className="at-sr-only">逐筆成交帳本，包含進場與部分出場；損益與手續費單位 USDT</caption>
              <thead>
                <tr>
                  {[
                    '幣種／方向',
                    '成交類別',
                    '處理／市場成交時間',
                    '成交價格',
                    '數量',
                    '毛損益',
                    '手續費',
                    '原因',
                    '持倉 ID',
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.fills
                  .slice()
                  .reverse()
                  .slice(from, from + PAGE_SIZE)
                  .map((fill) => (
                    <tr key={fill.id}>
                      <td>
                        {symbolButton(
                          fill.symbol,
                          snapshot.positions.find((position) => position.id === fill.positionId)?.planId ??
                            snapshot.trades.find((trade) => trade.id === fill.positionId)?.planId
                        )}
                        <small>{sideLabel(fill.side)}</small>
                      </td>
                      <td>{fill.action === 'ENTRY' ? '進場' : '出場'}</td>
                      <td>
                        {date(fill.timestamp)}
                        <small>{date(fill.tradeTimestamp)}</small>
                      </td>
                      <td>{price(fill.price)}</td>
                      <td>{price(fill.quantity)}</td>
                      <td className={tone(fill.grossPnl)}>{money(fill.grossPnl)}</td>
                      <td>{money(fill.fee)}</td>
                      <td className="at-message">{fill.reason}</td>
                      <td className="at-message">{fill.positionId}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {tab === 'trades' && tradeView === 'trade' && (
            <table className="at-table">
              <caption className="at-sr-only">交易紀錄與成本，單位 USDT</caption>
              <thead>
                <tr>
                  {[
                    '幣種／方向',
                    '進場／出場時間',
                    '進場／出場價',
                    '數量',
                    '毛損益',
                    '手續費',
                    '資金費',
                    '淨損益',
                    '出場原因',
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.trades
                  .slice()
                  .reverse()
                  .slice(from, from + PAGE_SIZE)
                  .map((trade) => (
                    <tr key={trade.id}>
                      <td>
                        {symbolButton(trade.symbol, trade.planId)}
                        <small>{sideLabel(trade.side)}</small>
                      </td>
                      <td>
                        {date(trade.openedAt)}
                        <small>{date(trade.closedAt)}</small>
                      </td>
                      <td>
                        {price(trade.entryPrice)}
                        <small>{price(trade.exitPrice)}</small>
                      </td>
                      <td>{price(trade.quantity)}</td>
                      <td className={tone(trade.grossPnl)}>{money(trade.grossPnl)}</td>
                      <td>{money(trade.fees)}</td>
                      <td>{money(trade.funding)}</td>
                      <td className={tone(trade.netPnl)}>{money(trade.netPnl)}</td>
                      <td className="at-message">
                        {trade.reason}
                        {trade.incomplete && <small className="at-warning">資料不完整</small>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {tab === 'events' && (
            <table className="at-table at-event-table">
              <caption className="at-sr-only">事件紀錄，包含略過與拒絕訊號</caption>
              <thead>
                <tr>
                  {['時間', '類型', '幣種', '內容'].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events
                  .slice()
                  .reverse()
                  .slice(from, from + PAGE_SIZE)
                  .map((event) => (
                    <tr key={event.id}>
                      <td>{date(event.timestamp)}</td>
                      <td className={isSkipped(event) ? 'at-warning at-message' : 'at-message'}>{event.type}</td>
                      <td>{event.symbol ? symbolButton(event.symbol) : '--'}</td>
                      <td className="at-message">{event.message}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {count === 0 && (
            <p className="at-empty">
              {tab === 'positions'
                ? '目前沒有持倉'
                : tab === 'trades'
                ? '尚無交易紀錄'
                : skippedOnly
                ? '沒有略過、拒絕或取消訊號'
                : '尚無事件紀錄'}
            </p>
          )}
        </div>
        {count > PAGE_SIZE && (
          <div className="at-pagination">
            <span>
              {from + 1}–{Math.min(from + PAGE_SIZE, count)}／{count}
            </span>
            <button
              type="button"
              className="at-icon-button"
              aria-label="上一頁"
              title="上一頁"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              第 {currentPage + 1}／{pages} 頁
            </span>
            <button
              type="button"
              className="at-icon-button"
              aria-label="下一頁"
              title="下一頁"
              disabled={currentPage === pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        {tab === 'positions' && (
          <details className="at-orders">
            <summary>待處理委託（{snapshot.orders.length}）</summary>
            {snapshot.orders.length === 0 ? (
              <p className="at-empty">目前沒有待處理委託</p>
            ) : (
              <div className="at-table-scroll" role="region" aria-label="待處理委託明細" tabIndex={0}>
                <table className="at-table">
                  <caption className="at-sr-only">待處理委託</caption>
                  <thead>
                    <tr>
                      {['幣種／方向', '類別', '建立時間', '最早執行', '到期時間', '數量', '原因'].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.orders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          {symbolButton(order.symbol, order.planId)}
                          <small>{sideLabel(order.side)}</small>
                        </td>
                        <td>{order.kind === 'ENTRY' ? '進場' : '出場'}</td>
                        <td>{date(order.createdAt)}</td>
                        <td>{date(order.eligibleAt)}</td>
                        <td>{date(order.expiresAt)}</td>
                        <td>{order.quantity === undefined ? '--' : price(order.quantity)}</td>
                        <td className="at-message">{order.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        )}
      </div>
    </section>
  );
}

export default function AutoTrading({
  snapshot,
  onStart,
  onPause,
  onResume,
  onDrain,
  onCloseAll,
  onSelectSymbol,
  theme,
  storageError,
  history,
  ready = true,
  statusMessage,
  // A/B Props
  abSnapshot,
  abHistory = [],
  abMetrics: _propABMetrics,
  onStartAB,
  onPauseAB,
  onResumeAB,
  onDrainAB,
  onCloseAllAB,
  tradingMode: propTradingMode,
  onToggleTradingMode,
  availableModels = [],
  isolationVerified,
  universeSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
}: AutoTradingProps) {
  const [localMode, setLocalMode] = useState<'single' | 'ab'>('single');
  const currentMode = propTradingMode ?? localMode;

  // Single mode state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  // A/B mode state
  const [abSelectedId, setAbSelectedId] = useState<string | null>(null);
  const [abSelectedCoins, setAbSelectedCoins] = useState<string[]>(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const [abModel, setAbModel] = useState<string>(availableModels[0] || '');
  useEffect(() => {
    if (availableModels.length && !availableModels.includes(abModel)) setAbModel(availableModels[0]);
  }, [availableModels, abModel]);
  const [abTab, setAbTab] = useState<'metrics' | 'blocked' | 'accountA' | 'accountB' | 'decisions'>('metrics');
  const abDialog = useRef<HTMLDialogElement>(null);

  const id = useId();
  const formId = `${id}-settings`;
  const abFormId = `${id}-ab-settings`;

  // Single mode batch resolution
  const archived = selectedId !== null && selectedId !== snapshot.id ? history.find((batch) => batch.id === selectedId) : undefined;
  const shown = archived ?? snapshot;
  const historical = !!archived;
  const isSingleActive = ACTIVE_STATUSES.has(snapshot.status);

  // A/B mode batch resolution
  const defaultAB: ABTradingBatch = abSnapshot ?? {
    schemaVersion: 1,
    id: 'idle',
    marketType: snapshot.config.marketType,
    status: 'IDLE',
    startedAt: 0,
    config: snapshot.config,
    selectedCoins: ['BTCUSDT', 'ETHUSDT'],
    model: abModel,
    promptVersion: 'prompt-v1',
    ruleVersion: 'rule-v1',
    accountA: snapshot,
    accountB: snapshot,
    decisions: [],
    revision: 0,
  };
  const archivedAB =
    abSelectedId !== null && abSelectedId !== defaultAB.id
      ? abHistory.find((batch) => batch.id === abSelectedId)
      : undefined;
  const abShown = archivedAB ?? defaultAB;
  const abHistorical = !!archivedAB;
  const isABActive = ACTIVE_STATUSES.has(defaultAB.status);

  // Metrics
  const metrics = calculateAutoMetrics(shown);
  const metricsA = calculateAutoMetrics(abShown.accountA);
  const metricsB = calculateAutoMetrics(abShown.accountB);

  const abAccountIncomplete = (account: AutoTradingSnapshot) => account.fundingStatus === 'PENDING'
    || account.fundingStatus === 'ERROR' || account.positions.length > 0 || account.orders.length > 0
    || account.trades.some(trade => trade.incomplete) || account.status === 'INTERRUPTED';
  const abIncompleteA = abAccountIncomplete(abShown.accountA);
  const abIncompleteB = abAccountIncomplete(abShown.accountB);
  const abCostsComplete = !abIncompleteA && !abIncompleteB;
  const abCommonCutoff = Math.min(
    abShown.accountA.equity.at(-1)?.timestamp ?? abShown.startedAt,
    abShown.accountB.equity.at(-1)?.timestamp ?? abShown.startedAt,
  );

  const returnDelta = metricsB.returnPct !== null && metricsA.returnPct !== null ? metricsB.returnPct - metricsA.returnPct : null;
  const equityDelta = metricsB.equity - metricsA.equity;
  const drawdownDelta = (metricsA.maxDrawdownPct ?? 0) - (metricsB.maxDrawdownPct ?? 0);
  const costSavings = (metricsA.fees + metricsA.funding) - (metricsB.fees + metricsB.funding);

  const canStart = ready;
  const incomplete = shown.status === 'INTERRUPTED' || metrics.incompletePositions > 0 || shown.trades.some((trade) => trade.incomplete);
  const fundingUnsettled = shown.config.marketType === 'futures' && (shown.fundingStatus === 'PENDING' || shown.fundingStatus === 'ERROR');
  const fundingLabel = shown.fundingStatus === 'NOT_REQUIRED' && shown.config.marketType === 'futures' ? '尚無交易' : FUNDING_LABELS[shown.fundingStatus];

  const batches = [...new Map([...history, snapshot].map((batch) => [batch.id, batch])).values()]
    .filter((batch) => batch.status !== 'IDLE')
    .sort((a, b) => b.startedAt - a.startedAt);

  const abBatches = [...new Map([...abHistory, defaultAB].map((batch) => [batch.id, batch])).values()]
    .filter((batch) => batch.status !== 'IDLE')
    .sort((a, b) => b.startedAt - a.startedAt);

  const points = useMemo(() => {
    const samples = new Map<number, number>();
    for (const point of shown.equity) {
      if (Number.isFinite(point.timestamp) && point.timestamp > 0 && Number.isFinite(point.value)) {
        samples.set(Math.floor(point.timestamp / 1000), point.value);
      }
    }
    return [...samples].sort(([a], [b]) => a - b).map(([time, equity]) => ({ time, equity }));
  }, [shown.equity]);

  const pointsA = useMemo(() => {
    const samples = new Map<number, number>();
    for (const point of abShown.accountA.equity) {
      if (Number.isFinite(point.timestamp) && point.timestamp > 0 && Number.isFinite(point.value)) {
        samples.set(Math.floor(point.timestamp / 1000), point.value);
      }
    }
    return [...samples].sort(([a], [b]) => a - b).map(([time, equity]) => ({ time, equity }));
  }, [abShown.accountA.equity]);

  const pointsB = useMemo(() => {
    const samples = new Map<number, number>();
    for (const point of abShown.accountB.equity) {
      if (Number.isFinite(point.timestamp) && point.timestamp > 0 && Number.isFinite(point.value)) {
        samples.set(Math.floor(point.timestamp / 1000), point.value);
      }
    }
    return [...samples].sort(([a], [b]) => a - b).map(([time, equity]) => ({ time, equity }));
  }, [abShown.accountB.equity]);

  const canClose = isSingleActive && !historical && (snapshot.positions.length > 0 || snapshot.orders.length > 0);
  const canCloseAB =
    isABActive &&
    !abHistorical &&
    (defaultAB.accountA.positions.length > 0 ||
      defaultAB.accountB.positions.length > 0 ||
      defaultAB.accountA.orders.length > 0 ||
      defaultAB.accountB.orders.length > 0);

  const exportBatches = (all: boolean, scope: 'all' | 'fill' | 'trade' = 'all') => {
    try {
      downloadCsv(all ? batches : [shown], `paper-auto-${all ? 'all-batches' : shown.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${scope}.csv`, scope);
      setExportError(null);
    } catch {
      setExportError('CSV 匯出失敗，請再試一次。');
    }
  };

  const exportABBatch = async () => {
    try {
      let csv: string;
      try {
        csv = await collectorClient.exportABBatchCsv(abShown.id);
      } catch {
        const metadata = [
          'batch_metadata,field,value',
          `batch_metadata,common_cutoff_utc,${iso(abCommonCutoff)}`,
          `batch_metadata,account_a_funding_status,${abShown.accountA.fundingStatus}`,
          `batch_metadata,account_a_incomplete,${abIncompleteA}`,
          `batch_metadata,account_b_funding_status,${abShown.accountB.fundingStatus}`,
          `batch_metadata,account_b_incomplete,${abIncompleteB}`,
          `batch_metadata,pair_cost_status,${abCostsComplete ? 'COMPLETE' : 'PROVISIONAL'}`,
          '',
        ].join('\r\n');
        csv = metadata + ABComparisonCoordinator.exportCsvFromBatch(abShown);
      }
      const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ab-comparison-${abShown.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError(null);
    } catch {
      setExportError('A/B 對照 CSV 匯出失敗，請再試一次。');
    }
  };

  const toggleCoin = (symbol: string) => {
    if (isABActive || abHistorical) return;
    setAbSelectedCoins((prev) => {
      if (prev.includes(symbol)) {
        if (prev.length <= 1) return prev; // Keep at least one
        return prev.filter((s) => s !== symbol);
      } else {
        if (prev.length >= 10) return prev; // Max 10 coins
        return [...prev, symbol];
      }
    });
  };

  const blockedSignals = useMemo(() => {
    return abShown.decisions.filter((d) => !d.allowed);
  }, [abShown.decisions]);

  const totalDecisions = abShown.decisions.length;
  const allowedDecisions = abShown.decisions.filter(d => d.allowed).length;
  const coveredDecisions = abShown.decisions.filter(d => d.analysisAvailable
    ?? (d.reason === 'ACCEPTED' || d.reason === 'NEUTRAL' || d.reason === 'MISMATCH')).length;
  const coverageRate = totalDecisions > 0 ? (coveredDecisions / totalDecisions) * 100 : 0;

  const skipReasonCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of abShown.decisions) {
      if (!d.allowed) {
        counts[d.reason] = (counts[d.reason] || 0) + 1;
      }
    }
    return counts;
  }, [abShown.decisions]);

  const stats = [
    { label: '帳戶淨值', value: money(metrics.equity), unit: 'USDT' },
    { label: '總報酬', value: percent(metrics.returnPct), className: tone(metrics.returnPct) },
    { label: '已實現損益', value: money(metrics.realizedPnl), unit: 'USDT', className: tone(metrics.realizedPnl) },
    { label: '未實現損益', value: money(metrics.unrealizedPnl), unit: 'USDT', className: tone(metrics.unrealizedPnl) },
    { label: '最大回撤', value: percent(metrics.maxDrawdownPct) },
    { label: '勝率', value: percent(metrics.winRate) },
    { label: '獲利因子', value: metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor === null ? '--' : money(metrics.profitFactor) },
    { label: '完成交易', value: String(metrics.completedTrades), unit: '筆' },
  ];

  return (
    <div className="auto-trading" data-theme={theme}>
      {/* Mode Toggle Bar */}
      <div className="at-mode-bar">
        <div className="at-mode-toggle" role="group" aria-label="交易評估模式切換">
          <button
            type="button"
            className={currentMode === 'single' ? 'active' : ''}
            disabled={isABActive}
            title={isABActive ? 'A/B 對照模式執行中，請先結束後再切換' : undefined}
            onClick={() => (onToggleTradingMode ? onToggleTradingMode('single') : setLocalMode('single'))}
          >
            單帳戶評估
          </button>
          <button
            type="button"
            className={currentMode === 'ab' ? 'active' : ''}
            disabled={isSingleActive}
            title={isSingleActive ? '單帳戶評估執行中，請先結束後再切換' : undefined}
            onClick={() => (onToggleTradingMode ? onToggleTradingMode('ab') : setLocalMode('ab'))}
          >
            A/B 對照模式 (AI 門禁篩選)
          </button>
        </div>
        {currentMode === 'ab' && (
          <span className="at-mode-badge">
            <BrainCircuit size={14} />
            雙帳戶成對評估 · AI 許可門禁
          </span>
        )}
      </div>

      {currentMode === 'single' ? (
        /* SINGLE MODE VIEW */
        <>
          <header className="at-header">
            <div className="at-title">
              <Activity size={21} aria-hidden="true" />
              <div>
                <h2>即時紙上自動交易</h2>
                <p>{shown.config.marketType === 'spot' ? '現貨' : '合約'}・模擬帳戶・USDT</p>
              </div>
            </div>
            <div className="at-controls">
              <span className={`at-status at-status-${shown.status.toLowerCase()}`} role="status">
                {historical ? '歷史・' : ''}
                {STATUS_LABELS[shown.status]}
              </span>
              {historical ? (
                <button type="button" className="at-button" onClick={() => setSelectedId(null)}>
                  <ArrowLeft size={15} aria-hidden="true" />
                  返回目前批次
                </button>
              ) : (
                <>
                  {!isSingleActive && (
                    <button type="submit" form={formId} className="at-button at-primary" disabled={!canStart}>
                      <Play size={15} aria-hidden="true" />
                      啟動新批次
                    </button>
                  )}
                  {snapshot.status === 'RUNNING' && (
                    <button type="button" className="at-button" onClick={onPause}>
                      <Pause size={15} aria-hidden="true" />
                      暫停新進場
                    </button>
                  )}
                  {snapshot.status === 'PAUSED' && (
                    <button type="button" className="at-button at-primary" onClick={onResume} disabled={!canStart}>
                      <Play size={15} aria-hidden="true" />
                      繼續
                    </button>
                  )}
                  <button
                    type="button"
                    className="at-button"
                    disabled={!isSingleActive || snapshot.status === 'DRAINING'}
                    onClick={onDrain}
                  >
                    <Square size={14} aria-hidden="true" />
                    停止接單並收尾
                  </button>
                  <button
                    type="button"
                    className="at-button at-danger"
                    disabled={!canClose}
                    onClick={() => dialog.current?.showModal()}
                  >
                    <X size={16} aria-hidden="true" />
                    全部平倉
                  </button>
                </>
              )}
            </div>
          </header>
          <p className="at-risk">
            <ShieldAlert size={15} aria-hidden="true" />
            僅紙上模擬，不送出真實委託；模擬結果不代表實際成交或未來獲利。
          </p>
          {(statusMessage || !ready) && (
            <p className={`at-notice ${!ready ? 'at-unready' : ''}`} role="status">
              <Activity size={16} aria-hidden="true" />
              {statusMessage || '尚未就緒，等待成交串流、交易規格與紀錄初始化。'}
            </p>
          )}
          {storageError && (
            <p className="at-notice at-error" role="alert">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>無法啟動／紀錄狀態：{storageError}</span>
            </p>
          )}
          {shown.reason && (
            <p className="at-notice" role="status">
              批次原因：{shown.reason}
            </p>
          )}
          {incomplete && (
            <p className="at-notice at-error">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                <strong>批次不完整</strong>・不完整持倉 {metrics.incompletePositions} 筆；未完成部位未視為已平倉，績效僅供觀察。
              </span>
            </p>
          )}
          {fundingUnsettled && shown.status !== 'IDLE' && (
            <p className={`at-notice ${shown.fundingStatus === 'ERROR' ? 'at-error' : ''}`} role="status">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                <strong>資金費{FUNDING_LABELS[shown.fundingStatus]}</strong>・
                {shown.fundingStatus === 'PENDING'
                  ? '最新結算資料可能尚未發布，成本結果暫未完整。'
                  : '淨值、淨損益與績效尚非完整成本結果。'}
              </span>
            </p>
          )}
          <div className="at-batchbar">
            <label htmlFor={`${id}-batch`}>
              <History size={15} aria-hidden="true" />
              批次
            </label>
            <select
              id={`${id}-batch`}
              value={historical ? shown.id : ''}
              onChange={(event) => setSelectedId(event.target.value || null)}
            >
              <option value="">目前批次・{STATUS_LABELS[snapshot.status]}</option>
              {batches
                .filter((batch) => batch.id !== snapshot.id)
                .map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {date(batch.startedAt)}・{batch.config.marketType === 'spot' ? '現貨' : '合約'}・{STATUS_LABELS[batch.status]}・
                    {batch.id}
                  </option>
                ))}
            </select>
            <div className="at-exports">
              <button type="button" className="at-button" onClick={() => exportBatches(false)}>
                <Download size={15} aria-hidden="true" />
                本批次 CSV
              </button>
              <button
                type="button"
                className="at-button"
                disabled={batches.length === 0}
                onClick={() => exportBatches(true)}
              >
                <Download size={15} aria-hidden="true" />
                全部批次 CSV
              </button>
            </div>
          </div>
          {exportError && (
            <p className="at-notice at-error" role="alert">
              {exportError}
            </p>
          )}
          <div className="at-overview">
            <section className="at-performance" aria-label="批次績效">
              <dl className="at-stats">
                {stats.map((stat) => (
                  <div key={stat.label}>
                    <dt>{stat.label}</dt>
                    <dd className={stat.className}>
                      {stat.value}
                      {stat.unit && <small>{stat.unit}</small>}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="at-costs">
                <span>
                  手續費 <strong>{money(metrics.fees)} USDT</strong>
                </span>
                <span>
                  資金費 <strong>{money(metrics.funding)} USDT</strong>
                </span>
                <span className={fundingUnsettled ? 'at-warning' : ''}>
                  資金費狀態 <strong>{fundingLabel}</strong>
                  {shown.fundingThrough ? `・核對至 ${date(shown.fundingThrough)}` : ''}
                </span>
                <span>
                  持倉 <strong>{shown.positions.length}</strong>
                </span>
                <span>
                  待處理委託 <strong>{shown.orders.length}</strong>
                </span>
              </div>
              <div className="at-chart-heading">
                <h3>帳戶淨值</h3>
                <span>起始 {money(shown.config.initialCapital)} USDT</span>
              </div>
              {points.length > 0 ? (
                <EquityChart points={points} initialCapital={shown.config.initialCapital} theme={theme} />
              ) : (
                <div className="at-chart-empty">尚無淨值資料</div>
              )}
            </section>
            <aside className="at-settings-side" aria-label="批次設定">
              <Settings
                key={`${shown.id}:${JSON.stringify(shown.config)}`}
                formId={formId}
                config={shown.config}
                locked={ACTIVE_STATUSES.has(shown.status)}
                historical={historical}
                ready={canStart}
                onStart={onStart}
              />
              {shown.signalSettings && (
                <details className="at-signal-settings">
                  <summary>批次訊號設定</summary>
                  <dl>
                    {Object.entries(shown.signalSettings).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{price(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </aside>
          </div>
          <dl className="at-batch-meta">
            <div>
              <dt>批次 ID</dt>
              <dd>{shown.id}</dd>
            </div>
            <div>
              <dt>啟動</dt>
              <dd>{date(shown.startedAt)}</dd>
            </div>
            <div>
              <dt>結束</dt>
              <dd>{date(shown.endedAt)}</dd>
            </div>
            <div>
              <dt>可用現金</dt>
              <dd>{money(shown.cash)} USDT</dd>
            </div>
            <div>
              <dt>策略版本</dt>
              <dd>{shown.strategyVersion}</dd>
            </div>
            <div>
              <dt>紀錄版本</dt>
              <dd>{shown.schemaVersion}</dd>
            </div>
          </dl>
          <Records
            key={shown.id}
            snapshot={shown}
            onSelectSymbol={onSelectSymbol}
            onExport={(scope) => exportBatches(false, scope)}
            inspectLocked={historical && isSingleActive && shown.config.marketType !== snapshot.config.marketType}
          />
        </>
      ) : (
        /* A/B COMPARISON MODE VIEW */
        <>
          <header className="at-header">
            <div className="at-title">
              <BrainCircuit size={21} aria-hidden="true" style={{ color: '#a855f7' }} />
              <div>
                <h2>A/B 雙帳戶評估 (AI 門禁篩選 vs 保守基準)</h2>
                <p>
                  {abShown.config.marketType === 'spot' ? '現貨' : '合約'}・雙帳戶成對評估・初始各 {money(abShown.config.initialCapital)} USDT
                </p>
              </div>
            </div>
            <div className="at-controls">
              <span className={`at-status at-status-${abShown.status.toLowerCase()}`} role="status">
                {abHistorical ? '歷史・' : ''}
                {STATUS_LABELS[abShown.status]}
              </span>
              {abHistorical ? (
                <button type="button" className="at-button" onClick={() => setAbSelectedId(null)}>
                  <ArrowLeft size={15} aria-hidden="true" />
                  返回目前 A/B 批次
                </button>
              ) : (
                <>
                  {!isABActive && (
                    <button
                      type="submit"
                      form={abFormId}
                      className="at-button at-primary"
                      disabled={!canStart || !onStartAB || !isolationVerified || !availableModels.includes(abModel)}
                      title={!isolationVerified ? 'AI CLI 執行環境未通過隔離驗證或不可用，依規範禁止啟動 A/B 批次' : undefined}
                    >
                      <Play size={15} aria-hidden="true" />
                      成對啟動 A/B
                    </button>
                  )}
                  {abShown.status === 'RUNNING' && (
                    <button type="button" className="at-button" onClick={onPauseAB}>
                      <Pause size={15} aria-hidden="true" />
                      暫停新進場
                    </button>
                  )}
                  {abShown.status === 'PAUSED' && (
                    <button type="button" className="at-button at-primary" onClick={onResumeAB} disabled={!canStart}>
                      <Play size={15} aria-hidden="true" />
                      繼續
                    </button>
                  )}
                  <button
                    type="button"
                    className="at-button"
                    disabled={!isABActive || abShown.status === 'DRAINING'}
                    onClick={onDrainAB}
                  >
                    <Square size={14} aria-hidden="true" />
                    停止接單並收尾
                  </button>
                  <button
                    type="button"
                    className="at-button at-danger"
                    disabled={!canCloseAB}
                    onClick={() => abDialog.current?.showModal()}
                  >
                    <X size={16} aria-hidden="true" />
                    全部平倉
                  </button>
                </>
              )}
            </div>
          </header>

          <div className="at-disclaimer-card">
            <ShieldAlert size={16} />
            <span>
              <strong>公平對照原則：</strong> Account A (原保守基準) 與 Account B (AI 門禁篩選) 接收完全相同、有序的成交幀、時間與交易規格。Account B 僅在入場確認當刻具備未過期且方向相符之 AI 分析時方許可進場；止盈、止損、退出與斷線處理獨立運作。
            </span>
          </div>

          {(statusMessage || !ready) && (
            <p className={`at-notice ${!ready ? 'at-unready' : ''}`} role="status">
              <Activity size={16} aria-hidden="true" />
              {statusMessage || '尚未就緒，等待成交串流、交易規格與紀錄初始化。'}
            </p>
          )}
          {storageError && (
            <p className="at-notice at-error" role="alert">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>無法啟動／紀錄狀態：{storageError}</span>
            </p>
          )}

          <div className="at-batchbar">
            <label htmlFor={`${id}-ab-batch`}>
              <History size={15} aria-hidden="true" />
              A/B 批次
            </label>
            <select
              id={`${id}-ab-batch`}
              value={abHistorical ? abShown.id : ''}
              onChange={(event) => setAbSelectedId(event.target.value || null)}
            >
              <option value="">目前批次・{STATUS_LABELS[defaultAB.status]}</option>
              {abBatches
                .filter((batch) => batch.id !== defaultAB.id)
                .map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {date(batch.startedAt)}・{batch.marketType === 'spot' ? '現貨' : '合約'}・{STATUS_LABELS[batch.status]}・
                    {batch.model}・{batch.id}
                  </option>
                ))}
            </select>
            <div className="at-exports">
              <button type="button" className="at-button" onClick={exportABBatch}>
                <Download size={15} aria-hidden="true" />
                本批次對照 CSV
              </button>
            </div>
          </div>

          <div className="at-overview">
            <section className="at-performance" aria-label="A/B 共同時間軸淨值走勢">
              <div className="at-chart-heading">
                <h3>A/B 共同時間軸淨值走勢</h3>
                <span>起始各 {money(abShown.config.initialCapital)} USDT</span>
              </div>
              <ABEquityChart
                pointsA={pointsA}
                pointsB={pointsB}
                initialCapital={abShown.config.initialCapital}
                theme={theme}
              />

              <div className="at-coverage-bar">
                <span>
                  總評估訊號：<strong>{totalDecisions}</strong> 次
                </span>
                <span>
                  AI 許可進場：<strong>{allowedDecisions}</strong> 次
                </span>
                <span>
                  AI 覆蓋率：<strong>{coverageRate.toFixed(1)}%</strong>
                </span>
                {Object.keys(skipReasonCounts).length > 0 && (
                  <span>
                    略過原因：
                    {Object.entries(skipReasonCounts).map(([reason, cnt]) => (
                      <span key={reason} style={{ marginLeft: '6px' }}>
                        {reason}: {cnt}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </section>

            <aside className="at-settings-side" aria-label="A/B 設定與追蹤清單">
              <Settings
                key={`${abShown.id}:${JSON.stringify(abShown.config)}`}
                formId={abFormId}
                config={abShown.config}
                locked={isABActive}
                historical={abHistorical}
                ready={canStart && Boolean(isolationVerified) && availableModels.includes(abModel)}
                onStart={(newCfg) => {
                  onStartAB?.(newCfg, abSelectedCoins, abModel);
                }}
              />

              <div style={{ marginTop: '16px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  追蹤幣種清單（上限 10 個，已選 {(isABActive || abHistorical ? abShown.selectedCoins : abSelectedCoins).length}）
                  {abHistorical && '・歷史批次鎖定'}
                </span>
                <div className="at-coin-picker">
                  {Array.from(new Set([...(isABActive || abHistorical ? abShown.selectedCoins : abSelectedCoins), ...universeSymbols])).slice(0, 15).map((symbol) => {
                    const isSelected = (isABActive || abHistorical ? abShown.selectedCoins : abSelectedCoins).includes(symbol);
                    return (
                      <button
                        type="button"
                        key={symbol}
                        className={`at-coin-chip ${isSelected ? 'selected' : ''}`}
                        disabled={isABActive || abHistorical}
                        onClick={() => toggleCoin(symbol)}
                        title={isABActive || abHistorical ? '批次執行中已鎖定' : `點擊切換 ${symbol}`}
                      >
                        {symbol.replace('USDT', '')}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ marginTop: '12px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  AI 分析模型
                  <select
                    className="at-model-selector"
                    value={isABActive || abHistorical ? abShown.model : abModel}
                    disabled={isABActive || abHistorical}
                    onChange={(e) => setAbModel(e.target.value)}
                  >
                    {Array.from(new Set([...(isABActive || abHistorical ? [abShown.model] : []), ...availableModels])).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </aside>
          </div>

          {/* Comparative Metrics Table */}
          <div style={{ marginTop: '20px' }}>
            <h3 style={{ fontSize: '14px', marginBottom: '8px' }}>策略對照績效指標 (A/B Comparison)</h3>
            <p className={`at-notice ${abCostsComplete ? '' : 'at-warning'}`} role="status">
              A 資金費：{FUNDING_LABELS[abShown.accountA.fundingStatus]}・{abIncompleteA ? '評估未完整' : '成本已核對'}；
              B 資金費：{FUNDING_LABELS[abShown.accountB.fundingStatus]}・{abIncompleteB ? '評估未完整' : '成本已核對'}；
              {abCostsComplete ? '成對成本完整' : '以下成對報酬與差異均為暫估'}。共同截止：{date(abCommonCutoff)}
            </p>
            <div className="at-table-scroll">
              <table className="at-ab-table">
                <thead>
                  <tr>
                    <th>評估指標</th>
                    <th style={{ color: '#38bdf8' }}>Account A (保守基準)</th>
                    <th style={{ color: '#a855f7' }}>Account B (AI 門禁篩選)</th>
                    <th>策略差異 (Delta = B - A)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>帳戶淨值 (USDT)</td>
                    <td>{money(metricsA.equity)}</td>
                    <td>{money(metricsB.equity)}</td>
                    <td className={tone(equityDelta)}>
                      {equityDelta >= 0 ? '+' : ''}
                      {money(equityDelta)} USDT
                    </td>
                  </tr>
                  <tr>
                    <td>{abCostsComplete ? '扣成本淨報酬率 (%)' : '暫估扣成本淨報酬率 (%)'}</td>
                    <td className={tone(metricsA.returnPct ?? 0)}>{percent(metricsA.returnPct)}{abIncompleteA ? '（暫估）' : ''}</td>
                    <td className={tone(metricsB.returnPct ?? 0)}>{percent(metricsB.returnPct)}{abIncompleteB ? '（暫估）' : ''}</td>
                    <td className={tone(returnDelta ?? 0)}>
                      {returnDelta !== null ? `${returnDelta >= 0 ? '+' : ''}${returnDelta.toFixed(2)}%${abCostsComplete ? '' : '（暫估）'}` : '--'}
                    </td>
                  </tr>
                  <tr>
                    <td>最大回撤 (%)</td>
                    <td>{percent(metricsA.maxDrawdownPct)}</td>
                    <td>{percent(metricsB.maxDrawdownPct)}</td>
                    <td className={tone(drawdownDelta)}>
                      {drawdownDelta >= 0 ? '減少 ' : '增加 '}
                      {Math.abs(drawdownDelta).toFixed(2)}%
                    </td>
                  </tr>
                  <tr>
                    <td>已實現損益 (USDT)</td>
                    <td className={tone(metricsA.realizedPnl)}>{money(metricsA.realizedPnl)}</td>
                    <td className={tone(metricsB.realizedPnl)}>{money(metricsB.realizedPnl)}</td>
                    <td className={tone(metricsB.realizedPnl - metricsA.realizedPnl)}>
                      {metricsB.realizedPnl - metricsA.realizedPnl >= 0 ? '+' : ''}
                      {money(metricsB.realizedPnl - metricsA.realizedPnl)}
                    </td>
                  </tr>
                  <tr>
                    <td>手續費 + 資金費成本 (USDT)</td>
                    <td>{money(metricsA.fees + metricsA.funding)}</td>
                    <td>{money(metricsB.fees + metricsB.funding)}</td>
                    <td className={tone(costSavings)}>
                      {costSavings >= 0 ? '節省 ' : '增加 '}
                      {money(Math.abs(costSavings))} USDT
                    </td>
                  </tr>
                  <tr>
                    <td>完成交易筆數</td>
                    <td>{metricsA.completedTrades}</td>
                    <td>{metricsB.completedTrades}</td>
                    <td>{metricsB.completedTrades - metricsA.completedTrades}</td>
                  </tr>
                  <tr>
                    <td>勝率 (%)</td>
                    <td>{percent(metricsA.winRate)}</td>
                    <td>{percent(metricsB.winRate)}</td>
                    <td>
                      {metricsB.winRate !== null && metricsA.winRate !== null
                        ? `${(metricsB.winRate - metricsA.winRate).toFixed(2)}%`
                        : '--'}
                    </td>
                  </tr>
                  <tr>
                    <td>獲利因子</td>
                    <td>{metricsA.profitFactor === Infinity ? '∞' : metricsA.profitFactor === null ? '--' : money(metricsA.profitFactor)}</td>
                    <td>{metricsB.profitFactor === Infinity ? '∞' : metricsB.profitFactor === null ? '--' : money(metricsB.profitFactor)}</td>
                    <td>--</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Sub Navigation Tabs for Detailed Records */}
          <div style={{ marginTop: '24px' }}>
            <div className="at-trade-views" role="tablist">
              <button
                type="button"
                aria-pressed={abTab === 'metrics'}
                onClick={() => setAbTab('metrics')}
              >
                被 B 阻擋訊號明細（{blockedSignals.length}）
              </button>
              <button
                type="button"
                aria-pressed={abTab === 'decisions'}
                onClick={() => setAbTab('decisions')}
              >
                AI 入場決策全紀錄（{abShown.decisions.length}）
              </button>
              <button
                type="button"
                aria-pressed={abTab === 'accountA'}
                onClick={() => setAbTab('accountA')}
              >
                Account A 明細帳本
              </button>
              <button
                type="button"
                aria-pressed={abTab === 'accountB'}
                onClick={() => setAbTab('accountB')}
              >
                Account B 明細帳本
              </button>
            </div>

            {abTab === 'metrics' && (
              <div style={{ marginTop: '12px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: '11px', marginBottom: '8px' }}>
                  被 Account B 擋下的跟進訊號，以及該訊號在基準 Account A 的實際成交結果。
                  <strong>（註：被 B 擋掉的訊號在 A 的結果僅供策略對照，不計入 B 的模擬淨值）</strong>
                </p>
                <div className="at-table-scroll">
                  <table className="at-table">
                    <thead>
                      <tr>
                        <th>訊號時間</th>
                        <th>幣種／方向</th>
                        <th>AI 阻擋原因</th>
                        <th>模型理由</th>
                        <th>Account A 結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blockedSignals.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', padding: '24px' }}>
                            尚無被阻擋的訊號
                          </td>
                        </tr>
                      ) : (
                        blockedSignals.slice().reverse().map((dec) => {
                          const tradeA = abShown.accountA.trades.find((t) => t.planId === dec.planId);
                          const posA = abShown.accountA.positions.find((p) => p.planId === dec.planId);
                          const outcomeText = tradeA
                            ? `已平倉：毛損益 ${money(tradeA.grossPnl)} / 淨損益 ${money(tradeA.netPnl)} USDT (${tradeA.reason})`
                            : posA
                            ? `持倉中：進場 ${price(posA.entryPrice)} / 現價 ${price(posA.currentPrice)}`
                            : 'A 亦未進場（風控或資金上限）';

                          return (
                            <tr key={dec.id}>
                              <td>{date(dec.timestamp)}</td>
                              <td>
                                <strong>{dec.symbol}</strong>
                                <small>{sideLabel(dec.confirmedSide)}</small>
                              </td>
                              <td className="at-warning at-message">
                                <strong>{dec.reason}</strong>
                                <small>{dec.explanation}</small>
                              </td>
                              <td className="at-message">{dec.explanation}</td>
                              <td className="at-message">
                                <span className={tradeA ? tone(tradeA.netPnl) : ''}>{outcomeText}</span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {abTab === 'decisions' && (
              <div style={{ marginTop: '12px' }}>
                <div className="at-table-scroll">
                  <table className="at-table">
                    <thead>
                      <tr>
                        <th>時間</th>
                        <th>幣種／方向</th>
                        <th>帳戶</th>
                        <th>判定</th>
                        <th>原因</th>
                        <th>模型理由</th>
                      </tr>
                    </thead>
                    <tbody>
                      {abShown.decisions.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ textAlign: 'center', padding: '24px' }}>
                            尚無 AI 決策紀錄
                          </td>
                        </tr>
                      ) : (
                        abShown.decisions.slice().reverse().map((d) => (
                          <tr key={d.id}>
                            <td>{date(d.timestamp)}</td>
                            <td>
                              <strong>{d.symbol}</strong>
                              <small>{sideLabel(d.confirmedSide)}</small>
                            </td>
                            <td>Account {d.account}</td>
                            <td>
                              <span className={d.allowed ? 'at-tag' : 'at-warning'}>
                                {d.allowed ? '許可進場' : '阻擋入場'}
                              </span>
                            </td>
                            <td>{d.reason}</td>
                            <td className="at-message">{d.explanation}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {abTab === 'accountA' && (
              <div style={{ marginTop: '12px' }}>
                <h4 style={{ fontSize: '12px', margin: '8px 0', color: '#38bdf8' }}>Account A (保守基準帳戶) 明細</h4>
                <Records
                  key={`accA-${abShown.id}`}
                  snapshot={abShown.accountA}
                  onSelectSymbol={onSelectSymbol}
                  onExport={(scope) => downloadCsv([abShown.accountA], `accountA-${scope}.csv`, scope)}
                  inspectLocked={false}
                />
              </div>
            )}

            {abTab === 'accountB' && (
              <div style={{ marginTop: '12px' }}>
                <h4 style={{ fontSize: '12px', margin: '8px 0', color: '#a855f7' }}>Account B (AI 門禁篩選帳戶) 明細</h4>
                <Records
                  key={`accB-${abShown.id}`}
                  snapshot={abShown.accountB}
                  onSelectSymbol={onSelectSymbol}
                  onExport={(scope) => downloadCsv([abShown.accountB], `accountB-${scope}.csv`, scope)}
                  inspectLocked={false}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Single Mode Dialog */}
      <dialog ref={dialog} className="at-dialog" aria-labelledby={`${id}-close-title`} aria-describedby={`${id}-close-description`}>
        <h3 id={`${id}-close-title`}>全部平倉？</h3>
        <p id={`${id}-close-description`}>
          將對目前批次的 {snapshot.positions.length} 筆持倉提出平倉，並取消待處理進場委託。成交仍以模擬引擎與可用報價為準。
        </p>
        <div className="at-dialog-actions">
          <form method="dialog">
            <button type="submit" className="at-button" autoFocus>
              取消
            </button>
          </form>
          <button
            type="button"
            className="at-button at-danger"
            disabled={!canClose}
            onClick={() => {
              dialog.current?.close();
              if (canClose) onCloseAll();
            }}
          >
            <X size={15} aria-hidden="true" />
            確認全部平倉
          </button>
        </div>
      </dialog>

      {/* A/B Mode Dialog */}
      <dialog ref={abDialog} className="at-dialog" aria-labelledby={`${id}-ab-close-title`} aria-describedby={`${id}-ab-close-description`}>
        <h3 id={`${id}-ab-close-title`}>全部平倉 A/B 雙帳戶部位？</h3>
        <p id={`${id}-ab-close-description`}>
          將對 Account A ({defaultAB.accountA.positions.length} 筆) 與 Account B ({defaultAB.accountB.positions.length} 筆) 提出平倉，並取消雙方所有待處理進場委託。
        </p>
        <div className="at-dialog-actions">
          <form method="dialog">
            <button type="submit" className="at-button" autoFocus>
              取消
            </button>
          </form>
          <button
            type="button"
            className="at-button at-danger"
            disabled={!canCloseAB}
            onClick={() => {
              abDialog.current?.close();
              if (canCloseAB) onCloseAllAB?.();
            }}
          >
            <X size={15} aria-hidden="true" />
            確認成對平倉
          </button>
        </div>
      </dialog>
    </div>
  );
}
