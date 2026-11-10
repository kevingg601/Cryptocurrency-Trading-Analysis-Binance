export type TargetDirection = 'LONG' | 'SHORT';

export interface TargetMilestoneLevels {
  stopLoss: number;
  entryPrice: number;
  tp1: number;
  tp2: number;
  tp3: number;
  ftp: number;
  risk: number;
  slDistancePercent: number;
}

export interface TargetCardSetup {
  symbol: string;
  baseAsset: string;
  name: string;
  side: TargetDirection;
  timestamp: number; // epoch ms
  displayTime?: string;
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  ftp: number;
  achievedMilestone?: 'TP1' | 'TP2' | 'TP3' | 'FTP';
  initialPrice?: number;
  isCustom?: boolean;
}

export interface TargetProgressResult {
  currentPrice: number;
  pnlPercent: number;
  maxPnlPercent: number;
  positionPercent: number; // 0 to 100 along the track
  tp1Reached: boolean;
  tp2Reached: boolean;
  tp3Reached: boolean;
  ftpReached: boolean;
  stoppedOut: boolean;
  inProfit: boolean;
  statusText: string;
  statusLabel: string;
  priceDisplay: string;
}

export const TARGET_TRACK_ANCHORS = {
  SL: 5,
  ENTRY: 20,
  TP1: 38,
  TP2: 55,
  TP3: 75,
  FTP: 95,
} as const;

export const MAINSTREAM_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'BNBUSDT',
] as const;

export function formatTargetPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return '--';
  if (!Number.isFinite(price)) return String(price);
  if (price === 0) return '0';

  const abs = Math.abs(price);
  let maxDecimals: number;
  if (abs < 0.0001) maxDecimals = 8;
  else if (abs < 0.01) maxDecimals = 6;
  else if (abs < 1) maxDecimals = 5;
  else if (abs < 100) maxDecimals = 4;
  else if (abs < 1000) maxDecimals = 3;
  else maxDecimals = 2;

  const rounded = parseFloat(price.toFixed(maxDecimals));
  return rounded.toLocaleString('en-US', {
    maximumFractionDigits: maxDecimals,
  });
}

export const INITIAL_SCREENSHOT_TARGET_SETUPS: Record<string, TargetCardSetup> = {
  XRPUSDT: {
    symbol: 'XRPUSDT',
    baseAsset: 'XRP',
    name: 'XRP',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 1.2445,
    stopLoss: 1.2722,
    tp1: 1.2168,
    tp2: 1.1890,
    tp3: 1.1058,
    ftp: 0.9670,
    achievedMilestone: 'TP3',
    initialPrice: 1.1129,
  },
  HYPEUSDT: {
    symbol: 'HYPEUSDT',
    baseAsset: 'HYPE',
    name: 'Hyperliquid',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 78.464,
    stopLoss: 80.7346,
    tp1: 76.1934,
    tp2: 73.9229,
    tp3: 67.1112,
    ftp: 55.7584,
    achievedMilestone: 'TP2',
    initialPrice: 74.361,
  },
  ETHUSDT: {
    symbol: 'ETHUSDT',
    baseAsset: 'ETH',
    name: 'Ethereum',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 2250.12,
    stopLoss: 2302.78,
    tp1: 2197.46,
    tp2: 2144.80,
    tp3: 1986.81,
    ftp: 1723.50,
    achievedMilestone: 'TP2',
    initialPrice: 2133.49,
  },
  SOLUSDT: {
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    name: 'Solana',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 90.15,
    stopLoss: 92.5997,
    tp1: 87.7003,
    tp2: 85.2506,
    tp3: 77.9015,
    ftp: 65.6530,
    achievedMilestone: 'TP2',
    initialPrice: 87.385,
  },
  BTCUSDT: {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    name: 'Bitcoin',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 68500,
    stopLoss: 70212.5,
    tp1: 66787.5,
    tp2: 65075,
    tp3: 59937.5,
    ftp: 51375,
    initialPrice: 67200,
  },
  BNBUSDT: {
    symbol: 'BNBUSDT',
    baseAsset: 'BNB',
    name: 'BNB',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 590,
    stopLoss: 604.75,
    tp1: 575.25,
    tp2: 560.5,
    tp3: 516.25,
    ftp: 442.5,
    initialPrice: 580,
  },
  DOGEUSDT: {
    symbol: 'DOGEUSDT',
    baseAsset: 'DOGE',
    name: 'Dogecoin',
    side: 'SHORT',
    timestamp: 1730851200000,
    displayTime: '11/06 00:00',
    entryPrice: 0.1600,
    stopLoss: 0.1640,
    tp1: 0.1560,
    tp2: 0.1520,
    tp3: 0.1400,
    ftp: 0.1200,
    initialPrice: 0.1580,
  },
};

