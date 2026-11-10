import type { MarketType } from '../market/types.ts';
import type { MarketTradeFrame } from '../market/marketEvents.ts';
import {
  AutoTradingEngine,
  calculateAutoMetrics,
  isAutoTradingActive,
} from './autoTrading.ts';
import type {
  AutoFundingRecord,
  AutoSymbolRules,
} from './autoTradingMarket.ts';
import type {
  AutoTradingConfig,
  AutoTradingNotification,
} from './autoTrading.ts';
import type {
  ABTradingBatch,
  ABComparisonMetrics,
  AIAnalysisResult,
  AIDecisionReason,
  AIEntryDecision,
} from '../ai/aiTypes.ts';
import { cloneWithInfinity } from '../ai/abSerialization.ts';

export class ABComparisonCoordinator {
  private engineA: AutoTradingEngine;
  private engineB: AutoTradingEngine;
  private batchId: string;
  private marketType: MarketType;
  private status: ABTradingBatch['status'] = 'IDLE';
  private startedAt = 0;
  private endedAt: number | undefined;
  private reason: string | undefined;
  private config: AutoTradingConfig;
  private selectedCoins: string[] = ['BTCUSDT', 'ETHUSDT'];
  private model = 'gemini-2.5-flash';
  private promptVersion = 'prompt-v1';
  private ruleVersion = 'rule-v1';
  private decisions: AIEntryDecision[] = [];
  private evaluatedPlanIds = new Set<string>();
  private activeAnalyses = new Map<string, AIAnalysisResult>();
  private analysisAvailableAt = new Map<string, number>();
  private lastTrades = new Map<string, { timestamp: number; id?: number }>();
  private lastReceivedAt = -Infinity;
  private streamHealthy = false;
  private engineRevisions = [-1, -1];
  private sequence = 0;
  private rules: Record<string, AutoSymbolRules> = {};
  private notifications: AutoTradingNotification[] = [];
  revision = 0;

  constructor(market: MarketType) {
    this.marketType = market;
    this.engineA = new AutoTradingEngine(market);
    this.engineB = new AutoTradingEngine(market);
    this.config = this.engineA.snapshot().config;
    this.batchId = 'idle';
  }

  setRules(rules: Record<string, AutoSymbolRules>) {
    const normalized: Record<string, AutoSymbolRules> = {};
    for (const [k, v] of Object.entries(rules)) {
      normalized[k] = v;
      normalized[k.toUpperCase()] = v;
    }
    this.rules = structuredClone(normalized);
    this.engineA.setRules(normalized);
    this.engineB.setRules(normalized);
  }

  setStreamHealthy(healthy: boolean, now: number, interruptedSince?: number) {
    this.streamHealthy = healthy;
    this.engineA.setStreamHealthy(healthy, now, interruptedSince);
    this.engineB.setStreamHealthy(healthy, now, interruptedSince);
    this.checkSyncStatus(now);
  }

  tick(now: number) {
    this.engineA.tick(now);
    this.engineB.tick(now);
    this.checkSyncStatus(now);
  }

  updateAnalysis(analysis: AIAnalysisResult, availableAt = Date.now()) {
    if (analysis.marketType === this.marketType) {
      const symbol = analysis.symbol.trim().toUpperCase();
      const existing = this.activeAnalyses.get(symbol);
      if (existing && (existing.id === analysis.id || existing.generatedAt > analysis.generatedAt)) return;
      this.activeAnalyses.set(symbol, structuredClone(analysis));
      this.analysisAvailableAt.set(symbol, availableAt);
      this.revision++;
    }
  }

  getAnalysis(symbol: string): AIAnalysisResult | undefined {
    const analysis = this.activeAnalyses.get(symbol.trim().toUpperCase());
    return analysis ? structuredClone(analysis) : undefined;
  }

  getAllAnalyses(): AIAnalysisResult[] {
    return structuredClone(Array.from(this.activeAnalyses.values()));
  }

