import {
  applyFunding,
  fetchAutoFundingHistory,
  valuate,
  type AccountId,
  type AutoFundingRecord,
  type PaperAccountState,
  type PaperFill,
  type PaperPosition,
} from '@fadachi/core';
import type { ModelPaperStore } from './store.ts';

const ONE_HOUR_MS = 3_600_000;
const EIGHT_HOURS_MS = 8 * ONE_HOUR_MS;
const TWO_MINUTES_MS = 2 * 60_000;

export interface FundingClock {
  now(): number;
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultFundingClock: FundingClock = {
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => {
    const t = setTimeout(fn, delayMs);
    t.unref();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface FundingSettlerOptions {
  store: ModelPaperStore;
  fetchFundingHistory?: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  clock?: FundingClock;
  getOwnedExperimentIds?: () => string[];
  getLastPrices?: () => Record<string, number>;
}

function hasPendingFundingBoundary(
  account: AccountId,
  positions: ReadonlyArray<PaperPosition>,
  fills: ReadonlyArray<PaperFill>,
  charges: ReadonlyArray<{ positionId: string; fundingTime: number }>,
  now: number,
): boolean {
  const entryByPos = new Map<string, PaperFill>();
  const exitByPos = new Map<string, PaperFill>();
  for (const f of fills) {
    if (f.account !== account) continue;
    const pos = positions.find(p => p.id === f.positionId);
    const isEntry = f.action ? f.action === 'ENTRY' : Boolean(pos && f.receivedAt === pos.openedAt);
    if (isEntry) entryByPos.set(f.positionId, f);
    else exitByPos.set(f.positionId, f);
  }

  for (const pos of positions) {
    if (pos.account !== account) continue;
    if (pos.status === 'CLOSED' && (pos.closedAt == null || pos.closedAt < now - EIGHT_HOURS_MS)) {
      continue;
    }
    const entryFill = entryByPos.get(pos.id);
    if (!entryFill) continue;
    const exitFill = exitByPos.get(pos.id);
    const isClosedWithExit = pos.status === 'CLOSED' && Boolean(exitFill);
    const endWindow = isClosedWithExit ? exitFill!.tradeTime : now;

    // First 8h UTC boundary strictly after entryFill.tradeTime
    const firstBoundary = (Math.floor(entryFill.tradeTime / EIGHT_HOURS_MS) + 1) * EIGHT_HOURS_MS;
    for (let b = firstBoundary; isClosedWithExit ? b < endWindow : b <= endWindow; b += EIGHT_HOURS_MS) {
      const settled = charges.some(
        c => c.positionId === pos.id && Math.abs(c.fundingTime - b) <= 60_000,
      );
      if (!settled) return true;
    }
  }
  return false;
}

export class FundingSettler {
  readonly store: ModelPaperStore;
  readonly fetchFundingHistory: (symbol: string, startTime: number, endTime: number) => Promise<AutoFundingRecord[]>;
  readonly clock: FundingClock;
  private readonly getOwnedExperimentIds: () => string[];
  private readonly getLastPrices: () => Record<string, number>;

  private timer: unknown = null;
  private running = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FundingSettlerOptions) {
    this.store = options.store;
    this.fetchFundingHistory = options.fetchFundingHistory ?? fetchAutoFundingHistory;
    this.clock = options.clock ?? defaultFundingClock;
    this.getOwnedExperimentIds = options.getOwnedExperimentIds ?? (() => []);
    this.getLastPrices = options.getLastPrices ?? (() => ({}));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const now = this.clock.now();
    const currentHourPlus2 = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS + TWO_MINUTES_MS;
    const nextRun = now < currentHourPlus2 ? currentHourPlus2 : currentHourPlus2 + ONE_HOUR_MS;
    const delay = Math.max(1, nextRun - now);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.settleAllOwned().finally(() => {
        if (this.running) this.scheduleNext();
      });
    }, delay);
  }