export function calculateTargetMilestones(
  side: TargetDirection,
  entryPrice: number,
  stopLoss: number
): TargetMilestoneLevels | null {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || entryPrice <= 0 || stopLoss <= 0) {
    return null;
  }

  // Ensure stopLoss is on the correct side
  if (side === 'LONG' && stopLoss >= entryPrice) {
    return null;
  }
  if (side === 'SHORT' && stopLoss <= entryPrice) {
    return null;
  }

  const risk = Math.abs(entryPrice - stopLoss);
  if (risk === 0) return null;

  const slDistancePercent = (risk / entryPrice) * 100;
  const isLong = side === 'LONG';

  const tp1 = isLong ? entryPrice + 1.0 * risk : entryPrice - 1.0 * risk;
  const tp2 = isLong ? entryPrice + 2.0 * risk : entryPrice - 2.0 * risk;
  const tp3 = isLong ? entryPrice + 5.0 * risk : entryPrice - 5.0 * risk;
  const rawFtp = isLong ? entryPrice + 10.0 * risk : entryPrice - 10.0 * risk;
  const ftp = rawFtp > 0 ? rawFtp : entryPrice * 0.05;

  return {
    stopLoss,
    entryPrice,
    tp1,
    tp2,
    tp3,
    ftp,
    risk,
    slDistancePercent,
  };
}

export function deriveAutomaticTargetSetup(
  symbol: string,
  baseAsset: string,
  name: string,
  currentPrice: number,
  side: TargetDirection = 'SHORT',
  slDistancePercent: number = 2.5
): TargetCardSetup | null {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  const risk = currentPrice * (slDistancePercent / 100);
  const stopLoss = side === 'SHORT' ? currentPrice + risk : currentPrice - risk;
  const levels = calculateTargetMilestones(side, currentPrice, stopLoss);
  if (!levels) return null;

  return {
    symbol,
    baseAsset,
    name,
    side,
    timestamp: Date.now(),
    entryPrice: levels.entryPrice,
    stopLoss: levels.stopLoss,
    tp1: levels.tp1,
    tp2: levels.tp2,
    tp3: levels.tp3,
    ftp: levels.ftp,
  };
}