  start(
    config: AutoTradingConfig,
    selectedCoins: string[],
    model: string,
    now: number,
    signalSettings?: Record<string, number>,
    promptVersion = 'prompt-v1',
    ruleVersion = 'rule-v1'
  ) {
    if (isAutoTradingActive(this.status)) {
      throw new Error('請先結束目前 A/B 評估批次');
    }

    const uniqueCoins = Array.from(new Set((selectedCoins || []).map(s => s.trim().toUpperCase()).filter(Boolean)));
    if (!uniqueCoins.length) {
      throw new Error('請至少選擇一個追蹤幣種');
    }
    if (uniqueCoins.length > 10) {
      throw new Error('A/B 對照模式追蹤幣種上限為 10 個');
    }

    // Validate/start the engines before publishing a running pair.
    this.engineA.start(config, now, signalSettings);
    this.engineB.start(config, now, signalSettings);

    // Lock parameters for the entire batch
    this.selectedCoins = uniqueCoins;
    this.model = model;
    this.promptVersion = promptVersion;
    this.ruleVersion = ruleVersion;
    this.config = { ...config };
    this.status = 'RUNNING';
    this.startedAt = now;
    this.endedAt = undefined;
    this.reason = undefined;
    this.batchId = `ab-${this.marketType}-${now}-${globalThis.crypto.randomUUID()}`;
    this.decisions = [];
    this.evaluatedPlanIds.clear();
    this.lastTrades.clear();
    this.lastReceivedAt = now;
    this.notifications = [];
    this.revision++;

    this.checkSyncStatus(now);
  }

  pause(now: number) {
    if (this.status !== 'RUNNING') return;
    this.status = 'PAUSED';
    this.engineA.pause(now);
    this.engineB.pause(now);
    this.revision++;
  }

  resume(now: number) {
    if (this.status !== 'PAUSED') return;
    if (!this.streamHealthy || this.engineA.snapshot().status !== 'PAUSED'
      || this.engineB.snapshot().status !== 'PAUSED') return;
    this.engineA.resume(now);
    this.engineB.resume(now);
    if (this.engineA.snapshot().status !== 'RUNNING' || this.engineB.snapshot().status !== 'RUNNING') {
      this.engineA.pause(now);
      this.engineB.pause(now);
      return;
    }
    this.status = 'RUNNING';
    this.revision++;
  }

  drain(now: number) {
    if (!isAutoTradingActive(this.status)) return;
    this.status = 'DRAINING';
    this.engineA.drain(now);
    this.engineB.drain(now);
    this.revision++;
    this.checkSyncStatus(now);
  }

  closeAll(now: number) {
    if (!isAutoTradingActive(this.status)) return;
    this.status = 'DRAINING';
    this.engineA.closeAll(now);
    this.engineB.closeAll(now);
    this.revision++;
    this.checkSyncStatus(now);
  }

  interrupt(now: number, reason: string) {
    if (!isAutoTradingActive(this.status)) return;
    this.status = 'INTERRUPTED';
    this.endedAt = now;
    this.reason = reason;
    this.engineA.interrupt(now, reason);
    this.engineB.interrupt(now, reason);
    this.revision++;
  }

  restoreInterrupted(batch: ABTradingBatch, now: number) {
    this.batchId = batch.id;
    this.marketType = batch.marketType;
    this.status = batch.status;
    this.startedAt = batch.startedAt;
    this.endedAt = batch.endedAt;
    this.reason = batch.reason;
    this.config = structuredClone(batch.config);
    this.selectedCoins = [...batch.selectedCoins];
    this.model = batch.model;
    this.promptVersion = batch.promptVersion;
    this.ruleVersion = batch.ruleVersion;
    this.decisions = structuredClone(batch.decisions);
    this.evaluatedPlanIds = new Set(this.decisions.map(d => d.planId));
    this.revision = batch.revision;

    this.engineA = new AutoTradingEngine(batch.marketType);
    this.engineA.restoreInterrupted(cloneWithInfinity(batch.accountA), now);

    this.engineB = new AutoTradingEngine(batch.marketType);
    this.engineB.restoreInterrupted(cloneWithInfinity(batch.accountB), now);

    if (isAutoTradingActive(this.status)) {
      this.interrupt(now, '程式重新啟動，前次 A/B 評估已中斷');
    }
  }

