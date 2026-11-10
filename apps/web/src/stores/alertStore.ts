import { create } from 'zustand';
import type { MarketAlert, MarketAlertSettings, FollowPlan } from '@fadachi/core';
import { DEFAULT_MARKET_ALERT_SETTINGS } from '@fadachi/core';

export interface AlertState {
  alerts: MarketAlert[];
  followPlans: FollowPlan[];
  alertSettings: MarketAlertSettings;
  soundEnabled: boolean;
  addAlert: (alert: MarketAlert) => void;
  clearAlerts: () => void;
  setFollowPlans: (plans: FollowPlan[]) => void;
  updateSettings: (settings: Partial<MarketAlertSettings>) => void;
  setSoundEnabled: (enabled: boolean) => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  alerts: [],
  followPlans: [],
  alertSettings: DEFAULT_MARKET_ALERT_SETTINGS,
  soundEnabled: false,

  addAlert: (alert) => {
    set((state) => ({
      alerts: [alert, ...state.alerts].slice(0, 100),
    }));
  },

  clearAlerts: () => set({ alerts: [] }),

  setFollowPlans: (followPlans) => set({ followPlans }),

  updateSettings: (settings) => {
    set((state) => ({
      alertSettings: { ...state.alertSettings, ...settings },
    }));
  },

  setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
}));