export function calculateTrackPosition(
  setup: Pick<TargetCardSetup, 'side' | 'entryPrice' | 'stopLoss' | 'tp1' | 'tp2' | 'tp3' | 'ftp'>,
  currentPrice: number
): number {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return TARGET_TRACK_ANCHORS.ENTRY;
  }

  const { side, entryPrice, stopLoss, tp1, tp2, tp3, ftp } = setup;
  const { SL, ENTRY, TP1, TP2, TP3, FTP } = TARGET_TRACK_ANCHORS;

  if (side === 'SHORT') {
    // Stop Loss side (price > stopLoss)
    if (currentPrice >= stopLoss) {
      const risk = stopLoss - entryPrice;
      const overshoot = risk > 0 ? (currentPrice - stopLoss) / risk : 0;
      return Math.max(1, SL - overshoot * 3);
    }
    // Between SL and Entry (price between stopLoss and entryPrice)
    if (currentPrice >= entryPrice) {
      const range = stopLoss - entryPrice;
      const ratio = range > 0 ? (stopLoss - currentPrice) / range : 0;
      return SL + ratio * (ENTRY - SL);
    }
    // Between Entry and TP1
    if (currentPrice >= tp1) {
      const range = entryPrice - tp1;
      const ratio = range > 0 ? (entryPrice - currentPrice) / range : 0;
      return ENTRY + ratio * (TP1 - ENTRY);
    }
    // Between TP1 and TP2
    if (currentPrice >= tp2) {
      const range = tp1 - tp2;
      const ratio = range > 0 ? (tp1 - currentPrice) / range : 0;
      return TP1 + ratio * (TP2 - TP1);
    }
    // Between TP2 and TP3
    if (currentPrice >= tp3) {
      const range = tp2 - tp3;
      const ratio = range > 0 ? (tp2 - currentPrice) / range : 0;
      return TP2 + ratio * (TP3 - TP2);
    }
    // Between TP3 and FTP
    if (currentPrice >= ftp) {
      const range = tp3 - ftp;
      const ratio = range > 0 ? (tp3 - currentPrice) / range : 0;
      return TP3 + ratio * (FTP - TP3);
    }
    // Beyond FTP
    const range = tp3 - ftp;
    const overshoot = range > 0 ? (ftp - currentPrice) / range : 0;
    return Math.min(99, FTP + overshoot * 2);
  } else {
    // LONG: SL < Entry < TP1 < TP2 < TP3 < FTP
    if (currentPrice <= stopLoss) {
      const risk = entryPrice - stopLoss;
      const overshoot = risk > 0 ? (stopLoss - currentPrice) / risk : 0;
      return Math.max(1, SL - overshoot * 3);
    }
    if (currentPrice <= entryPrice) {
      const range = entryPrice - stopLoss;
      const ratio = range > 0 ? (currentPrice - stopLoss) / range : 0;
      return SL + ratio * (ENTRY - SL);
    }
    if (currentPrice <= tp1) {
      const range = tp1 - entryPrice;
      const ratio = range > 0 ? (currentPrice - entryPrice) / range : 0;
      return ENTRY + ratio * (TP1 - ENTRY);
    }
    if (currentPrice <= tp2) {
      const range = tp2 - tp1;
      const ratio = range > 0 ? (currentPrice - tp1) / range : 0;
      return TP1 + ratio * (TP2 - TP1);
    }
    if (currentPrice <= tp3) {
      const range = tp3 - tp2;
      const ratio = range > 0 ? (currentPrice - tp2) / range : 0;
      return TP2 + ratio * (TP3 - TP2);
    }
    if (currentPrice <= ftp) {
      const range = ftp - tp3;
      const ratio = range > 0 ? (currentPrice - tp3) / range : 0;
      return TP3 + ratio * (FTP - TP3);
    }
    const range = ftp - tp3;
    const overshoot = range > 0 ? (currentPrice - ftp) / range : 0;
    return Math.min(99, FTP + overshoot * 2);
  }
}

