import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';

import { appStorage, GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY } from '@/src/lib/storage';
import type {
  BbtTimeFormat,
  DateFormat,
  FirstDayOfWeek,
  TemperatureUnit,
} from '@/src/types/database';

const GHOST_MODE_KEY = 'ghost_mode_enabled';

export type UserPreferences = {
  temperatureUnit: TemperatureUnit;
  firstDayOfWeek: FirstDayOfWeek;
  dateFormat: DateFormat;
  bbtTimeFormat: BbtTimeFormat;
};

type AppState = {
  session: Session | null;
  authHydrated: boolean;
  setSession: (session: Session | null) => void;
  setAuthHydrated: (hydrated: boolean) => void;

  isGhostModeEnabled: boolean;
  setGhostModeEnabled: (value: boolean) => void;

  preferences: UserPreferences;
  hydratePreferences: (prefs: Partial<UserPreferences>) => void;
  setPreferences: (prefs: Partial<UserPreferences>) => void;

  /** Current cycle-length estimate (profile + dynamic rolling average). */
  cycleLengthAvg: number;
  /** Onboarding seed; passed to `calculateDynamicCycleAverage` when fewer than two valid cycles exist. */
  cycleLengthIntakeFallback: number;
  setCycleLengthAvg: (n: number) => void;
  hydrateCycleLengthFromProfile: (args: {
    serverCycleLengthAvg: number;
    isGhostMode: boolean;
  }) => void;
};

const defaultPreferences: UserPreferences = {
  temperatureUnit: 'F',
  firstDayOfWeek: 'Sunday',
  dateFormat: 'MM/DD/YYYY',
  bbtTimeFormat: '12h',
};

export const useAppStore = create<AppState>((set) => ({
  session: null,
  authHydrated: false,
  setSession: (session) => set({ session }),
  setAuthHydrated: (authHydrated) => set({ authHydrated }),

  isGhostModeEnabled: appStorage.getBoolean(GHOST_MODE_KEY) ?? false,
  setGhostModeEnabled: (value) => {
    appStorage.set(GHOST_MODE_KEY, value);
    set({ isGhostModeEnabled: value });
  },

  preferences: { ...defaultPreferences },
  hydratePreferences: (prefs) =>
    set((s) => ({
      preferences: { ...s.preferences, ...prefs },
    })),
  setPreferences: (prefs) =>
    set((s) => ({
      preferences: { ...s.preferences, ...prefs },
    })),

  cycleLengthAvg: 28,
  cycleLengthIntakeFallback: 28,
  setCycleLengthAvg: (cycleLengthAvg) => set({ cycleLengthAvg }),
  hydrateCycleLengthFromProfile: ({ serverCycleLengthAvg, isGhostMode }) => {
    const server = Math.round(Number(serverCycleLengthAvg));
    const safe = Number.isFinite(server) ? server : 28;
    const localGhost = appStorage.getNumber(GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY);
    const useLocalGhost =
      isGhostMode && localGhost != null && Number.isFinite(Number(localGhost));
    set({
      cycleLengthIntakeFallback: safe,
      cycleLengthAvg: useLocalGhost ? Math.round(Number(localGhost)) : safe,
    });
  },
}));

export function getPreferencesSnapshot(): UserPreferences {
  return { ...useAppStore.getState().preferences };
}