  applyFunding(records: AutoFundingRecord[], through: number, now: number) {
    this.engineA.applyFunding(records, through, now);
    this.engineB.applyFunding(records, through, now);
    this.revision++;
  }

  fundingFailed(now: number) {
    this.engineA.fundingFailed(now);
    this.engineB.fundingFailed(now);
    this.revision++;
  }

  processFrame(frame: MarketTradeFrame) {
    if (!isAutoTradingActive(this.status)) return;

    // Both engines receive exactly the same trade, tick, timestamp and market health
    const now = frame.receivedAt;
    const { trade } = frame;
    if (frame.marketType !== this.marketType || !Number.isFinite(now) || now < this.lastReceivedAt
      || !Number.isFinite(trade.price) || trade.price <= 0 || !Number.isFinite(trade.timestamp)
      || Math.abs(now - trade.timestamp) > 5_000) return;
    const last = this.lastTrades.get(trade.symbol);
    if (last && (trade.timestamp < last.timestamp || (trade.lastTradeId !== undefined && last.id !== undefined
      ? trade.lastTradeId <= last.id : trade.timestamp === last.timestamp))) return;
    this.lastTrades.set(trade.symbol, { timestamp: trade.timestamp, id: trade.lastTradeId });
    this.lastReceivedAt = now;

    // Evaluate confirmations for both accounts with fair comparison
    // Both accounts must evaluate the SAME tracked coins (this.selectedCoins)
    const allowedConfirmationsForA: typeof frame.confirmations = [];
    const allowedConfirmationsForB: typeof frame.confirmations = [];

    for (const item of frame.confirmations) {
      const { plan, event } = item;
      if (event.type !== 'follow-confirmed' || plan.state !== 'CONFIRMED') continue;

      // Incompatible market or spot short is unsupported by the strategy engine
      if (plan.marketType !== this.marketType || (this.marketType === 'spot' && plan.side === 'SHORT')) {
        continue;
      }

      const symbolUpper = plan.symbol.trim().toUpperCase();
      const isTracked = this.selectedCoins.includes(symbolUpper);

      if (!this.evaluatedPlanIds.has(plan.id)) {
        this.evaluatedPlanIds.add(plan.id);

        let allowed = false;
        let reason: AIDecisionReason;
        let explanation: string;
        let analysisAvailable = false;
        const confirmedAt = plan.confirmedAt ?? now;

        if (!isTracked) {
          reason = 'NOT_TRACKED';
          explanation = `幣種 ${plan.symbol} 未在 A/B 追蹤名單中`;
        } else {
          const analysis = this.activeAnalyses.get(symbolUpper);

          if (!analysis) {
            reason = 'NO_ANALYSIS';
            explanation = '入場確認時尚未收到 AI 分析結果';
          } else if (!Number.isFinite(analysis.generatedAt) || analysis.generatedAt > confirmedAt
            || (this.analysisAvailableAt.get(symbolUpper) ?? Infinity) > confirmedAt) {
            reason = 'WAITING';
            explanation = '入場確認時尚未取得此分析，不得使用未來結果';
          } else if (analysis.model !== this.model || analysis.promptVersion !== this.promptVersion || analysis.ruleVersion !== this.ruleVersion) {
            reason = 'MISMATCH';
            explanation = '分析模型或提示／規則版本與批次鎖定設定不符';
          } else if (!Array.isArray(analysis.missingData)
            || analysis.missingData.some(key => ['market_price', 'klines_sufficient', 'indicators_basic'].includes(key))) {
            reason = 'DATA_INCOMPLETE';
            explanation = '分析缺少必要行情或技術資料，不予開倉';
          } else if (!Number.isFinite(analysis.expiresAt) || now >= analysis.expiresAt) {
            reason = 'EXPIRED';
            explanation = `AI 分析已過期（有效至 ${new Date(analysis.expiresAt).toLocaleTimeString()}）`;
          } else if (analysis.direction === 'NEUTRAL') {
            analysisAvailable = true;
            reason = 'NEUTRAL';
            explanation = 'AI 分析建議觀望，不予開倉';
          } else if (analysis.direction !== plan.side) {
            analysisAvailable = true;
            reason = 'MISMATCH';
            explanation = `AI 分析方向為 ${analysis.direction}，與訊號方向 ${plan.side} 不符`;
          } else {
            // Permission granted!
            allowed = true;
            analysisAvailable = true;
            reason = 'ACCEPTED';
            explanation = `AI 分析確認相符 (${analysis.model})，許可開倉`;
          }
        }

        const currentAnalysis = this.activeAnalyses.get(symbolUpper);
        const decision: AIEntryDecision = {
          id: `dec-${plan.id}-${++this.sequence}`,
          batchId: this.batchId,
          planId: plan.id,
          symbol: plan.symbol,
          marketType: plan.marketType,
          account: 'B',
          allowed,
          analysisAvailable,
          reason,
          analysisId: currentAnalysis?.id,
          snapshotId: currentAnalysis?.snapshotId,
          model: currentAnalysis?.model ?? this.model,
          expiresAt: currentAnalysis?.expiresAt,
          timestamp: now,
          confirmedSide: plan.side,
          analysisDirection: currentAnalysis?.direction,
          explanation,
        };

        this.decisions.push(decision);
        this.revision++;

        // Engine A: baseline strategy on the selected tracked coins
        if (isTracked) {
          allowedConfirmationsForA.push(item);
        }
        // Engine B: AI-gated strategy on the selected tracked coins
        if (allowed) {
          allowedConfirmationsForB.push(item);
        }
      } else {
        // If already evaluated for this plan, keep previous decisions
        if (isTracked) {
          allowedConfirmationsForA.push(item);
        }
        const existing = this.decisions.find(d => d.planId === plan.id);
        if (existing?.allowed) {
          allowedConfirmationsForB.push(item);
        }
      }
    }

    // Engine A processes the frame with confirmations limited to selected tracked coins
    const frameA: MarketTradeFrame = {
      ...frame,
      confirmations: allowedConfirmationsForA,
    };
    this.engineA.processFrame(frameA);

    // Engine B processes the frame with only AI-permitted confirmations on tracked coins
    const frameB: MarketTradeFrame = {
      ...frame,
      confirmations: allowedConfirmationsForB,
    };
    this.engineB.processFrame(frameB);

    this.checkSyncStatus(now);
  }

