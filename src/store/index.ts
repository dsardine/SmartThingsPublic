import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';

import { appStorage } from '@/src/lib/storage';
import type {
  DateFormat,
  FirstDayOfWeek,
  TemperatureUnit,
} from '@/src/types/database';

const GHOST_MODE_KEY = 'ghost_mode_enabled';

export type UserPreferences = {
  temperatureUnit: TemperatureUnit;
  firstDayOfWeek: FirstDayOfWeek;
  dateFormat: DateFormat;
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
};

const defaultPreferences: UserPreferences = {
  temperatureUnit: 'F',
  firstDayOfWeek: 'Sunday',
  dateFormat: 'MM/DD/YYYY',
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
}));

export function getPreferencesSnapshot(): UserPreferences {
  return { ...useAppStore.getState().preferences };
}