  settleAllOwned(): Promise<void> {
    const job = this.queue.then(async () => {
      for (const expId of this.getOwnedExperimentIds()) {
        try {
          await this.settleExperimentInternal(expId, undefined, { skipStopped: true });
        } catch (err) {
          console.error(`[ModelPaper] 資金費定時結算失敗 (${expId}):`, err);
        }
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  settleExperiment(experimentId: string, symbolsFilter?: string[]): Promise<void> {
    const job = this.queue.then(() =>
      this.settleExperimentInternal(experimentId, symbolsFilter, { skipStopped: false }),
    );
    this.queue = job.catch(() => {});
    return job;
  }

  private async settleExperimentInternal(
    experimentId: string,
    symbolsFilter?: string[],
    options: { skipStopped?: boolean } = {},
  ): Promise<void> {
    const now = this.clock.now();
    const exp = await this.store.getExperiment(experimentId);
    if (!exp) return;
    if (options.skipStopped && !['RUNNING', 'PAUSED', 'AWAITING_RESUME', 'STOPPING'].includes(exp.status)) {
      return;
    }
    if (
      !options.skipStopped &&
      !['RUNNING', 'PAUSED', 'AWAITING_RESUME', 'STOPPING', 'STOPPED'].includes(exp.status)
    ) {
      return;
    }

    const positions = await this.store.listPositions(experimentId);
    const fills = await this.store.listFills(experimentId);
    const filterSet = symbolsFilter?.length ? new Set(symbolsFilter.map(s => s.toUpperCase())) : null;

    // Symbols currently held or closed within past 8h
    const symbolStartTimes = new Map<string, number>();
    for (const pos of positions) {
      if (pos.status === 'CLOSED' && (pos.closedAt == null || pos.closedAt < now - EIGHT_HOURS_MS)) {
        continue;
      }
      if (filterSet && !filterSet.has(pos.symbol)) continue;
      const entryFill = fills.find(f => f.positionId === pos.id && (f.action === 'ENTRY' || f.receivedAt === pos.openedAt));
      const refTime = entryFill?.tradeTime ?? pos.openedAt;
      const prev = symbolStartTimes.get(pos.symbol);
      if (prev === undefined || refTime < prev) {
        symbolStartTimes.set(pos.symbol, refTime);
      }
    }

    const fetchedRecords: AutoFundingRecord[] = [];
    let fetchFailed = false;

    for (const [symbol, minTime] of symbolStartTimes.entries()) {
      const startMs = Math.max(0, Math.floor(minTime));
      const endMs = Math.floor(now);
      if (endMs < startMs) continue;
      try {
        const recs = await this.fetchFundingHistory(symbol, startMs, endMs);
        fetchedRecords.push(...recs);
      } catch (err) {
        fetchFailed = true;
        console.warn(`[ModelPaper] 取得 ${symbol} 資金費率失敗:`, err);
      }
    }

    const lastPrices = this.getLastPrices();

    await this.store.withTx(async (tx) => {
      const curExp = await this.store.getExperiment(experimentId, tx);
      if (!curExp) return;
      const accounts = await this.store.getAccounts(experimentId, tx);
      const txPositions = await this.store.listPositions(experimentId, undefined, undefined, tx);
      const txFills = await this.store.listFills(experimentId, undefined, tx);
      const txCharges = await this.store.listFunding(experimentId, undefined, tx);
      const txGaps = await this.store.listGaps(experimentId, tx);

      for (const accId of ['A', 'B'] as const) {
        const rawAcc: PaperAccountState = accounts[accId];
        const acc: PaperAccountState =
          rawAcc.stoppedThisHour.length > 0 &&
          Math.floor(rawAcc.updatedAt / ONE_HOUR_MS) < Math.floor(now / ONE_HOUR_MS)
            ? { ...rawAcc, stoppedThisHour: [] }
            : rawAcc;
        const accPositions = txPositions.filter(p => p.account === accId);
        const accFills = txFills.filter(f => f.account === accId);
        const accCharges = txCharges.filter(c => c.account === accId);
        const accGaps = txGaps.filter(g => g.account === accId || g.account === 'BOTH');

        const applied = applyFunding(
          acc,
          accPositions,
          accFills,
          accCharges,
          fetchedRecords,
          accGaps,
          now,
        );

        for (const ch of applied.charges) {
          await this.store.insertFundingIfAbsent(ch, tx);
        }

        const allChargesForAcc = [...accCharges, ...applied.charges];
        const hasActiveOrRecent = accPositions.some(
          p => p.status === 'OPEN' || (p.closedAt != null && p.closedAt >= now - EIGHT_HOURS_MS),
        );
        const boundaryPending = hasPendingFundingBoundary(
          accId,
          accPositions,
          accFills,
          allChargesForAcc,
          now,
        );
        applied.account.fundingPending = boundaryPending || (fetchFailed && hasActiveOrRecent);

        const openAccPos = accPositions.filter(p => p.status === 'OPEN');
        const val = valuate(applied.account, openAccPos, lastPrices);
        if (val.equity <= 1e-9) {
          applied.account.bankrupt = true;
          await this.store.cancelPendingEntries(experimentId, accId, 'BANKRUPT', tx);
        }

        await this.store.upsertAccount(applied.account, tx);

        if (applied.charges.length > 0) {
          await this.store.upsertEquityPoint(
            {
              experimentId,
              account: accId,
              ts: now,
              equity: val.equity,
              cash: applied.account.cash,
              reserved: applied.account.reserved,
              unrealized: val.unrealized,
              complete: val.complete,
            },
            tx,
          );
        }
      }
    });
  }
}