  takeNotifications(): AutoTradingNotification[] {
    const fromA = this.engineA.takeNotifications().map(n => ({
      ...n,
      id: `${this.batchId}-A-${n.id}`,
      title: `[A 基準] ${n.title}`,
    }));
    const fromB = this.engineB.takeNotifications().map(n => ({
      ...n,
      id: `${this.batchId}-B-${n.id}`,
      title: `[B AI] ${n.title}`,
    }));
    const combined = [...fromA, ...fromB, ...this.notifications];
    this.notifications = [];
    return combined;
  }

  private checkSyncStatus(now: number) {
    if (this.engineRevisions[0] !== this.engineA.revision || this.engineRevisions[1] !== this.engineB.revision) {
      this.engineRevisions = [this.engineA.revision, this.engineB.revision];
      this.revision++;
    }
    const snapA = this.engineA.snapshot();
    const snapB = this.engineB.snapshot();

    // If either interrupted, interrupt the pair
    if (snapA.status === 'INTERRUPTED' || snapB.status === 'INTERRUPTED') {
      if (this.status !== 'INTERRUPTED') {
        const reason = snapA.reason || snapB.reason || '子引擎異常中斷';
        this.interrupt(now, reason);
      }
      return;
    }

    // If draining and both completed, complete pair
    if (this.status === 'DRAINING' && snapA.status === 'COMPLETED' && snapB.status === 'COMPLETED') {
      this.status = 'COMPLETED';
      this.endedAt = now;
      this.revision++;
    }
  }