export function evaluateTargetProgress(
  setup: TargetCardSetup,
  currentPrice: number,
  options?: {
    extremePrice?: number;
    achievedMilestone?: 'TP1' | 'TP2' | 'TP3' | 'FTP' | null;
  }
): TargetProgressResult {
  const isLong = setup.side === 'LONG';
  const pnlPercent = isLong
    ? ((currentPrice - setup.entryPrice) / setup.entryPrice) * 100
    : ((setup.entryPrice - currentPrice) / setup.entryPrice) * 100;

  const stoppedOut = isLong ? currentPrice <= setup.stopLoss : currentPrice >= setup.stopLoss;

  const bestPrice = options?.extremePrice !== undefined
    ? (isLong ? Math.max(currentPrice, options.extremePrice) : Math.min(currentPrice, options.extremePrice))
    : currentPrice;

  let tp1Reached = isLong ? bestPrice >= setup.tp1 : bestPrice <= setup.tp1;
  let tp2Reached = isLong ? bestPrice >= setup.tp2 : bestPrice <= setup.tp2;
  let tp3Reached = isLong ? bestPrice >= setup.tp3 : bestPrice <= setup.tp3;
  let ftpReached = isLong ? bestPrice >= setup.ftp : bestPrice <= setup.ftp;

  const milestoneHint = options?.achievedMilestone ?? setup.achievedMilestone;
  if (milestoneHint === 'FTP') {
    ftpReached = true;
    tp3Reached = true;
    tp2Reached = true;
    tp1Reached = true;
  } else if (milestoneHint === 'TP3') {
    tp3Reached = true;
    tp2Reached = true;
    tp1Reached = true;
  } else if (milestoneHint === 'TP2') {
    tp2Reached = true;
    tp1Reached = true;
  } else if (milestoneHint === 'TP1') {
    tp1Reached = true;
  }

  const inProfit = pnlPercent >= 0;
  const positionPercent = calculateTrackPosition(setup, currentPrice);

  // Calculate highest achieved return (matches the screenshot prominent ROI)
  let maxPnlPercent = pnlPercent;
  let targetPriceForMilestone: number | null = null;
  if (ftpReached) {
    targetPriceForMilestone = setup.ftp;
  } else if (tp3Reached) {
    targetPriceForMilestone = setup.tp3;
  } else if (tp2Reached) {
    targetPriceForMilestone = setup.tp2;
  } else if (tp1Reached) {
    targetPriceForMilestone = setup.tp1;
  }

  if (targetPriceForMilestone !== null) {
    const milestonePnl = isLong
      ? ((targetPriceForMilestone - setup.entryPrice) / setup.entryPrice) * 100
      : ((setup.entryPrice - targetPriceForMilestone) / setup.entryPrice) * 100;

    const bestPricePnl = isLong
      ? ((bestPrice - setup.entryPrice) / setup.entryPrice) * 100
      : ((setup.entryPrice - bestPrice) / setup.entryPrice) * 100;

    maxPnlPercent = Math.max(milestonePnl, bestPricePnl);
  } else if (inProfit) {
    const bestPricePnl = isLong
      ? ((bestPrice - setup.entryPrice) / setup.entryPrice) * 100
      : ((setup.entryPrice - bestPrice) / setup.entryPrice) * 100;
    maxPnlPercent = Math.max(pnlPercent, bestPricePnl);
  }

  let statusLabel: string;
  const priceDisplay = formatTargetPrice(currentPrice);

  if (stoppedOut) {
    statusLabel = '止損觸發 | 現價';
  } else if (ftpReached) {
    statusLabel = 'FTP 達成，持倉中 | 現價';
  } else if (tp3Reached) {
    statusLabel = 'TP3 達成，持倉中 | 現價';
  } else if (tp2Reached) {
    statusLabel = 'TP2 達成，持倉中 | 現價';
  } else if (tp1Reached) {
    statusLabel = 'TP1 達成，持倉中 | 現價';
  } else if (inProfit) {
    statusLabel = '持倉中 | 現價';
  } else {
    statusLabel = '回撤觀察中 | 現價';
  }

  const statusText = `${statusLabel} ${priceDisplay}`;

  return {
    currentPrice,
    pnlPercent,
    maxPnlPercent,
    positionPercent,
    tp1Reached,
    tp2Reached,
    tp3Reached,
    ftpReached,
    stoppedOut,
    inProfit,
    statusText,
    statusLabel,
    priceDisplay,
  };
}

export function formatCardTimestamp(epochMs: number, displayTime?: string): string {
  if (displayTime) return displayTime;
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}
