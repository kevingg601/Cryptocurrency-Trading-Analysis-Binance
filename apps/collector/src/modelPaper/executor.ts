import { randomUUID } from 'node:crypto';
import {
  applyFill,
  checkStop,
  valuate,
  type AccountId,
  type AutoSymbolRules,
  type PaperAccountState,
  type PaperPosition,
} from '@fadachi/core';
import type { StreamStatusInfo } from '../binance/streams.ts';
import type { ModelPaperStore } from './store.ts';
import type { TradeBus, TradeBusTradeEvent } from './tradeBus.ts';

const ONE_HOUR_MS = 3_600_000;
const ONE_MINUTE_MS = 60_000;
const MONITOR_INTERVAL_MS = 1_000;
const MAX_SEEN_AGG_IDS_PER_SYMBOL = 10_000;

export interface ExecutorClock {
  now(): number;
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultExecutorClock: ExecutorClock = {
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => {
    const t = setTimeout(fn, delayMs);
    t.unref();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PaperExecutorOptions {
  store: ModelPaperStore;
  tradeBus: TradeBus;
  clock?: ExecutorClock;
  getOwnedExperimentIds: () => string[];
  getRules: () => Record<string, AutoSymbolRules>;
  onPositionClosed?: (experimentId: string, symbol: string) => Promise<void>;
  onExitFilled?: (params: {
    experimentId: string;
    account: AccountId;
    symbol: string;
    reason: string;
    now: number;
  }) => Promise<void>;
  onAwaitingResume?: (experimentId: string) => void;
}

function resetStoppedIfNewHour(account: PaperAccountState, now: number): PaperAccountState {
  if (
    account.stoppedThisHour.length > 0 &&
    Math.floor(account.updatedAt / ONE_HOUR_MS) < Math.floor(now / ONE_HOUR_MS)
  ) {
    return {
      ...account,
      stoppedThisHour: [],
    };
  }
  return account;
}

export class PaperExecutor {
  readonly store: ModelPaperStore;
  readonly tradeBus: TradeBus;
  readonly clock: ExecutorClock;
  private readonly getOwnedExperimentIds: () => string[];
  private readonly onPositionClosed?: PaperExecutorOptions['onPositionClosed'];
  private readonly onExitFilled?: PaperExecutorOptions['onExitFilled'];
  private readonly onAwaitingResume?: PaperExecutorOptions['onAwaitingResume'];

  private readonly seenAggIds = new Map<string, number[]>();
  private readonly seenAggIdSets = new Map<string, Set<number>>();
  private readonly lastPosTradeAt = new Map<string, number>();
  private readonly lastEquityAt = new Map<string, number>();
  private readonly lastPrices: Record<string, number> = {};

  private running = false;
  private hasStarted = false;
  private startedAt = 0;
  private hasConnectedStream = false;
  private initialConnectedAt = 0;
  private monitorGeneration = 0;
  private monitorTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private tradeListener: ((trade: TradeBusTradeEvent) => void) | null = null;
  private statusListener: ((status: StreamStatusInfo) => void) | null = null;

  constructor(options: PaperExecutorOptions) {
    this.store = options.store;
    this.tradeBus = options.tradeBus;
    this.clock = options.clock ?? defaultExecutorClock;
    this.getOwnedExperimentIds = options.getOwnedExperimentIds;
    this.onPositionClosed = options.onPositionClosed;
    this.onExitFilled = options.onExitFilled;
    this.onAwaitingResume = options.onAwaitingResume;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.hasStarted = true;
    this.monitorGeneration += 1;
    const now = this.clock.now();
    this.startedAt = now;
    const streamState = this.tradeBus.getStreamStatus();
    this.hasConnectedStream = streamState.status === 'connected' || Boolean(this.tradeBus.hasEverConnected?.());
    this.initialConnectedAt = this.hasConnectedStream ? now : 0;
    this.tradeListener = (trade) => {
      this.enqueue(() => this.handleTrade(trade));
    };
    this.statusListener = (status) => {
      if (status.status === 'connected' && !this.hasConnectedStream) {
        this.hasConnectedStream = true;
        this.initialConnectedAt = this.clock.now();
      }
    };
    this.tradeBus.on('trade', this.tradeListener);
    this.tradeBus.on('status', this.statusListener);
    this.scheduleMonitor(this.monitorGeneration);
  }

  stop(): void {
    this.running = false;
    this.monitorGeneration += 1;
    if (this.tradeListener) {
      this.tradeBus.off('trade', this.tradeListener);
      this.tradeListener = null;
    }
    if (this.statusListener) {
      this.tradeBus.off('status', this.statusListener);
      this.statusListener = null;
    }
    if (this.monitorTimer !== null) {
      this.clock.clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(work).catch((err) => {
      console.error('[ModelPaper] PaperExecutor error:', err);
    });
    this.queue = job;
    return job;
  }

  private scheduleMonitor(generation: number): void {
    if (!this.running || generation !== this.monitorGeneration) return;
    if (this.monitorTimer !== null) {
      this.clock.clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.monitorTimer = this.clock.setTimeout(() => {
      this.monitorTimer = null;
      this.enqueue(async () => {
        if (!this.running || generation !== this.monitorGeneration) return;
        await this.runMonitorTickInternal(this.clock.now());
      }).finally(() => {
        if (this.running && generation === this.monitorGeneration) {
          this.scheduleMonitor(generation);
        }
      });
    }, MONITOR_INTERVAL_MS);
  }

  private hasSeenAggId(symbol: string, aggId: number): boolean {
    return this.seenAggIdSets.get(symbol)?.has(aggId) ?? false;
  }

  private recordSeenAggId(symbol: string, aggId: number): void {
    let set = this.seenAggIdSets.get(symbol);
    let list = this.seenAggIds.get(symbol);
    if (!set || !list) {
      set = new Set();
      list = [];
      this.seenAggIdSets.set(symbol, set);
      this.seenAggIds.set(symbol, list);
    }
    set.add(aggId);
    list.push(aggId);
    while (list.length > MAX_SEEN_AGG_IDS_PER_SYMBOL) {
      const oldest = list.shift()!;
      set.delete(oldest);
    }
  }

  getLastPrices(): Record<string, number> {
    return { ...this.lastPrices, ...this.tradeBus.getLastPrices() };
  }

  async processTradeNow(trade: TradeBusTradeEvent): Promise<void> {
    return this.enqueue(() => this.handleTrade(trade));
  }

  async runMonitorTick(now = this.clock.now()): Promise<void> {
    return this.enqueue(() => this.runMonitorTickInternal(now));
  }

  private async handleTrade(rawTrade: TradeBusTradeEvent): Promise<void> {
    const symbol = rawTrade.symbol.toUpperCase();
    const trade: TradeBusTradeEvent = { ...rawTrade, symbol };
    if (!Number.isFinite(trade.price) || trade.price <= 0) return;

    // Duplicate (symbol, aggId) fill prevention
    if (this.hasSeenAggId(symbol, trade.aggId)) return;
    this.recordSeenAggId(symbol, trade.aggId);

    this.lastPrices[symbol] = trade.price;
    const allPrices = this.getLastPrices();

    const expIds = this.getOwnedExperimentIds();
    for (const expId of expIds) {
      const postFillHooks: Array<{
        account: AccountId;
        symbol: string;
        reason: string;
        closed: boolean;
        experimentRunning: boolean;
      }> = [];

      await this.store.withTx(async (tx) => {
        const exp = await this.store.getExperiment(expId, tx);
        if (!exp || !['RUNNING', 'PAUSED', 'AWAITING_RESUME', 'STOPPING'].includes(exp.status)) {
          return;
        }

        const accounts = await this.store.getAccounts(exp.id, tx);
        const allPositions = await this.store.listPositions(exp.id, undefined, 'OPEN', tx);
        const allPendingOrders = await this.store.listPendingOrders(exp.id, undefined, tx);
        const decisions = await this.store.listDecisions(exp.id, tx);
        const latestDecision = decisions.find(d => d.status === 'SUBMITTED') ?? decisions[0] ?? null;

        for (const accId of ['A', 'B'] as const) {
          let acc = resetStoppedIfNewHour(accounts[accId], trade.receivedAt);
          let accPositions: PaperPosition[] = allPositions.filter(p => p.account === accId);
          const accOrders = allPendingOrders.filter(o => o.account === accId && o.symbol === symbol);

          if (accPositions.some(p => p.symbol === symbol)) {
            const key = `${exp.id}:${accId}:${symbol}`;
            const prevTs = this.lastPosTradeAt.get(key) ?? 0;
            this.lastPosTradeAt.set(key, Math.max(prevTs, trade.receivedAt));
          }

          // 1. Evaluate eligible pending orders for this symbol
          for (const ord of accOrders) {
            if (ord.action === 'ENTRY') {
              if (trade.receivedAt >= ord.createdAt + exp.config.entryTimeoutMs) {
                await this.store.cancelOrder(ord.id, 'EXECUTION_FAILED', tx);
                continue;
              }
              if (exp.status !== 'RUNNING') {
                await this.store.cancelOrder(ord.id, exp.status, tx);
                continue;
              }
            }

            const eligibleByRecv = trade.receivedAt >= ord.createdAt + exp.config.fillDelayMs;
            const eligibleByTrade = trade.tradeTime >= ord.createdAt + exp.config.fillDelayMs;
            if (!eligibleByRecv || !eligibleByTrade) continue;

            // Extra DB-level guard against duplicate (account, symbol, aggId)
            const dupFill = await this.store.hasFillForAggId(exp.id, accId, symbol, trade.aggId, tx);
            if (dupFill) continue;

            const currentHour = Math.floor(trade.receivedAt / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
            const ordDecision = decisions.find(d => d.id === ord.decisionId);
            const res = applyFill(
              acc,
              accPositions,
              ord,
              {
                symbol,
                price: trade.price,
                aggId: trade.aggId,
                tradeTime: trade.tradeTime,
                receivedAt: trade.receivedAt,
              },
              exp.config,
              ordDecision?.decisionHour ?? latestDecision?.decisionHour ?? currentHour,
              allPrices,
            );

            if (res.rejectedReason) {
              await this.store.cancelOrder(ord.id, res.rejectedReason, tx);
              continue;
            }

            const inserted = await this.store.insertFillIfAbsent(res.fill!, tx);
            if (!inserted) continue;

            acc = res.account;
            accPositions = res.positions;

            await this.store.markOrderFilled(ord.id, res.fill!.positionId, tx);
            if (res.newPosition) {
              await this.store.upsertPosition(res.newPosition, tx);
              this.lastPosTradeAt.set(`${exp.id}:${accId}:${symbol}`, trade.receivedAt);
            }
            if (res.closedPosition) {
              await this.store.upsertPosition(res.closedPosition, tx);
              postFillHooks.push({
                account: accId,
                symbol,
                reason: ord.reason,
                closed: true,
                experimentRunning: exp.status === 'RUNNING',
              });
            }

            await this.store.upsertAccount(acc, tx);
            if (res.bankrupt) {
              await this.store.cancelPendingEntries(exp.id, accId, 'BANKRUPT', tx);
            }

            await this.store.upsertEquityPoint(
              {
                experimentId: exp.id,
                account: accId,
                ts: trade.receivedAt,
                equity: res.valuation.equity,
                cash: acc.cash,
                reserved: acc.reserved,
                unrealized: res.valuation.unrealized,
                complete: res.valuation.complete,
              },
              tx,
            );
            this.lastEquityAt.set(`${exp.id}:${accId}`, trade.receivedAt);
          }

          // 2. Check stop-loss on remaining open positions of this symbol
          const remainingSymbolPositions = accPositions.filter(
            p => p.status === 'OPEN' && p.symbol === symbol,
          );
          if (remainingSymbolPositions.length > 0) {
            this.lastPosTradeAt.set(`${exp.id}:${accId}:${symbol}`, trade.receivedAt);
          }
          const remainingPending = await this.store.listPendingOrders(exp.id, accId, tx);

          for (const pos of remainingSymbolPositions) {
            if (!checkStop(pos, trade.price)) continue;

            if (!acc.stoppedThisHour.includes(pos.symbol)) {
              acc = {
                ...acc,
                stoppedThisHour: [...acc.stoppedThisHour, pos.symbol],
                updatedAt: trade.receivedAt,
              };
            }

            const existingExit = remainingPending.find(
              o => o.action === 'EXIT' && o.positionId === pos.id,
            );
            if (existingExit) {
              if (existingExit.reason !== 'STOP_LOSS') {
                await this.store.upgradeOrderToStopLoss(
                  existingExit.id,
                  trade.receivedAt,
                  trade.price,
                  tx,
                );
              }
            } else {
              await this.store.insertOrderIfAbsent(
                {
                  id: `stop:${pos.id}`,
                  experimentId: exp.id,
                  account: accId,
                  decisionId: latestDecision?.id ?? `stop:${pos.id}`,
                  symbol: pos.symbol,
                  side: pos.side,
                  action: 'EXIT',
                  reason: 'STOP_LOSS',
                  qty: pos.qty,
                  refPrice: trade.price,
                  createdAt: trade.receivedAt,
                  status: 'PENDING',
                  cancelReason: null,
                  positionId: pos.id,
                },
                tx,
              );
            }
          }

          // Persist updated account if stoppedThisHour or UTC hour rollover changed
          if (
            acc.stoppedThisHour.length !== accounts[accId].stoppedThisHour.length ||
            acc.updatedAt !== accounts[accId].updatedAt
          ) {
            await this.store.upsertAccount(acc, tx);
          }
        }

        // 3. Check if STOPPING experiment has completely drained
        if (exp.status === 'STOPPING') {
          const leftOpen = await this.store.listPositions(exp.id, undefined, 'OPEN', tx);
          const leftPending = await this.store.listPendingOrders(exp.id, undefined, tx);
          if (leftOpen.length === 0 && leftPending.length === 0) {
            await this.store.updateExperimentStatus(
              exp.id,
              'STOPPED',
              { stoppedAt: trade.receivedAt, statusReason: '已全數平倉停止', heartbeatAt: trade.receivedAt },
              tx,
            );
          }
        }
      });

      // Run post-exit callbacks outside transaction (still serialized in executor queue)
      for (const hook of postFillHooks) {
        if (hook.closed && this.onPositionClosed) {
          await this.onPositionClosed(expId, hook.symbol).catch((err) => {
            console.error('[ModelPaper] 平倉後資金費結算失敗:', err);
          });
        }
        if (
          hook.closed &&
          hook.experimentRunning &&
          (hook.reason === 'REVERSED' || hook.reason === 'SIGNAL_GONE') &&
          this.onExitFilled
        ) {
          await this.onExitFilled({
            experimentId: expId,
            account: hook.account,
            symbol: hook.symbol,
            reason: hook.reason,
            now: trade.receivedAt,
          }).catch((err) => {
            console.error('[ModelPaper] 平倉後補單失敗:', err);
          });
        }
      }
    }
  }

  private async runMonitorTickInternal(now: number): Promise<void> {
    const expIds = this.getOwnedExperimentIds();
    const streamStatus = this.tradeBus.getStreamStatus().status;
    const streamConnected = streamStatus === 'connected';
    if (streamConnected && !this.hasConnectedStream) {
      this.hasConnectedStream = true;
      this.initialConnectedAt = Math.max(this.initialConnectedAt, now);
    }
    const allPrices = this.getLastPrices();

    for (const expId of expIds) {
      let triggeredAwaitingResume = false;

      await this.store.withTx(async (tx) => {
        const exp = await this.store.getExperiment(expId, tx);
        if (!exp || !['RUNNING', 'PAUSED', 'AWAITING_RESUME', 'STOPPING'].includes(exp.status)) {
          return;
        }

        // 1. Timeout pending ENTRY orders (> 60s)
        const pending = await this.store.listPendingOrders(exp.id, undefined, tx);
        for (const ord of pending) {
          if (ord.action === 'ENTRY' && now >= ord.createdAt + exp.config.entryTimeoutMs) {
            await this.store.cancelOrder(ord.id, 'EXECUTION_FAILED', tx);
          }
        }

        const accounts = await this.store.getAccounts(exp.id, tx);
        const openPositions = await this.store.listPositions(exp.id, undefined, 'OPEN', tx);
        const inStartupConnectGrace =
          !streamConnected &&
          this.hasStarted &&
          !this.hasConnectedStream &&
          now - this.startedAt <= exp.config.staleMs;

        for (const accId of ['A', 'B'] as const) {
          let acc = resetStoppedIfNewHour(accounts[accId], now);
          const accOpen = openPositions.filter(p => p.account === accId);

          let staleReason: string | null = null;
          if (!streamConnected) {
            if (!inStartupConnectGrace) {
              staleReason = `futures 串流狀態為 ${streamStatus}`;
            }
          } else {
            for (const pos of accOpen) {
              const busTrade = this.tradeBus.getLastTrade(pos.symbol);
              const memLast = this.lastPosTradeAt.get(`${exp.id}:${accId}:${pos.symbol}`) ?? 0;
              const lastRecv = Math.max(
                pos.openedAt,
                busTrade?.receivedAt ?? 0,
                memLast,
                this.startedAt,
                this.initialConnectedAt,
              );
              if (now - lastRecv > exp.config.staleMs) {
                staleReason = `${pos.symbol} 超過 ${Math.round(exp.config.staleMs / 1000)} 秒無新成交`;
                break;
              }
            }
          }

          const isUnhealthy = staleReason !== null;
          const val = valuate(acc, accOpen, allPrices);
          let accDirty = false;
          if (!acc.bankrupt && val.equity <= 1e-9) {
            acc = { ...acc, bankrupt: true, updatedAt: now };
            accDirty = true;
            await this.store.cancelPendingEntries(exp.id, accId, 'BANKRUPT', tx);
          }

          if (!acc.degraded && isUnhealthy) {
            acc = { ...acc, degraded: true, updatedAt: now };
            await this.store.upsertAccount(acc, tx);
            await this.store.insertGap(
              {
                id: `gap-${exp.id}-${accId}-${now}-${randomUUID().slice(0, 6)}`,
                experimentId: exp.id,
                account: accId,
                kind: !streamConnected ? 'STREAM_DISCONNECTED' : 'STALE_MARKET',
                startedAt: now,
                endedAt: null,
                detail: staleReason,
              },
              tx,
            );
          } else if (acc.degraded && !isUnhealthy && streamConnected) {
            acc = { ...acc, degraded: false, updatedAt: now };
            await this.store.upsertAccount(acc, tx);
            await this.store.closeOpenGaps(exp.id, accId, now, tx);
            if (exp.status === 'RUNNING') {
              triggeredAwaitingResume = true;
            }
          } else if (accDirty || acc.stoppedThisHour.length !== accounts[accId].stoppedThisHour.length) {
            acc = { ...acc, updatedAt: now };
            await this.store.upsertAccount(acc, tx);
          }

          // 3. Record 1-minute equity point
          const eqKey = `${exp.id}:${accId}`;
          const lastEq = this.lastEquityAt.get(eqKey) ?? 0;
          if (now - lastEq >= ONE_MINUTE_MS) {
            await this.store.upsertEquityPoint(
              {
                experimentId: exp.id,
                account: accId,
                ts: now,
                equity: val.equity,
                cash: acc.cash,
                reserved: acc.reserved,
                unrealized: val.unrealized,
                complete: val.complete,
              },
              tx,
            );
            this.lastEquityAt.set(eqKey, now);
          }
        }

        if (triggeredAwaitingResume) {
          await this.store.updateExperimentStatus(
            exp.id,
            'AWAITING_RESUME',
            { statusReason: '行情串流或標的報價中斷恢復，請確認後繼續測試', heartbeatAt: now },
            tx,
          );
          await this.store.cancelPendingEntries(exp.id, null, 'AWAITING_RESUME', tx);
        } else if (exp.status === 'STOPPING') {
          const leftOpen = await this.store.listPositions(exp.id, undefined, 'OPEN', tx);
          const leftPending = await this.store.listPendingOrders(exp.id, undefined, tx);
          if (leftOpen.length === 0 && leftPending.length === 0) {
            await this.store.updateExperimentStatus(
              exp.id,
              'STOPPED',
              { stoppedAt: now, statusReason: '已全數平倉停止', heartbeatAt: now },
              tx,
            );
          }
        }
      });

      if (triggeredAwaitingResume && this.onAwaitingResume) {
        this.onAwaitingResume(expId);
      }
    }
  }
}