  snapshot(): ABTradingBatch {
    return {
      schemaVersion: 1,
      id: this.batchId,
      marketType: this.marketType,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      reason: this.reason,
      config: structuredClone(this.config),
      selectedCoins: [...this.selectedCoins],
      model: this.model,
      promptVersion: this.promptVersion,
      ruleVersion: this.ruleVersion,
      revision: this.revision,
      accountA: { ...cloneWithInfinity(this.engineA.snapshot()), id: `${this.batchId}-A` },
      accountB: { ...cloneWithInfinity(this.engineB.snapshot()), id: `${this.batchId}-B` },
      decisions: structuredClone(this.decisions),
    };
  }

  calculateMetrics(): ABComparisonMetrics {
    const snapA = this.engineA.snapshot();
    const snapB = this.engineB.snapshot();
    const metricsA = calculateAutoMetrics(snapA);
    const metricsB = calculateAutoMetrics(snapB);

    const durationMs = (this.endedAt ?? (this.startedAt ? Date.now() : 0)) - this.startedAt;

    const skipReasonsCount: Record<AIDecisionReason, number> = {
      ACCEPTED: 0,
      WAITING: 0,
      FAILED: 0,
      EXPIRED: 0,
      MISMATCH: 0,
      NEUTRAL: 0,
      NO_ANALYSIS: 0,
      NOT_TRACKED: 0,
      DATA_INCOMPLETE: 0,
    };

    let allowedCount = 0;
    let blockedCount = 0;

    for (const d of this.decisions) {
      skipReasonsCount[d.reason] = (skipReasonsCount[d.reason] || 0) + 1;
      if (d.allowed) {
        allowedCount++;
      } else {
        blockedCount++;
      }
    }

    const totalSignals = this.decisions.length;
    const coveredCount = this.decisions.filter(d => d.analysisAvailable
      ?? (d.reason === 'ACCEPTED' || d.reason === 'NEUTRAL' || d.reason === 'MISMATCH')).length;
    const coveragePct = totalSignals > 0 ? (coveredCount / totalSignals) * 100 : 0;

    // Track performance in Account A of signals that were blocked in Account B
    const blockedSignalsInA = this.decisions
      .filter(d => !d.allowed)
      .map(d => {
        const matchingTrade = snapA.trades.find(t => t.planId === d.planId);
        const matchingPosition = snapA.positions.find(p => p.planId === d.planId);
        const executedInA = Boolean(matchingTrade || matchingPosition);
        let tradeNetPnlInA = matchingTrade?.netPnl;
        const tradeWinInA = matchingTrade ? matchingTrade.netPnl > 0 : undefined;
        if (!matchingTrade && matchingPosition) {
          const dir = matchingPosition.side === 'LONG' ? 1 : -1;
          const unrealized = dir * (matchingPosition.currentPrice - matchingPosition.entryPrice) * matchingPosition.remainingQuantity;
          tradeNetPnlInA = matchingPosition.realizedPnl + unrealized - matchingPosition.entryFee
            - matchingPosition.exitFees - matchingPosition.funding;
        }
        return {
          planId: d.planId,
          symbol: d.symbol,
          side: d.confirmedSide,
          confirmedAt: d.timestamp,
          decisionReason: d.reason,
          tradeNetPnlInA,
          tradeWinInA,
          executedInA,
        };
      });

    return {
      durationMs: Math.max(0, durationMs),
      accountA: {
        equity: metricsA.equity,
        returnPct: metricsA.returnPct,
        realizedPnl: metricsA.realizedPnl,
        unrealizedPnl: metricsA.unrealizedPnl,
        fees: metricsA.fees,
        funding: metricsA.funding,
        maxDrawdownPct: metricsA.maxDrawdownPct,
        completedTrades: metricsA.completedTrades,
        winRate: metricsA.winRate,
        profitFactor: metricsA.profitFactor,
      },
      accountB: {
        equity: metricsB.equity,
        returnPct: metricsB.returnPct,
        realizedPnl: metricsB.realizedPnl,
        unrealizedPnl: metricsB.unrealizedPnl,
        fees: metricsB.fees,
        funding: metricsB.funding,
        maxDrawdownPct: metricsB.maxDrawdownPct,
        completedTrades: metricsB.completedTrades,
        winRate: metricsB.winRate,
        profitFactor: metricsB.profitFactor,
      },
      performanceDelta: {
        returnPctDelta: metricsB.returnPct - metricsA.returnPct,
        equityDelta: metricsB.equity - metricsA.equity,
        drawdownReductionPct: metricsA.maxDrawdownPct - metricsB.maxDrawdownPct,
        costSavings: (metricsA.fees + metricsA.funding) - (metricsB.fees + metricsB.funding),
        tradeCountDelta: metricsB.completedTrades - metricsA.completedTrades,
      },
      aiCoverage: {
        totalSignals,
        allowedSignals: allowedCount,
        blockedSignals: blockedCount,
        coveragePct,
        skipReasons: skipReasonsCount,
      },
      blockedSignalsInA,
    };
  }

