import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';

import { appStorage, GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY } from '@/src/lib/storage';
import type {
  BbtTimeFormat,
  ClinicalState,
  DateFormat,
  FirstDayOfWeek,
  TemperatureUnit,
  TrackingGoal,
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
  /** Profile `last_period_date` (ISO) for period countdown when not in Ghost Mode. */
  lastPeriodDateIso: string | null;
  setCycleLengthAvg: (n: number) => void;
  hydrateCycleLengthFromProfile: (args: {
    serverCycleLengthAvg: number;
    isGhostMode: boolean;
    lastPeriodDateIso?: string | null;
  }) => void;

  clinicalState: ClinicalState;
  trackingGoal: TrackingGoal;
  clinicalCycleAnchorIso: string | null;
  setClinicalState: (v: ClinicalState) => void;
  setTrackingGoal: (v: TrackingGoal) => void;
  setClinicalCycleAnchorIso: (iso: string | null) => void;
  hydrateClinicalFromProfile: (args: {
    clinical_state?: ClinicalState | null;
    tracking_goal?: TrackingGoal | null;
    clinical_cycle_anchor_iso?: string | null;
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
  lastPeriodDateIso: null,
  setCycleLengthAvg: (cycleLengthAvg) => set({ cycleLengthAvg }),
  hydrateCycleLengthFromProfile: ({ serverCycleLengthAvg, isGhostMode, lastPeriodDateIso }) => {
    const server = Math.round(Number(serverCycleLengthAvg));
    const safe = Number.isFinite(server) ? server : 28;
    const localGhost = appStorage.getNumber(GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY);
    const useLocalGhost =
      isGhostMode && localGhost != null && Number.isFinite(Number(localGhost));
    const lmp =
      typeof lastPeriodDateIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(lastPeriodDateIso)
        ? lastPeriodDateIso
        : null;
    set({
      cycleLengthIntakeFallback: safe,
      cycleLengthAvg: useLocalGhost ? Math.round(Number(localGhost)) : safe,
      lastPeriodDateIso: isGhostMode ? null : lmp,
    });
  },

  clinicalState: 'cycling',
  trackingGoal: 'track_only',
  clinicalCycleAnchorIso: null,
  setClinicalState: (clinicalState) => set({ clinicalState }),
  setTrackingGoal: (trackingGoal) => set({ trackingGoal }),
  setClinicalCycleAnchorIso: (clinicalCycleAnchorIso) => set({ clinicalCycleAnchorIso }),
  hydrateClinicalFromProfile: ({
    clinical_state,
    tracking_goal,
    clinical_cycle_anchor_iso,
  }) => {
    const cs =
      clinical_state === 'pregnant' ||
      clinical_state === 'postpartum' ||
      clinical_state === 'loss' ||
      clinical_state === 'cycling'
        ? clinical_state
        : 'cycling';
    const tg =
      tracking_goal === 'conceive' || tracking_goal === 'avoid' || tracking_goal === 'track_only'
        ? tracking_goal
        : 'track_only';
    const anchor =
      typeof clinical_cycle_anchor_iso === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(clinical_cycle_anchor_iso)
        ? clinical_cycle_anchor_iso
        : null;
    set({ clinicalState: cs, trackingGoal: tg, clinicalCycleAnchorIso: anchor });
  },
}));

export function getPreferencesSnapshot(): UserPreferences {
  return { ...useAppStore.getState().preferences };
}
