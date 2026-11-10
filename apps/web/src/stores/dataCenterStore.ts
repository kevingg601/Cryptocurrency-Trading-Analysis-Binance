import { create } from 'zustand';
import type { ReplayResult, MarketType } from '@fadachi/core';
import { collectorClient } from '../api/collectorClient.ts';

export interface DataCenterSummary {
  totalAggTrades: number;
  totalKlines: number;
  openGaps: number;
  diskBytes: number;
  recentSessions: any[];
  recentAlerts: any[];
}

export interface DataCenterState {
  summary: DataCenterSummary | null;
  coverageGaps: any[];
  dailyCounts: any[];
  replayResult: ReplayResult | null;
  isReplaying: boolean;
  isLoading: boolean;
  summaryError: string | null;
  coverageError: string | null;
  replayError: string | null;
  loadSummary: () => Promise<void>;
  loadCoverage: (market: MarketType, symbol?: string) => Promise<void>;
  runReplay: (params: any) => Promise<void>;
  resetReplay: () => void;
}

const rows = (value: unknown, valid: (row: any) => boolean): boolean => Array.isArray(value) && value.every(row => row && valid(row));
const count = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const message = (err: unknown): string => `Collector 資料載入失敗：${err instanceof Error ? err.message : '未知錯誤'}。請確認服務連線後重試。`;

export const useDataCenterStore = create<DataCenterState>((set) => {
  let summaryVersion = 0;
  let coverageVersion = 0;
  let replayVersion = 0;
  return {
    summary: null, coverageGaps: [], dailyCounts: [], replayResult: null,
    isReplaying: false, isLoading: false, summaryError: null, coverageError: null, replayError: null,
    resetReplay: () => {
      ++replayVersion;
      set({ replayResult: null, replayError: null, isReplaying: false });
    },
    loadSummary: async () => {
      const version = ++summaryVersion;
      set({ isLoading: true, summaryError: null });
      try {
        const summary = await collectorClient.getStatsSummary();
        if (!summary || !['totalAggTrades', 'totalKlines', 'openGaps', 'diskBytes'].every(key => count(summary[key]))
          || !rows(summary.recentSessions, row => typeof row.id === 'string' && typeof row.market === 'string' && (row.end_reason == null || typeof row.end_reason === 'string'))
          || !rows(summary.recentAlerts, row => typeof row.type === 'string' && typeof row.symbol === 'string')) {
          throw new Error('統計回應格式錯誤');
        }
        if (version === summaryVersion) set({ summary, summaryError: null });
      } catch (err) {
        if (version === summaryVersion) set({ summary: null, summaryError: message(err) });
      } finally {
        if (version === summaryVersion) set({ isLoading: false });
      }
    },
    loadCoverage: async (market, symbol) => {
      const version = ++coverageVersion;
      set({ coverageGaps: [], dailyCounts: [], coverageError: null });
      try {
        const data = await collectorClient.getCoverage(market, symbol);
        if (!data || !rows(data.gaps, row => typeof row.id === 'string' && typeof row.status === 'string' && typeof row.symbol === 'string' && typeof row.dataset === 'string')
          || !rows(data.dailyCounts, row => typeof row.symbol === 'string' && typeof row.date === 'string' && count(row.count))) {
          throw new Error('覆蓋率回應格式錯誤');
        }
        if (version === coverageVersion) set({ coverageGaps: data.gaps, dailyCounts: data.dailyCounts, coverageError: null });
      } catch (err) {
        if (version === coverageVersion) set({ coverageError: message(err) });
      }
    },
    runReplay: async (params) => {
      const version = ++replayVersion;
      set({ isReplaying: true, replayResult: null, replayError: null });
      try {
        const result = await collectorClient.runReplay(params);
        if (!result || !count(result.totalTrades) || !count(result.skippedByGap)
          || !Array.isArray(result.alerts) || !rows(result.plans, row => typeof row.id === 'string' && typeof row.state === 'string')) {
          throw new Error('重播回應格式錯誤');
        }
        if (version === replayVersion) set({ replayResult: result, replayError: null });
      } catch (err) {
        if (version === replayVersion) set({ replayError: message(err) });
      } finally {
        if (version === replayVersion) set({ isReplaying: false });
      }
    },
  };
});