  static exportCsvFromBatch(snap: ABTradingBatch): string {
    interface CsvRow {
      timestamp: number;
      line: string;
    }
    const rows: CsvRow[] = [];

    const quote = (val: unknown) => {
      let s = String(val ?? '');
      if (typeof val === 'string' && /^[\s]*[=+\-@]/.test(s)) {
        s = `'${s}`;
      }
      return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const accountCutoffs = [snap.accountA, snap.accountB].map(account => account.equity.at(-1)?.timestamp)
      .filter((timestamp): timestamp is number => Number.isFinite(timestamp));
    const commonCutoff = accountCutoffs.length ? Math.min(...accountCutoffs) : snap.startedAt;
    const accountStates = ([['A', snap.accountA], ['B', snap.accountB]] as const).map(([accountName, account]) => {
      const incompletePositions = account.positions.filter(position => position.incomplete).length;
      const incompleteTrades = account.trades.filter(trade => trade.incomplete).length;
      const incomplete = account.fundingStatus === 'PENDING' || account.fundingStatus === 'ERROR'
        || account.positions.length > 0 || account.orders.length > 0 || incompleteTrades > 0
        || account.status === 'INTERRUPTED';
      return { accountName, account, incompletePositions, incompleteTrades, incomplete };
    });
    const pairCostStatus = accountStates.every(state => !state.incomplete) ? 'COMPLETE' : 'PROVISIONAL';
    const accountMetadata = accountStates.map(({ accountName, account, incompletePositions, incompleteTrades, incomplete }) => {
      return [
        quote(snap.id),
        'BATCH_METADATA',
        accountName,
        quote(new Date(commonCutoff).toISOString()),
        '', '',
        'METADATA',
        'COST_STATUS',
        '', '', '', '', '', '', '', '', '',
        quote(JSON.stringify({
          metadataVersion: 1,
          fundingStatus: account.fundingStatus,
          incomplete,
          incompletePositions,
          openPositions: account.positions.length,
          pendingOrders: account.orders.length,
          incompleteTrades,
          commonCutoff,
          commonCutoffUtc: new Date(commonCutoff).toISOString(),
          pairCostStatus,
        })),
      ].join(',');
    });

    // 1. Decisions
    for (const d of snap.decisions) {
      rows.push({
        timestamp: d.timestamp,
        line: [
          quote(snap.id),
          'DECISION',
          'B',
          quote(new Date(d.timestamp).toISOString()),
          quote(d.symbol),
          quote(d.confirmedSide),
          d.allowed ? 'PERMITTED' : 'BLOCKED',
          quote(d.reason),
          '', '', '', '', '', '',
          quote(d.allowed),
          quote(d.model),
          quote(d.analysisDirection),
          quote(d.explanation)
        ].join(','),
      });
    }

    // 2. Account A Fills
    for (const f of snap.accountA.fills) {
      rows.push({
        timestamp: f.timestamp,
        line: [
          quote(snap.id),
          'FILL',
          'A',
          quote(new Date(f.timestamp).toISOString()),
          quote(f.symbol),
          quote(f.side),
          quote(f.action),
          quote(f.reason),
          quote(f.price),
          quote(f.quantity),
          quote(f.fee),
          quote(f.grossPnl),
          '', '', '', '', '',
          quote(`Account A fill: ${f.action} ${f.quantity} @ ${f.price}`)
        ].join(','),
      });
    }

    // 3. Account B Fills
    for (const f of snap.accountB.fills) {
      rows.push({
        timestamp: f.timestamp,
        line: [
          quote(snap.id),
          'FILL',
          'B',
          quote(new Date(f.timestamp).toISOString()),
          quote(f.symbol),
          quote(f.side),
          quote(f.action),
          quote(f.reason),
          quote(f.price),
          quote(f.quantity),
          quote(f.fee),
          quote(f.grossPnl),
          '', '', '', '', '',
          quote(`Account B fill: ${f.action} ${f.quantity} @ ${f.price}`)
        ].join(','),
      });
    }

    // 4. Account A Closed Trades
    for (const t of snap.accountA.trades) {
      rows.push({
        timestamp: t.closedAt,
        line: [
          quote(snap.id),
          'TRADE',
          'A',
          quote(new Date(t.closedAt).toISOString()),
          quote(t.symbol),
          quote(t.side),
          'CLOSED',
          quote(t.reason),
          quote(t.exitPrice),
          quote(t.quantity),
          quote(t.fees),
          quote(t.grossPnl),
          quote(t.funding),
          quote(t.netPnl),
          '', '', '',
          quote(`Account A trade net PnL: ${t.netPnl.toFixed(4)}`)
        ].join(','),
      });
    }

    // 5. Account B Closed Trades
    for (const t of snap.accountB.trades) {
      rows.push({
        timestamp: t.closedAt,
        line: [
          quote(snap.id),
          'TRADE',
          'B',
          quote(new Date(t.closedAt).toISOString()),
          quote(t.symbol),
          quote(t.side),
          'CLOSED',
          quote(t.reason),
          quote(t.exitPrice),
          quote(t.quantity),
          quote(t.fees),
          quote(t.grossPnl),
          quote(t.funding),
          quote(t.netPnl),
          '', '', '',
          quote(`Account B trade net PnL: ${t.netPnl.toFixed(4)}`)
        ].join(','),
      });
    }

    // Interleave all events along a common chronological timeline
    rows.sort((a, b) => a.timestamp - b.timestamp);

    // Header
    const header = [
      'batch_id', 'record_type', 'account', 'timestamp_utc', 'symbol', 'side',
      'action_or_state', 'reason', 'price', 'quantity', 'fee', 'gross_pnl',
      'funding', 'net_pnl', 'ai_allowed', 'ai_model', 'ai_direction', 'message'
    ].join(',');

    return [header, ...accountMetadata, ...rows.map(r => r.line)].join('\n');
  }

  exportCsv(): string {
    return ABComparisonCoordinator.exportCsvFromBatch(this.snapshot());
  }
}
