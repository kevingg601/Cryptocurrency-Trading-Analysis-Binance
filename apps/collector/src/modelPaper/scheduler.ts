import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  buildSignals,
  fillSlots,
  reconcile,
  type AccountId,
  type AutoSymbolRules,
  type ModelPaperExperimentRecord,
  type PaperAccountState,
  type Signal,
} from '@fadachi/core';
import { ModelResearchBusyError } from '../research/modelResearchRunner.ts';
import type { ForwardInferenceCoordinator } from './forwardInference.ts';
import { DataNotReadyError } from './marketCache.ts';
import type { ModelPaperStore } from './store.ts';
import type { TradeBus } from './tradeBus.ts';

const ONE_HOUR_MS = 3_600_000;

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultSchedulerClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => {
    const t = setTimeout(fn, delayMs);
    t.unref();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ForwardSchedulerOptions {
  store: ModelPaperStore;
  tradeBus: TradeBus;
  forwardInference: ForwardInferenceCoordinator;
  getRules: () => Promise<Record<string, AutoSymbolRules>>;
  isLeaseOwned: (experimentId: string) => boolean;
  onStateChanged?: () => void;
  clock?: SchedulerClock;
}

interface ExperimentTimers {
  hourlyTimer: unknown | null;
  retryTimer: unknown | null;
  nextScheduleAt: number | null;
}

export class ForwardScheduler {
  readonly store: ModelPaperStore;
  readonly tradeBus: TradeBus;
  readonly forwardInference: ForwardInferenceCoordinator;
  readonly clock: SchedulerClock;
  private readonly getRules: () => Promise<Record<string, AutoSymbolRules>>;
  private readonly isLeaseOwned: (experimentId: string) => boolean;
  private readonly onStateChanged?: () => void;

  private readonly timers = new Map<string, ExperimentTimers>();
  private readonly inFlightHours = new Set<string>();
  private readonly inFlightPromises = new Set<Promise<void>>();
  private activeInferenceExperimentId: string | null = null;

  constructor(options: ForwardSchedulerOptions) {
    this.store = options.store;
    this.tradeBus = options.tradeBus;
    this.forwardInference = options.forwardInference;
    this.getRules = options.getRules;
    this.isLeaseOwned = options.isLeaseOwned;
    this.onStateChanged = options.onStateChanged;
    this.clock = options.clock ?? defaultSchedulerClock;
  }

  start(experimentId: string, options: { runImmediate?: boolean } = {}): void {
    this.stop(experimentId);
    const state: ExperimentTimers = {
      hourlyTimer: null,
      retryTimer: null,
      nextScheduleAt: null,
    };
    this.timers.set(experimentId, state);

    const runImmediate = options.runImmediate ?? true;
    if (runImmediate) {
      const now = this.clock.now();
      const targetHourH = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
      void this.triggerHour(experimentId, targetHourH);
    }

    this.scheduleNextHourly(experimentId);
  }

  stop(experimentId?: string): void {
    if (experimentId) {
      const state = this.timers.get(experimentId);
      if (state) {
        if (state.hourlyTimer !== null) this.clock.clearTimeout(state.hourlyTimer);
        if (state.retryTimer !== null) this.clock.clearTimeout(state.retryTimer);
        this.timers.delete(experimentId);
      }
      return;
    }

    for (const id of Array.from(this.timers.keys())) {
      this.stop(id);
    }
  }

  getNextScheduleAt(experimentId: string): number | null {
    return this.timers.get(experimentId)?.nextScheduleAt ?? null;
  }

  async flush(): Promise<void> {
    while (this.inFlightPromises.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightPromises));
    }
  }

  private scheduleNextHourly(experimentId: string): void {
    const state = this.timers.get(experimentId);
    if (!state) return;
    if (state.hourlyTimer !== null) {
      this.clock.clearTimeout(state.hourlyTimer);
      state.hourlyTimer = null;
    }

    const now = this.clock.now();
    const currentHourPlus30s = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS + 30_000;
    const nextRunAt = now < currentHourPlus30s ? currentHourPlus30s : currentHourPlus30s + ONE_HOUR_MS;
    state.nextScheduleAt = nextRunAt;

    const delay = Math.max(1, nextRunAt - now);
    state.hourlyTimer = this.clock.setTimeout(() => {
      const curState = this.timers.get(experimentId);
      if (!curState) return;
      curState.hourlyTimer = null;
      const fireNow = this.clock.now();
      const targetHourH = Math.floor(fireNow / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
      void this.triggerHour(experimentId, targetHourH).finally(() => {
        if (this.timers.has(experimentId)) {
          this.scheduleNextHourly(experimentId);
        }
      });
    }, delay);
  }

  private scheduleRetry(experimentId: string, targetHourH: number, retryMs: number): void {
    const state = this.timers.get(experimentId);
    if (!state) return;
    if (state.retryTimer !== null) {
      this.clock.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryTimer = this.clock.setTimeout(() => {
      const curState = this.timers.get(experimentId);
      if (!curState) return;
      curState.retryTimer = null;
      void this.triggerHour(experimentId, targetHourH);
    }, Math.max(1, retryMs));
  }

  async triggerHour(experimentId: string, targetHourH: number): Promise<void> {
    const lockKey = `${experimentId}:${targetHourH}`;
    if (this.inFlightHours.has(lockKey)) return;
    this.inFlightHours.add(lockKey);

    const run = (async () => {
      try {
      const exp = await this.store.getExperiment(experimentId);
      if (!exp || exp.status !== 'RUNNING' || !this.isLeaseOwned(experimentId)) {
        return;
      }

      const now = this.clock.now();
      const deadline = targetHourH + ONE_HOUR_MS + exp.config.deadlineMs;
      const existing = await this.store.getDecisionByHour(exp.id, exp.modelKey, targetHourH);

      if (existing && now >= deadline) {
        if (existing.status === 'PENDING_RETRY') {
          await this.store.updateDecision({
            id: existing.id,
            status: 'SKIPPED',
            reason: existing.reason
              ? `${existing.reason}；已超過 H+1h+10m 決策期限`
              : '已超過 H+1h+10m 決策期限，本小時略過',
          });
        }
        return;
      }

      const decisionId = `${exp.id}:${exp.modelKey}:${targetHourH}`;
      const claim = await this.store.claimDecision({
        id: decisionId,
        experimentId: exp.id,
        modelKey: exp.modelKey,
        decisionHour: targetHourH,
        now,
        allowFailedRetry: true,
      });

      if (!claim.claimed) {
        return;
      }

      if (this.clock.now() >= deadline) {
        await this.store.updateDecision({
          id: claim.decision.id,
          status: 'SKIPPED',
          reason: '已超過 H+1h+10m 決策期限，本小時略過',
        });
        return;
      }

      if (
        Boolean(this.forwardInference.runner?.isBusy?.()) ||
        (this.activeInferenceExperimentId !== null && this.activeInferenceExperimentId !== exp.id)
      ) {
        await this.handleBusyOrDataNotReady(exp, claim.decision.id, targetHourH, '推論工作鎖忙碌中', deadline);
        return;
      }

      this.activeInferenceExperimentId = exp.id;
      let output;
      try {
        output = await this.forwardInference.runHour({
          experiment: exp,
          targetHourH,
          now: this.clock.now(),
        });
      } catch (err: any) {
        if (
          err instanceof DataNotReadyError ||
          err?.code === 'DATA_NOT_READY' ||
          err?.errorCode === 'DATA_NOT_READY' ||
          err instanceof ModelResearchBusyError
        ) {
          await this.handleBusyOrDataNotReady(exp, claim.decision.id, targetHourH, err.message, deadline);
        } else {
          const code = err?.errorCode ? `${err.errorCode}: ` : '';
          await this.store.updateDecision({
            id: claim.decision.id,
            status: 'FAILED',
            reason: `${code}${err?.message || '推論失敗'}`,
          });
          if (this.clock.now() < deadline) {
            this.scheduleRetry(exp.id, targetHourH, exp.config.retryMs);
          }
        }
        return;
      } finally {
        if (this.activeInferenceExperimentId === exp.id) {
          this.activeInferenceExperimentId = null;
        }
      }

      // Submission gate (Step 8)
      if (this.clock.now() >= deadline) {
        await this.store.updateDecision({
          id: claim.decision.id,
          status: 'SKIPPED',
          reason: '推論完成時已超過 H+1h+10m 期限，不予提交',
        });
        return;
      }

      const { rankResult, chronosResult, snapshotDir, inputDoc, modelVersions } = output;
      if (
        rankResult.decisionOpenTime !== targetHourH ||
        rankResult.inputMode !== 'live' ||
        rankResult.replay === true
      ) {
        await this.store.updateDecision({
          id: claim.decision.id,
          status: 'FAILED',
          reason: '推論結果模式非 live 或 decisionOpenTime 與目標小時不符，拒絕採用',
        });
        if (this.clock.now() < deadline) {
          this.scheduleRetry(exp.id, targetHourH, exp.config.retryMs);
        }
        return;
      }

      const freshExp = await this.store.getExperiment(exp.id);
      if (!freshExp || freshExp.status !== 'RUNNING' || !this.isLeaseOwned(exp.id)) {
        await this.store.updateDecision({
          id: claim.decision.id,
          status: 'SKIPPED',
          reason: '實驗狀態已變更為非 RUNNING，本小時不調整部位',
        });
        return;
      }

      let rules: Record<string, AutoSymbolRules>;
      try {
        rules = await this.getRules();
      } catch (err: any) {
        await this.handleBusyOrDataNotReady(
          exp, claim.decision.id, targetHourH,
          `取得交易規則失敗：${err?.message || String(err)}`, deadline,
        );
        return;
      }
      const submitNow = this.clock.now();
      if (submitNow >= deadline) {
        await this.store.updateDecision({
          id: claim.decision.id,
          status: 'SKIPPED',
          reason: '取得交易規則時已超過決策期限，不予提交',
        });
        return;
      }
      const readyExp = await this.store.getExperiment(exp.id);
      if (!readyExp || readyExp.status !== 'RUNNING' || !this.isLeaseOwned(exp.id)) {
        await this.store.updateDecision({
          id: claim.decision.id,
          status: 'SKIPPED',
          reason: '取得交易規則時實驗狀態已變更',
        });
        return;
      }

      // Build signals using live Futures aggTrade reference prices at submission time (D4)
      const targetSymbols = Array.from(
        new Set([
          ...rankResult.longTop5.slice(0, 3).map(e => e.symbol),
          ...rankResult.shortTop5.slice(0, 3).map(e => e.symbol),
        ]),
      );
      const referencePrices = this.tradeBus.getReferencePrices(targetSymbols);
      const signalBuild = buildSignals({
        longTop5: rankResult.longTop5,
        shortTop5: rankResult.shortTop5,
        conflictSymbols: rankResult.conflictSymbols,
        forecasts: chronosResult.forecasts,
        referencePrices,
        decisionOpenTime: targetHourH,
        targetCutoffTime: targetHourH + ONE_HOUR_MS,
        now: submitNow,
        config: freshExp.config,
      });

      const lastPrices = this.tradeBus.getLastPrices();

      let finalSignalsDoc: Record<string, unknown> = {};
      let snapshotHash = '';

      await this.store.withTx(async (tx) => {
        const txExp = await this.store.getExperiment(exp.id, tx);
        if (!txExp || txExp.status !== 'RUNNING') {
          await this.store.updateDecision(
            {
              id: claim.decision.id,
              status: 'SKIPPED',
              reason: '提交前實驗已非 RUNNING 狀態',
            },
            tx,
          );
          return;
        }

        const accounts = await this.store.getAccounts(exp.id, tx);
        const openPositions = await this.store.listPositions(exp.id, undefined, 'OPEN', tx);
        const pendingOrders = await this.store.listPendingOrders(exp.id, undefined, tx);

        const resetHourStopped = (acc: PaperAccountState): PaperAccountState =>
          acc.stoppedThisHour.length > 0 &&
          Math.floor(acc.updatedAt / ONE_HOUR_MS) < Math.floor(submitNow / ONE_HOUR_MS)
            ? { ...acc, stoppedThisHour: [], updatedAt: submitNow }
            : acc;

        const accA = resetHourStopped(accounts.A);
        const accB = resetHourStopped(accounts.B);
        if (accA !== accounts.A) await this.store.upsertAccount(accA, tx);
        if (accB !== accounts.B) await this.store.upsertAccount(accB, tx);

        const recA = reconcile(accA, signalBuild.signalsA, {
          experimentStatus: txExp.status,
          decisionId: claim.decision.id,
          decisionHour: targetHourH,
          now: submitNow,
          rules,
          config: txExp.config,
          positions: openPositions.filter(p => p.account === 'A'),
          pendingOrders: pendingOrders.filter(o => o.account === 'A'),
          lastPrices,
        });

        const recB = reconcile(accB, signalBuild.signalsB, {
          experimentStatus: txExp.status,
          decisionId: claim.decision.id,
          decisionHour: targetHourH,
          now: submitNow,
          rules,
          config: txExp.config,
          positions: openPositions.filter(p => p.account === 'B'),
          pendingOrders: pendingOrders.filter(o => o.account === 'B'),
          lastPrices,
        });

        if (recA.bankrupt && !accA.bankrupt) {
          await this.store.upsertAccount({ ...accA, bankrupt: true, updatedAt: submitNow }, tx);
        }
        if (recB.bankrupt && !accB.bankrupt) {
          await this.store.upsertAccount({ ...accB, bankrupt: true, updatedAt: submitNow }, tx);
        }

        for (const order of [...recA.orders, ...recB.orders]) {
          await this.store.insertOrderIfAbsent(order, tx);
        }

        const mergedSkippedA = [...signalBuild.skippedA, ...recA.skipped];
        const mergedSkippedB = [...signalBuild.skippedB, ...recB.skipped];

        finalSignalsDoc = {
          pool: signalBuild.pool,
          signalsA: signalBuild.signalsA,
          signalsB: signalBuild.signalsB,
          skippedA: mergedSkippedA,
          skippedB: mergedSkippedB,
          longTop5: rankResult.longTop5,
          shortTop5: rankResult.shortTop5,
          conflictSymbols: rankResult.conflictSymbols,
          forecasts: chronosResult.forecasts,
          referencePrices,
          ...(modelVersions ? { modelVersions } : {}),
        };

        snapshotHash = crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              inputDoc,
              rankResult,
              chronosResult,
              signals: finalSignalsDoc,
            }),
          )
          .digest('hex');

        const signalsPath = path.join(snapshotDir, 'signals.json');
        await fsp.mkdir(snapshotDir, { recursive: true });
        await fsp.writeFile(signalsPath, JSON.stringify(finalSignalsDoc, null, 2), 'utf8');

        await this.store.updateDecision(
          {
            id: claim.decision.id,
            status: 'SUBMITTED',
            reason: null,
            snapshotPath: snapshotDir,
            snapshotHash,
            signals: finalSignalsDoc as any,
            submittedAt: submitNow,
          },
          tx,
        );
      });
      this.onStateChanged?.();
    } finally {
      this.inFlightHours.delete(lockKey);
    }
    })();

    this.inFlightPromises.add(run);
    try {
      await run;
    } finally {
      this.inFlightPromises.delete(run);
    }
  }

  private async handleBusyOrDataNotReady(
    exp: ModelPaperExperimentRecord,
    decisionId: string,
    targetHourH: number,
    reason: string,
    deadline: number,
  ): Promise<void> {
    if (this.clock.now() < deadline) {
      await this.store.updateDecision({
        id: decisionId,
        status: 'PENDING_RETRY',
        reason,
      });
      this.scheduleRetry(exp.id, targetHourH, exp.config.retryMs);
    } else {
      await this.store.updateDecision({
        id: decisionId,
        status: 'SKIPPED',
        reason: `${reason}（已超過 H+1h+10m 決策期限）`,
      });
    }
  }

  async onExitFilled(params: {
    experimentId: string;
    account: AccountId;
    now: number;
  }): Promise<void> {
    const { experimentId, account: accId, now } = params;
    const exp = await this.store.getExperiment(experimentId);
    if (!exp || exp.status !== 'RUNNING' || !this.isLeaseOwned(experimentId)) return;

    const currentHourH = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS - ONE_HOUR_MS;
    const deadline = currentHourH + ONE_HOUR_MS + exp.config.deadlineMs;
    if (now >= deadline) return;

    const decision = await this.store.getDecisionByHour(exp.id, exp.modelKey, currentHourH);
    if (!decision || decision.status !== 'SUBMITTED' || !decision.signals) return;

    const signalsForAcc: Signal[] =
      accId === 'A' ? decision.signals.signalsA ?? [] : decision.signals.signalsB ?? [];
    if (!signalsForAcc.length) return;

    const rules = await this.getRules();
    const lastPrices = this.tradeBus.getLastPrices();

    await this.store.withTx(async (tx) => {
      const txExp = await this.store.getExperiment(exp.id, tx);
      if (!txExp || txExp.status !== 'RUNNING') return;
      const acc = await this.store.getAccount(exp.id, accId, tx);
      if (!acc) return;
      const positions = await this.store.listPositions(exp.id, accId, 'OPEN', tx);
      const pendingOrders = await this.store.listPendingOrders(exp.id, accId, tx);
      const allAccOrders = await this.store.listOrders(exp.id, accId, tx);
      const attemptedEntrySymbols = new Set(
        allAccOrders
          .filter(o => o.decisionId === decision.id && o.action === 'ENTRY')
          .map(o => o.symbol),
      );
      const eligibleSignals = signalsForAcc.filter(s => !attemptedEntrySymbols.has(s.symbol));
      if (!eligibleSignals.length) return;

      const slotsRes = fillSlots(acc, eligibleSignals, {
        experimentStatus: txExp.status,
        decisionId: decision.id,
        decisionHour: currentHourH,
        now,
        rules,
        config: txExp.config,
        positions,
        pendingOrders,
        lastPrices,
      });

      if (slotsRes.bankrupt && !acc.bankrupt) {
        await this.store.upsertAccount({ ...acc, bankrupt: true, updatedAt: now }, tx);
      }

      for (const order of slotsRes.orders) {
        await this.store.insertOrderIfAbsent(order, tx);
      }

      if (slotsRes.skipped.length > 0) {
        const curSignals = { ...decision.signals };
        if (accId === 'A') {
          curSignals.skippedA = [...(curSignals.skippedA ?? []), ...slotsRes.skipped];
        } else {
          curSignals.skippedB = [...(curSignals.skippedB ?? []), ...slotsRes.skipped];
        }
        await this.store.updateDecision(
          {
            id: decision.id,
            status: 'SUBMITTED',
            signals: curSignals,
          },
          tx,
        );
      }
    });
    this.onStateChanged?.();
  }
}
