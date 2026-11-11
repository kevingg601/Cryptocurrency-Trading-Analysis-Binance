import {
  DEFAULT_MODEL_PAPER_CONFIG,
  type CandidatePoolItem,
  type DecisionInputSnapshot,
  type Signal,
  type SignalsBuildResult,
  type SkippedSignalRecord,
} from './types.ts';

export function sortSignals<T extends Pick<Signal, 'sideRank' | 'symbol' | 'side'>>(signals: T[]): T[] {
  return [...signals].sort(
    (a, b) =>
      a.sideRank - b.sideRank ||
      a.symbol.localeCompare(b.symbol) ||
      (a.side === 'LONG' ? -1 : b.side === 'LONG' ? 1 : 0),
  );
}

export function buildCandidatePool(decision: Pick<DecisionInputSnapshot, 'longTop5' | 'shortTop5' | 'conflictSymbols'>): {
  pool: CandidatePoolItem[];
  conflictEntries: CandidatePoolItem[];
} {
  const conflicts = new Set(decision.conflictSymbols ?? []);
  const pool: CandidatePoolItem[] = [];
  const conflictEntries: CandidatePoolItem[] = [];

  for (const e of (decision.longTop5 ?? []).slice(0, 3)) {
    const item: CandidatePoolItem = {
      symbol: e.symbol,
      side: 'LONG',
      sideRank: e.rank,
      closePrice1h: e.closePrice,
    };
    if (conflicts.has(e.symbol)) {
      conflictEntries.push(item);
    } else {
      pool.push(item);
    }
  }

  for (const e of (decision.shortTop5 ?? []).slice(0, 3)) {
    const item: CandidatePoolItem = {
      symbol: e.symbol,
      side: 'SHORT',
      sideRank: e.rank,
      closePrice1h: e.closePrice,
    };
    if (conflicts.has(e.symbol)) {
      conflictEntries.push(item);
    } else {
      pool.push(item);
    }
  }

  return { pool, conflictEntries };
}

export function buildSignals(decision: DecisionInputSnapshot): SignalsBuildResult {
  const config = decision.config ?? DEFAULT_MODEL_PAPER_CONFIG;
  const { pool, conflictEntries } = buildCandidatePool(decision);

  const skippedA: SkippedSignalRecord[] = [];
  const skippedB: SkippedSignalRecord[] = [];

  for (const c of conflictEntries) {
    skippedA.push({
      account: 'A',
      symbol: c.symbol,
      side: c.side,
      sideRank: c.sideRank,
      reason: 'CONFLICT',
      detail: '同時出現在多空 Top 5 衝突名單',
    });
    skippedB.push({
      account: 'B',
      symbol: c.symbol,
      side: c.side,
      sideRank: c.sideRank,
      reason: 'CONFLICT',
      detail: '同時出現在多空 Top 5 衝突名單',
    });
  }

  const signalsA: Signal[] = [];
  const signalsB: Signal[] = [];

  for (const cand of pool) {
    const quote = decision.referencePrices?.[cand.symbol] ?? null;
    const validQuotePrice = quote && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null;

    // Account B accepts entire candidate pool without Chronos forecast filter
    signalsB.push({
      symbol: cand.symbol,
      side: cand.side,
      sideRank: cand.sideRank,
      refPrice: validQuotePrice ?? cand.closePrice1h,
      closePrice1h: cand.closePrice1h,
      ...(decision.forecasts?.[cand.symbol]
        ? { predictedClose4h: decision.forecasts[cand.symbol]!.predictedClose4h }
        : {}),
    });

    // Account A requires Chronos forecast, fresh reference price, matching direction, and > 0.25% expected return
    const forecast = decision.forecasts?.[cand.symbol];
    if (!forecast || !Number.isFinite(forecast.predictedClose4h) || forecast.predictedClose4h <= 0) {
      skippedA.push({
        account: 'A',
        symbol: cand.symbol,
        side: cand.side,
        sideRank: cand.sideRank,
        reason: 'CHRONOS_MISSING',
        detail: '缺少 Chronos-2 預測結果',
      });
      continue;
    }

    const isFreshQuote = Boolean(
      quote &&
        Number.isFinite(quote.price) &&
        quote.price > 0 &&
        Number.isFinite(quote.tradeTime) &&
        quote.tradeTime >= decision.targetCutoffTime &&
        Number.isFinite(quote.receivedAt) &&
        decision.now - quote.receivedAt <= config.staleMs,
    );

    if (!isFreshQuote || !quote) {
      skippedA.push({
        account: 'A',
        symbol: cand.symbol,
        side: cand.side,
        sideRank: cand.sideRank,
        reason: 'STALE_REFERENCE_PRICE',
        detail: '缺少 H+1h 後且 5 秒內之最新成交參考價',
        predictedClose4h: forecast.predictedClose4h,
      });
      continue;
    }

    const dir = cand.side === 'LONG' ? 1 : -1;
    const dirRet = dir * (forecast.predictedClose4h / quote.price - 1);

    if (!Number.isFinite(dirRet) || dirRet <= 0) {
      skippedA.push({
        account: 'A',
        symbol: cand.symbol,
        side: cand.side,
        sideRank: cand.sideRank,
        reason: 'DIRECTION_MISMATCH',
        detail: `Chronos-2 預測方向與排名方向不一致 (${(dirRet * 100).toFixed(4)}%)`,
        dirRet,
        refPrice: quote.price,
        predictedClose4h: forecast.predictedClose4h,
      });
      continue;
    }

    if (dirRet <= config.thresholdPct) {
      skippedA.push({
        account: 'A',
        symbol: cand.symbol,
        side: cand.side,
        sideRank: cand.sideRank,
        reason: 'BELOW_THRESHOLD',
        detail: `Chronos-2 預期報酬 ${(dirRet * 100).toFixed(4)}% 未嚴格大於 ${(config.thresholdPct * 100).toFixed(2)}%`,
        dirRet,
        refPrice: quote.price,
        predictedClose4h: forecast.predictedClose4h,
      });
      continue;
    }

    signalsA.push({
      symbol: cand.symbol,
      side: cand.side,
      sideRank: cand.sideRank,
      refPrice: quote.price,
      closePrice1h: cand.closePrice1h,
      predictedClose4h: forecast.predictedClose4h,
      dirRet,
    });
  }

  return {
    pool,
    signalsA: sortSignals(signalsA),
    signalsB: sortSignals(signalsB),
    skippedA,
    skippedB,
  };
}
