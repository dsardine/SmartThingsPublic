import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

import {
  calculateDynamicCycleAverage,
  estimatedOvulationFromProfileIntake,
} from '@/src/lib/algorithms';
import { parseInsightText } from '@/src/lib/cachedInsight';
import {
  addCalendarDays,
  formatCalendarDate,
  isoDateString,
  parseIsoDate,
} from '@/src/lib/dateDisplay';
import {
  collectGhostManualLogsForCycleAverage,
  GHOST_MANUAL_KEY_PREFIX,
} from '@/src/lib/manualGhostMerge';
import { ghostStorage } from '@/src/lib/storage';
import { persistDynamicCycleLengthAfterBleedingLog } from '@/src/lib/persistDynamicCycleLength';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import { colors } from '@/src/styles/theme';
import type {
  BbtTimeFormat,
  ManualLogBleeding,
  ManualLogCervicalFirmness,
  ManualLogCervicalFluid,
  ManualLogCervicalPosition,
  ManualLogDisturbance,
  ManualLogIntercourse,
} from '@/src/types/database';

const BLEEDING_OPTS: ManualLogBleeding[] = ['Spotting', 'Light', 'Medium', 'Heavy'];

/** Logged menstrual flow for period-end UI and inferred fill (excludes Spotting). */
function isLoggedMenstrualFlow(b: ManualLogBleeding | null): b is 'Light' | 'Medium' | 'Heavy' {
  return b === 'Light' || b === 'Medium' || b === 'Heavy';
}

function isoInMonthCursor(iso: string, monthCursor: Date): boolean {
  const d = parseIsoDate(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === monthCursor.getFullYear() && d.getMonth() === monthCursor.getMonth();
}

/**
 * Day-zero LMP lives on `profiles.last_period_date` only (no `manual_logs` row). When the user
 * views that month, show it as Light flow unless they already logged bleeding for that day.
 */
function mergeOnboardingLmpIntoMarkers(
  markers: LogMarker[],
  lmpIso: string | null,
  onboardingCompleted: boolean,
  monthCursor: Date,
): LogMarker[] {
  if (!onboardingCompleted || lmpIso == null || !/^\d{4}-\d{2}-\d{2}$/.test(lmpIso)) {
    return markers;
  }
  if (!isoInMonthCursor(lmpIso, monthCursor)) return markers;

  const byDate = new Map<string, LogMarker>();
  for (const m of markers) {
    byDate.set(m.date, m);
  }
  const existing = byDate.get(lmpIso);
  if (existing?.bleeding != null) {
    return [...markers].sort((a, b) => a.date.localeCompare(b.date));
  }
  if (existing) {
    byDate.set(lmpIso, { ...existing, bleeding: 'Light' });
  } else {
    byDate.set(lmpIso, { date: lmpIso, bleeding: 'Light', period_end: false });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

type BleedingRow = { date: string; bleeding: ManualLogBleeding | null };

function mergeBleedingByDateLastWins(rows: BleedingRow[]): Map<string, ManualLogBleeding | null> {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const map = new Map<string, ManualLogBleeding | null>();
  for (const r of sorted) {
    map.set(r.date, r.bleeding);
  }
  return map;
}

/**
 * Latest CD1: Light/Medium/Heavy when the prior calendar day is not Light/Medium/Heavy
 * (Spotting and missing days are treated like null for the prior-day check).
 * If none, uses onboarding `last_period_date` when provided.
 */
function findMostRecentCd1AnchorFromBleedingRows(
  rows: BleedingRow[],
  intakeLmpFallback: string | null,
): string | null {
  const byDate = mergeBleedingByDateLastWins(rows);
  const sortedDates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  const cd1s: string[] = [];
  for (const date of sortedDates) {
    const bleeding = byDate.get(date) ?? null;
    if (!isLoggedMenstrualFlow(bleeding)) continue;
    const prev = isoDateString(addCalendarDays(parseIsoDate(date), -1));
    const prevBleed = byDate.get(prev) ?? null;
    if (isLoggedMenstrualFlow(prevBleed)) continue;
    cd1s.push(date);
  }
  if (cd1s.length > 0) return cd1s[cd1s.length - 1]!;
  if (intakeLmpFallback && /^\d{4}-\d{2}-\d{2}$/.test(intakeLmpFallback)) return intakeLmpFallback;
  return null;
}

/** Estimated next period start through the following four days (5 days). */
function buildPredictedNextPeriodWindowSet(anchorCd1Iso: string, cycleLengthDays: number): Set<string> {
  const cl = Math.round(Number(cycleLengthDays));
  if (!Number.isFinite(cl) || cl < 21 || cl > 50) return new Set();
  const a = parseIsoDate(anchorCd1Iso);
  if (Number.isNaN(a.getTime())) return new Set();
  const nextStart = addCalendarDays(a, cl);
  const out = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    out.add(isoDateString(addCalendarDays(nextStart, i)));
  }
  return out;
}

const OVULATION_MARKER = '\u{1F338}';
const INTERCOURSE_OPTS: ManualLogIntercourse[] = ['Protected', 'Unprotected', 'Insemination'];
const FLUID_OPTS: ManualLogCervicalFluid[] = ['Dry', 'Sticky', 'Creamy', 'Eggwhite'];
const POS_OPTS: ManualLogCervicalPosition[] = ['High', 'Medium', 'Low'];
const FIRM_OPTS: ManualLogCervicalFirmness[] = ['Soft', 'Firm'];
const DIST_OPTS: ManualLogDisturbance[] = ['Fever', 'Alcohol', 'Poor Sleep', 'Travel'];

type LogMarker = {
  date: string;
  bleeding: ManualLogBleeding | null;
  period_end: boolean;
};

/** Every calendar ISO from `fromIso` through `toIso` (inclusive); requires `fromIso <= toIso`. */
function listIsoDaysInclusive(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let d = parseIsoDate(fromIso);
  for (;;) {
    const s = isoDateString(d);
    out.push(s);
    if (s >= toIso) break;
    d = addCalendarDays(d, 1);
  }
  return out;
}

/**
 * Logged bleeding per ISO (markers) + inferred gap-fill.
 * - `period_end`: bridges from the nearest prior Light/Medium/Heavy day (Spotting ignored for anchor).
 * - Intake-only: when there is no `period_end` anywhere but markers include onboarding LMP as flow,
 *   adds a short estimated menses tail (LMP+1 … LMP+4) on empty days so day-zero-only users still see inferred striping.
 * Inferred days skip any calendar day that already has bleeding logged (any intensity).
 */
function computeBleedingVisualSets(
  logs: LogMarker[],
  intakeLmpIso: string | null,
): {
  bleedingByIso: Map<string, ManualLogBleeding>;
  inferredFill: Set<string>;
} {
  const byDate = new Map<string, LogMarker>();
  for (const log of logs) {
    byDate.set(log.date, log);
  }

  const anyBleedDays = new Set<string>();
  const bleedingByIso = new Map<string, ManualLogBleeding>();
  for (const m of byDate.values()) {
    if (m.bleeding != null) {
      anyBleedDays.add(m.date);
      bleedingByIso.set(m.date, m.bleeding);
    }
  }

  const inferredFill = new Set<string>();
  for (const [e, m] of byDate) {
    if (!m.period_end) continue;
    let anchor: string | null = null;
    for (const [d, m2] of byDate) {
      if (d > e || !isLoggedMenstrualFlow(m2.bleeding)) continue;
      if (anchor == null || d > anchor) anchor = d;
    }
    if (anchor == null) continue;
    for (const d of listIsoDaysInclusive(anchor, e)) {
      if (!anyBleedDays.has(d)) inferredFill.add(d);
    }
  }

  const hasAnyPeriodEnd = [...byDate.values()].some((m) => m.period_end);
  const lmpInMarkers =
    intakeLmpIso != null &&
    /^\d{4}-\d{2}-\d{2}$/.test(intakeLmpIso) &&
    isLoggedMenstrualFlow(byDate.get(intakeLmpIso)?.bleeding ?? null);
  if (!hasAnyPeriodEnd && lmpInMarkers) {
    const lmpStart = parseIsoDate(intakeLmpIso);
    if (!Number.isNaN(lmpStart.getTime())) {
      for (let i = 1; i <= 4; i += 1) {
        const dIso = isoDateString(addCalendarDays(lmpStart, i));
        if (!anyBleedDays.has(dIso)) inferredFill.add(dIso);
      }
    }
  }

  return { bleedingByIso, inferredFill };
}

/**
 * Light/Medium/Heavy on the selected day (form overrides marker), or any such flow in the 14 calendar days
 * strictly before `selectedIso`. Spotting does not qualify.
 */
function hasBleedingForPeriodEndEligibility(
  selectedIso: string,
  markers: LogMarker[],
  bleedingOnSelectedFromForm: ManualLogBleeding | null,
): boolean {
  const byBleed = new Map<string, ManualLogBleeding | null>();
  for (const m of markers) {
    byBleed.set(m.date, m.bleeding);
  }
  const sameDayBleed = bleedingOnSelectedFromForm ?? byBleed.get(selectedIso) ?? null;
  if (isLoggedMenstrualFlow(sameDayBleed)) return true;

  const priorEnd = isoDateString(addCalendarDays(parseIsoDate(selectedIso), -1));
  const priorStart = isoDateString(addCalendarDays(parseIsoDate(selectedIso), -14));
  let d = parseIsoDate(priorStart);
  for (;;) {
    const iso = isoDateString(d);
    const b = byBleed.get(iso) ?? null;
    if (isLoggedMenstrualFlow(b)) return true;
    if (iso >= priorEnd) break;
    d = addCalendarDays(d, 1);
  }
  return false;
}

function renderBleedingBottomStripe(
  bleeding: ManualLogBleeding | undefined,
  isInferredFill: boolean,
): ReactNode {
  if (bleeding === 'Heavy') {
    return <View style={[styles.bleedStripeBase, { backgroundColor: colors.mutedCoral, opacity: 1 }]} />;
  }
  if (bleeding === 'Medium') {
    return <View style={[styles.bleedStripeBase, { backgroundColor: colors.mutedCoral, opacity: 0.7 }]} />;
  }
  if (bleeding === 'Light') {
    return <View style={[styles.bleedStripeBase, { backgroundColor: colors.mutedCoral, opacity: 0.4 }]} />;
  }
  if (bleeding === 'Spotting') {
    return <View style={[styles.bleedStripeBase, styles.bleedStripeSpotting]} />;
  }
  if (isInferredFill) {
    return <View style={[styles.bleedStripeBase, { backgroundColor: colors.mutedCoral, opacity: 0.3 }]} />;
  }
  return null;
}

type FormState = {
  manual_bbt: string;
  bbt_time_taken: string;
  exclude_temp: boolean;
  disturbances: ManualLogDisturbance[];
  cervical_position: ManualLogCervicalPosition | null;
  cervical_firmness: ManualLogCervicalFirmness | null;
  bleeding: ManualLogBleeding | null;
  /** Retro: last day of this period segment; calendar fills red stripe back to last bleeding day. */
  period_end: boolean;
  intercourse: ManualLogIntercourse | null;
  cervical_fluid: ManualLogCervicalFluid | null;
  symptoms: string;
  test_results: string;
};

type TempUnit = 'F' | 'C';

function formatHHMM(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function defaultBbtString(unit: TempUnit): string {
  return unit === 'F' ? '98.60' : '37.00';
}

function normalizeHHMM(input: string): string {
  const p = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!p) return formatHHMM(new Date());
  const h = Math.min(23, Math.max(0, parseInt(p[1], 10)));
  const m = Math.min(59, Math.max(0, parseInt(p[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseBbtTimeToDate(hhmm: string): Date {
  const d = new Date();
  const p = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (p) {
    d.setHours(parseInt(p[1], 10), parseInt(p[2], 10), 0, 0);
  }
  return d;
}

/** Hundredths labels for the right-hand BBT wheel (00–99). */
const BBT_FRAC_PICKER_VALUES: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i <= 99; i += 1) out.push(String(i).padStart(2, '0'));
  return out;
})();

function bbtWholePickerValues(unit: TempUnit): string[] {
  if (unit === 'F') {
    const a: string[] = [];
    for (let w = 96; w <= 101; w += 1) a.push(String(w));
    return a;
  }
  const a: string[] = [];
  for (let w = 35; w <= 40; w += 1) a.push(String(w));
  return a;
}

/** Split stored `manual_bbt` (e.g. `98.60`) into whole + two-digit fractional part for dual pickers. */
function splitManualBbt(s: string): { whole: string; frac: string } {
  const t = String(s ?? '').trim();
  if (!t) return { whole: '', frac: '00' };
  const dot = t.indexOf('.');
  const ws = dot >= 0 ? t.slice(0, dot) : t;
  const fs = dot >= 0 ? t.slice(dot + 1) : '';
  if (!/^\d+$/.test(ws)) return { whole: '', frac: '00' };
  const fracDigits = (fs.replace(/\D/g, '') + '00').slice(0, 2).padEnd(2, '0');
  return { whole: ws, frac: fracDigits };
}

/** `hh:mm` 24h → display string per menu preference (storage stays 24h). */
function formatBbtTimeDisplay(hhmm24: string, pref: BbtTimeFormat): string {
  const n = normalizeHHMM(hhmm24);
  if (pref === '24h') return n;
  const p = n.match(/^(\d{1,2}):(\d{2})$/);
  if (!p) return n;
  const h = parseInt(p[1], 10);
  const m = p[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ap}`;
}

/** Maps a stored or typed value onto the picker grid (0.01° within range). */
function coerceBbtForPicker(value: unknown, unit: TempUnit): string {
  const n = Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(n)) return '';
  const startH = unit === 'F' ? 9600 : 3550;
  const endH = unit === 'F' ? 10100 : 4000;
  const nh = Math.round(n * 100);
  const clampedH = Math.min(endH, Math.max(startH, nh));
  return (clampedH / 100).toFixed(2);
}

function defaultForm(unit: TempUnit, patch: Partial<FormState> = {}): FormState {
  return {
    /** Empty = no reading; never default to a numeric temp (would persist on save unchanged). */
    manual_bbt: '',
    bbt_time_taken: formatHHMM(new Date()),
    exclude_temp: false,
    disturbances: [],
    cervical_position: null,
    cervical_firmness: null,
    bleeding: null,
    period_end: false,
    intercourse: null,
    cervical_fluid: null,
    symptoms: '',
    test_results: '',
    ...patch,
  };
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

const GRID_PAD = 16;

export default function CalendarScreen() {
  const firstDayOfWeek = useAppStore((s) => s.preferences.firstDayOfWeek);
  const dateFormat = useAppStore((s) => s.preferences.dateFormat);
  const bbtTimeFormat = useAppStore((s) => s.preferences.bbtTimeFormat);
  const temperatureUnit = useAppStore((s) => s.preferences.temperatureUnit);
  const isGhost = useAppStore((s) => s.isGhostModeEnabled);
  const tempUnit: TempUnit = temperatureUnit === 'C' ? 'C' : 'F';

  const cell = useMemo(() => {
    const w = Dimensions.get('window').width - GRID_PAD;
    return Math.max(40, Math.floor(w / 7));
  }, []);

  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [fertileStart, setFertileStart] = useState<string | null>(null);
  const [fertileEnd, setFertileEnd] = useState<string | null>(null);
  const [estimatedOvulationIso, setEstimatedOvulationIso] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedIso, setSelectedIso] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => defaultForm('F'));
  const [saving, setSaving] = useState(false);
  /** Android: never mount DateTimePicker until user asks — inline mount opens a dialog and re-opens on every re-render. */
  const [androidTimePickerVisible, setAndroidTimePickerVisible] = useState(false);
  const [monthLogMarkers, setMonthLogMarkers] = useState<LogMarker[]>([]);
  /** Profiles `last_period_date` (onboarding LMP); used to pre-fill the log sheet on that day. */
  const [intakeLmpIso, setIntakeLmpIso] = useState<string | null>(null);
  /** Next-period estimate: anchor CD1 + `cycleLengthAvg`, for 5 days (hollow cells when no logged bleed). */
  const [predictedPeriodWindow, setPredictedPeriodWindow] = useState(() => new Set<string>());
  const cycleLengthAvg = useAppStore((s) => s.cycleLengthAvg);

  useEffect(() => {
    if (!sheetOpen) setAndroidTimePickerVisible(false);
  }, [sheetOpen]);

  const { bleedingByIso, inferredFill } = useMemo(
    () => computeBleedingVisualSets(monthLogMarkers, intakeLmpIso),
    [monthLogMarkers, intakeLmpIso],
  );

  const loadFertile = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setFertileStart(null);
      setFertileEnd(null);
      setEstimatedOvulationIso(null);
      return;
    }
    const [{ data: insightRow }, { data: profileRow }] = await Promise.all([
      supabase
        .from('cached_insight')
        .select('insight_text')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('last_period_date, cycle_length_avg, onboarding_completed')
        .eq('id', user.id)
        .maybeSingle(),
    ]);

    const ovFromInsight = insightRow?.insight_text
      ? parseInsightText(insightRow.insight_text).estimatedOvulationDate
      : null;

    if (ovFromInsight) {
      setEstimatedOvulationIso(ovFromInsight);
      const o = parseIsoDate(ovFromInsight);
      setFertileStart(isoDateString(addCalendarDays(o, -5)));
      setFertileEnd(isoDateString(addCalendarDays(o, 1)));
      return;
    }

    const pr = profileRow as {
      last_period_date?: string | null;
      cycle_length_avg?: number | null;
      onboarding_completed?: boolean | null;
    } | null;

    if (pr?.onboarding_completed === true && typeof pr.last_period_date === 'string') {
      const cycleAvg = useAppStore.getState().cycleLengthAvg;
      const est = estimatedOvulationFromProfileIntake({
        last_period_date: pr.last_period_date,
        cycle_length_avg: cycleAvg,
      });
      if (est) {
        setEstimatedOvulationIso(est);
        const o = parseIsoDate(est);
        setFertileStart(isoDateString(addCalendarDays(o, -5)));
        setFertileEnd(isoDateString(addCalendarDays(o, 1)));
        return;
      }
    }

    setFertileStart(null);
    setFertileEnd(null);
    setEstimatedOvulationIso(null);
  }, []);

  const refreshPredictedPeriodWindow = useCallback(async (intakeLmpForFallback: string | null) => {
    const cl = Math.round(Number(useAppStore.getState().cycleLengthAvg));
    if (!Number.isFinite(cl) || cl < 21 || cl > 50) {
      setPredictedPeriodWindow(new Set());
      return;
    }

    const rows: BleedingRow[] = [];

    if (isGhost) {
      for (const key of ghostStorage.getAllKeys()) {
        if (!key.startsWith(GHOST_MANUAL_KEY_PREFIX)) continue;
        const iso = key.slice(GHOST_MANUAL_KEY_PREFIX.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
        const raw = ghostStorage.getString(key);
        if (!raw) continue;
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          rows.push({
            date: iso,
            bleeding: (o.bleeding as ManualLogBleeding) ?? null,
          });
        } catch {
          /* ignore */
        }
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const anchorG = findMostRecentCd1AnchorFromBleedingRows(rows, intakeLmpForFallback);
      if (!anchorG) {
        setPredictedPeriodWindow(new Set());
        return;
      }
      setPredictedPeriodWindow(buildPredictedNextPeriodWindowSet(anchorG, cl));
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setPredictedPeriodWindow(new Set());
      return;
    }
    const minIso = isoDateString(addCalendarDays(new Date(), -730));
    const { data: bleedRows, error: bleedErr } = await supabase
      .from('manual_logs')
      .select('date, bleeding')
      .eq('user_id', user.id)
      .gte('date', minIso)
      .order('date', { ascending: true });
    if (bleedErr || !bleedRows) {
      setPredictedPeriodWindow(new Set());
      return;
    }
    for (const r of bleedRows) {
      const row = r as Record<string, unknown>;
      rows.push({
        date: String(row.date),
        bleeding: (row.bleeding as ManualLogBleeding) ?? null,
      });
    }
    const anchor = findMostRecentCd1AnchorFromBleedingRows(rows, intakeLmpForFallback);
    if (!anchor) {
      setPredictedPeriodWindow(new Set());
      return;
    }
    setPredictedPeriodWindow(buildPredictedNextPeriodWindowSet(anchor, cl));
  }, [isGhost]);

  const loadMonthBleedingMarkers = useCallback(async () => {
    const first = startOfMonth(monthCursor);
    const last = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);
    const rangeStart = addCalendarDays(first, -45);
    const startIso = isoDateString(rangeStart);
    const endIso = isoDateString(last);

    const readIntakeLmp = async (
      userId: string,
    ): Promise<{ lmp: string | null; onboardingCompleted: boolean }> => {
      const { data: pr } = await supabase
        .from('profiles')
        .select('last_period_date, onboarding_completed')
        .eq('id', userId)
        .maybeSingle();
      const row = pr as { last_period_date?: string | null; onboarding_completed?: boolean } | null;
      const lmp =
        typeof row?.last_period_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.last_period_date)
          ? row.last_period_date
          : null;
      return { lmp, onboardingCompleted: row?.onboarding_completed === true };
    };

    if (isGhost) {
      const markers: LogMarker[] = [];
      for (const key of ghostStorage.getAllKeys()) {
        if (!key.startsWith(GHOST_MANUAL_KEY_PREFIX)) continue;
        const iso = key.slice(GHOST_MANUAL_KEY_PREFIX.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso < startIso || iso > endIso) continue;
        const raw = ghostStorage.getString(key);
        if (!raw) continue;
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          markers.push({
            date: iso,
            bleeding: (o.bleeding as ManualLogBleeding) ?? null,
            period_end: o.period_end === true,
          });
        } catch {
          /* ignore */
        }
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      let lmp: string | null = null;
      let ob = false;
      if (user) {
        const row = await readIntakeLmp(user.id);
        lmp = row.lmp;
        ob = row.onboardingCompleted;
      } else {
        setIntakeLmpIso(null);
        setMonthLogMarkers(markers);
        setPredictedPeriodWindow(new Set());
        return;
      }
      setIntakeLmpIso(lmp);
      setMonthLogMarkers(mergeOnboardingLmpIntoMarkers(markers, lmp, ob, monthCursor));
      void refreshPredictedPeriodWindow(lmp);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setMonthLogMarkers([]);
      setIntakeLmpIso(null);
      setPredictedPeriodWindow(new Set());
      return;
    }

    const [{ data, error }, intake] = await Promise.all([
      supabase
        .from('manual_logs')
        .select('date, bleeding, period_end')
        .eq('user_id', user.id)
        .gte('date', startIso)
        .lte('date', endIso),
      readIntakeLmp(user.id),
    ]);
    if (error) {
      setMonthLogMarkers([]);
      setIntakeLmpIso(intake.lmp);
      void refreshPredictedPeriodWindow(intake.lmp);
      return;
    }
    const markers = (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        date: String(row.date),
        bleeding: (row.bleeding as ManualLogBleeding) ?? null,
        period_end: row.period_end === true,
      };
    });
    setIntakeLmpIso(intake.lmp);
    setMonthLogMarkers(mergeOnboardingLmpIntoMarkers(markers, intake.lmp, intake.onboardingCompleted, monthCursor));
    void refreshPredictedPeriodWindow(intake.lmp);
  }, [monthCursor, isGhost, refreshPredictedPeriodWindow]);

  useEffect(() => {
    void loadMonthBleedingMarkers();
  }, [loadMonthBleedingMarkers]);

  useEffect(() => {
    void refreshPredictedPeriodWindow(intakeLmpIso);
  }, [cycleLengthAvg, intakeLmpIso, refreshPredictedPeriodWindow]);

  useFocusEffect(
    useCallback(() => {
      void loadFertile();
      void loadMonthBleedingMarkers();
    }, [loadFertile, loadMonthBleedingMarkers]),
  );

  const monthLabel = useMemo(
    () =>
      monthCursor.toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
    [monthCursor],
  );

  const showPeriodEndToggle = useMemo(() => {
    if (!sheetOpen || !selectedIso) return false;
    return hasBleedingForPeriodEndEligibility(selectedIso, monthLogMarkers, form.bleeding);
  }, [sheetOpen, selectedIso, monthLogMarkers, form.bleeding]);

  useEffect(() => {
    if (!sheetOpen || !selectedIso) return;
    if (!showPeriodEndToggle && form.period_end) {
      setForm((f) => ({ ...f, period_end: false }));
    }
  }, [sheetOpen, selectedIso, showPeriodEndToggle, form.period_end]);

  const grid = useMemo(() => {
    const first = startOfMonth(monthCursor);
    const dim = daysInMonth(monthCursor);
    const jsDow = first.getDay();
    const leading =
      firstDayOfWeek === 'Monday' ? (jsDow === 0 ? 6 : jsDow - 1) : jsDow;
    const cells: ({ type: 'blank' } | { type: 'day'; iso: string; day: number })[] = [];
    for (let i = 0; i < leading; i++) cells.push({ type: 'blank' });
    for (let d = 1; d <= dim; d++) {
      const dt = new Date(first.getFullYear(), first.getMonth(), d);
      cells.push({ type: 'day', iso: isoDateString(dt), day: d });
    }
    while (cells.length % 7 !== 0) cells.push({ type: 'blank' });
    while (cells.length < 42) cells.push({ type: 'blank' });
    return cells;
  }, [monthCursor, firstDayOfWeek]);

  const isFertile = (iso: string) => {
    if (!fertileStart || !fertileEnd) return false;
    return iso >= fertileStart && iso <= fertileEnd;
  };

  const openForDate = async (iso: string) => {
    setSelectedIso(iso);
    setAndroidTimePickerVisible(false);
    setForm(defaultForm(tempUnit));
    if (isGhost) {
      const raw = ghostStorage.getString(`${GHOST_MANUAL_KEY_PREFIX}${iso}`);
      let ghostParsed = false;
      if (raw) {
        try {
          const o = JSON.parse(raw) as Record<string, unknown>;
          const base = defaultForm(tempUnit);
          const mb =
            typeof o.manual_bbt === 'string'
              ? o.manual_bbt
              : o.manual_bbt != null
                ? String(o.manual_bbt)
                : '';
          setForm({
            ...base,
            manual_bbt: mb.trim() !== '' ? coerceBbtForPicker(mb, tempUnit) : '',
            bbt_time_taken:
              typeof o.bbt_time_taken === 'string' && /^\d{1,2}:\d{2}$/.test(o.bbt_time_taken.trim())
                ? normalizeHHMM(o.bbt_time_taken)
                : base.bbt_time_taken,
            exclude_temp: o.exclude_temp === true,
            disturbances: Array.isArray(o.disturbances)
              ? (o.disturbances as ManualLogDisturbance[])
              : [],
            cervical_position: (o.cervical_position as ManualLogCervicalPosition) ?? null,
            cervical_firmness: (o.cervical_firmness as ManualLogCervicalFirmness) ?? null,
            bleeding: (o.bleeding as ManualLogBleeding) ?? null,
            period_end: o.period_end === true,
            intercourse: (o.intercourse as ManualLogIntercourse) ?? null,
            cervical_fluid: (o.cervical_fluid as ManualLogCervicalFluid) ?? null,
            symptoms: Array.isArray(o.symptoms)
              ? (o.symptoms as string[]).join(', ')
              : typeof o.symptoms === 'string'
                ? o.symptoms
                : '',
            test_results: Array.isArray(o.test_results)
              ? (o.test_results as string[]).join(', ')
              : typeof o.test_results === 'string'
                ? o.test_results
                : '',
          });
          ghostParsed = true;
        } catch {
          /* ignore */
        }
      }
      if (!ghostParsed && intakeLmpIso === iso) {
        setForm(defaultForm(tempUnit, { bleeding: 'Light' }));
      }
      setSheetOpen(true);
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSheetOpen(true);
      return;
    }
    const { data } = await supabase
      .from('manual_logs')
      .select('*')
      .eq('user_id', user.id)
      .eq('date', iso)
      .maybeSingle();
    if (data) {
      const r = data as Record<string, unknown>;
      const timeStr =
        typeof r.bbt_time_taken === 'string' && String(r.bbt_time_taken).length >= 5
          ? String(r.bbt_time_taken).slice(0, 5)
          : formatHHMM(new Date());
      setForm({
        manual_bbt:
          r.manual_bbt != null && String(r.manual_bbt).trim() !== ''
            ? coerceBbtForPicker(r.manual_bbt, tempUnit)
            : '',
        bbt_time_taken: normalizeHHMM(timeStr),
        exclude_temp: r.exclude_temp === true,
        disturbances: Array.isArray(r.disturbances) ? (r.disturbances as ManualLogDisturbance[]) : [],
        cervical_position: (r.cervical_position as ManualLogCervicalPosition) ?? null,
        cervical_firmness: (r.cervical_firmness as ManualLogCervicalFirmness) ?? null,
        bleeding:
          (r.bleeding as ManualLogBleeding) != null
            ? (r.bleeding as ManualLogBleeding)
            : intakeLmpIso === iso
              ? 'Light'
              : null,
        period_end: r.period_end === true,
        intercourse: (r.intercourse as ManualLogIntercourse) ?? null,
        cervical_fluid: (r.cervical_fluid as ManualLogCervicalFluid) ?? null,
        symptoms: Array.isArray(r.symptoms) ? (r.symptoms as string[]).join(', ') : '',
        test_results: Array.isArray(r.test_results) ? (r.test_results as string[]).join(', ') : '',
      });
    } else if (intakeLmpIso === iso) {
      setForm(defaultForm(tempUnit, { bleeding: 'Light' }));
    }
    setSheetOpen(true);
  };

  const save = async () => {
    if (!selectedIso) return;
    setSaving(true);
    try {
      const symptomsArr = form.symptoms
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const testsArr = form.test_results
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (isGhost) {
        ghostStorage.set(
          `${GHOST_MANUAL_KEY_PREFIX}${selectedIso}`,
          JSON.stringify({
            ...form,
            symptoms: symptomsArr,
            test_results: testsArr,
          }),
        );
        void loadMonthBleedingMarkers();
        await persistDynamicCycleLengthAfterBleedingLog({ isGhost: true, userId: null });
        void loadFertile();
        setSheetOpen(false);
        return;
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const row = {
        user_id: user.id,
        date: selectedIso,
        manual_bbt: form.manual_bbt === '' ? null : Number(form.manual_bbt),
        bbt_time_taken: form.bbt_time_taken ? `${form.bbt_time_taken}:00` : null,
        exclude_temp: form.exclude_temp,
        disturbances: form.disturbances.length ? form.disturbances : null,
        cervical_position: form.cervical_position,
        cervical_firmness: form.cervical_firmness,
        bleeding: form.bleeding,
        period_end: form.period_end,
        intercourse: form.intercourse,
        cervical_fluid: form.cervical_fluid,
        symptoms: symptomsArr.length ? symptomsArr : null,
        test_results: testsArr.length ? testsArr : null,
      };
      const { data: existing } = await supabase
        .from('manual_logs')
        .select('id')
        .eq('user_id', user.id)
        .eq('date', selectedIso)
        .maybeSingle();
      if (existing?.id) {
        await supabase.from('manual_logs').update(row).eq('id', existing.id);
      } else {
        await supabase.from('manual_logs').insert(row);
      }
      void loadMonthBleedingMarkers();
      await persistDynamicCycleLengthAfterBleedingLog({ isGhost: false, userId: user.id });
      void loadFertile();
      setSheetOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const weekHeader =
    firstDayOfWeek === 'Monday'
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const toggleDist = (d: ManualLogDisturbance) => {
    setForm((f) => ({
      ...f,
      disturbances: f.disturbances.includes(d)
        ? f.disturbances.filter((x) => x !== d)
        : [...f.disturbances, d],
    }));
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
            <Text style={styles.navBtn}>‹</Text>
          </Pressable>
          <Text style={styles.monthTitle}>{monthLabel}</Text>
          <Pressable onPress={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
            <Text style={styles.navBtn}>›</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          {isGhost ? 'Ghost Mode: entries stay on-device only.' : 'Entries sync to your manual log.'}
        </Text>

        <View style={styles.weekRow}>
          {weekHeader.map((w) => (
            <Text key={w} style={[styles.weekLbl, { width: cell }]}>
              {w}
            </Text>
          ))}
        </View>

        <View style={[styles.grid, { paddingHorizontal: GRID_PAD / 2 }]}>
          {grid.map((c, idx) =>
            c.type === 'blank' ? (
              <View key={`b-${idx}`} style={{ width: cell, height: cell }} />
            ) : (
              <Pressable
                key={c.iso}
                onPress={() => void openForDate(c.iso)}
                style={[
                  styles.cell,
                  { width: cell, height: cell },
                  isFertile(c.iso) && styles.fertile,
                  predictedPeriodWindow.has(c.iso) &&
                    !bleedingByIso.has(c.iso) &&
                    styles.cellPredictedHollow,
                ]}>
                <View style={styles.cellInner}>
                  <View style={styles.cellBody}>
                    {estimatedOvulationIso === c.iso ? (
                      <Text style={styles.ovMarker} accessibilityLabel="Estimated ovulation">
                        {OVULATION_MARKER}
                      </Text>
                    ) : null}
                    <Text style={styles.dayNum}>{c.day}</Text>
                  </View>
                  {renderBleedingBottomStripe(
                    bleedingByIso.get(c.iso),
                    inferredFill.has(c.iso),
                  )}
                </View>
              </Pressable>
            ),
          )}
        </View>

        <CalendarLegend />
      </ScrollView>

      <Modal visible={sheetOpen} animationType="slide" transparent onRequestClose={() => setSheetOpen(false)}>
        <View style={styles.modalRoot}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheetOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              {selectedIso
                ? formatCalendarDate(parseIsoDate(selectedIso), dateFormat, true)
                : 'Log'}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
              <Field label={`Manual BBT (°${tempUnit})`}>
                {Platform.OS === 'web' ? (
                  <View style={styles.bbtDualRow}>
                    <TextInput
                      keyboardType="number-pad"
                      value={splitManualBbt(form.manual_bbt).whole}
                      onChangeText={(t) => {
                        const digits = t.replace(/\D/g, '').slice(0, 3);
                        setForm((f) => {
                          if (digits === '') return { ...f, manual_bbt: '' };
                          const fr = splitManualBbt(f.manual_bbt).frac;
                          return {
                            ...f,
                            manual_bbt: coerceBbtForPicker(`${digits}.${fr}`, tempUnit),
                          };
                        });
                      }}
                      placeholder="—"
                      style={[styles.input, styles.bbtWebPart]}
                    />
                    <Text style={styles.bbtDecDot}>.</Text>
                    <TextInput
                      keyboardType="number-pad"
                      maxLength={2}
                      value={splitManualBbt(form.manual_bbt).whole === '' ? '' : splitManualBbt(form.manual_bbt).frac}
                      onChangeText={(t) => {
                        const digits = t.replace(/\D/g, '').slice(0, 2);
                        setForm((f) => {
                          const sp = splitManualBbt(f.manual_bbt);
                          if (!sp.whole) return f;
                          const fr = (digits + '00').slice(0, 2).padEnd(2, '0');
                          return {
                            ...f,
                            manual_bbt: coerceBbtForPicker(`${sp.whole}.${fr}`, tempUnit),
                          };
                        });
                      }}
                      placeholder="00"
                      style={[styles.input, styles.bbtWebPart]}
                      editable={splitManualBbt(form.manual_bbt).whole !== ''}
                    />
                  </View>
                ) : (
                  <View style={[styles.pickerWrap, styles.bbtDualRow]}>
                    <Picker
                      style={styles.bbtDualPicker}
                      itemStyle={Platform.OS === 'ios' ? styles.pickerItemIos : undefined}
                      selectedValue={splitManualBbt(form.manual_bbt).whole}
                      onValueChange={(w) => {
                        setForm((f) => {
                          if (w === '') return { ...f, manual_bbt: '' };
                          const sp = splitManualBbt(f.manual_bbt);
                          const frac = sp.whole === w ? sp.frac : '00';
                          return { ...f, manual_bbt: coerceBbtForPicker(`${w}.${frac}`, tempUnit) };
                        });
                      }}>
                      <Picker.Item label="No reading" value="" color={colors.textDark} />
                      {bbtWholePickerValues(tempUnit).map((w) => (
                        <Picker.Item key={w} label={`${w}°`} value={w} color={colors.textDark} />
                      ))}
                    </Picker>
                    <Text style={styles.bbtDecDot}>.</Text>
                    <Picker
                      style={styles.bbtDualPicker}
                      itemStyle={Platform.OS === 'ios' ? styles.pickerItemIos : undefined}
                      selectedValue={
                        splitManualBbt(form.manual_bbt).whole === '' ? '00' : splitManualBbt(form.manual_bbt).frac
                      }
                      enabled={splitManualBbt(form.manual_bbt).whole !== ''}
                      onValueChange={(fr) => {
                        setForm((f) => {
                          const sp = splitManualBbt(f.manual_bbt);
                          if (!sp.whole) return f;
                          return { ...f, manual_bbt: coerceBbtForPicker(`${sp.whole}.${fr}`, tempUnit) };
                        });
                      }}>
                      {BBT_FRAC_PICKER_VALUES.map((fr) => (
                        <Picker.Item key={fr} label={fr} value={fr} color={colors.textDark} />
                      ))}
                    </Picker>
                  </View>
                )}
              </Field>
              <Field label="Time taken">
                {Platform.OS === 'web' ? (
                  <>
                    <TextInput
                      value={form.bbt_time_taken}
                      onChangeText={(t) => setForm((f) => ({ ...f, bbt_time_taken: normalizeHHMM(t) }))}
                      placeholder={formatHHMM(new Date())}
                      style={styles.input}
                    />
                    {bbtTimeFormat === '12h' ? (
                      <Text style={styles.fieldHint}>
                        Enter 24-hour time (e.g. 14:30); the chip uses your Menu 12h/24h preference.
                      </Text>
                    ) : null}
                  </>
                ) : Platform.OS === 'android' ? (
                  <View>
                    <Pressable
                      style={styles.timeChip}
                      onPress={() => setAndroidTimePickerVisible(true)}
                      accessibilityRole="button"
                      accessibilityLabel="Choose time taken">
                      <Text style={styles.timeChipTxt}>
                        {formatBbtTimeDisplay(form.bbt_time_taken, bbtTimeFormat)}
                      </Text>
                    </Pressable>
                    {androidTimePickerVisible ? (
                      <DateTimePicker
                        value={parseBbtTimeToDate(form.bbt_time_taken)}
                        mode="time"
                        display="default"
                        themeVariant="light"
                        onChange={(event, date) => {
                          setAndroidTimePickerVisible(false);
                          if (event.type === 'dismissed') return;
                          if (date) setForm((f) => ({ ...f, bbt_time_taken: formatHHMM(date) }));
                        }}
                      />
                    ) : null}
                    <Text style={styles.fieldHint}>Saved as 24-hour; chip follows your time format preference.</Text>
                  </View>
                ) : (
                  <View>
                    <DateTimePicker
                      value={parseBbtTimeToDate(form.bbt_time_taken)}
                      mode="time"
                      display="spinner"
                      themeVariant="light"
                      onChange={(_, date) => {
                        if (date) setForm((f) => ({ ...f, bbt_time_taken: formatHHMM(date) }));
                      }}
                    />
                    <Text style={styles.fieldHint}>
                      Saved as {form.bbt_time_taken} (24h). Shown:{' '}
                      {formatBbtTimeDisplay(form.bbt_time_taken, bbtTimeFormat)}
                    </Text>
                  </View>
                )}
              </Field>
              <View style={styles.rowBetween}>
                <Text style={styles.fieldLbl}>Exclude temp from chart</Text>
                <Switch
                  value={form.exclude_temp}
                  onValueChange={(v) => setForm((f) => ({ ...f, exclude_temp: v }))}
                  trackColor={{ true: colors.primarySageGreen, false: colors.chartGrid }}
                />
              </View>
              <Field label="Disturbances">
                <View style={styles.chips}>
                  {DIST_OPTS.map((d) => (
                    <Pressable
                      key={d}
                      onPress={() => toggleDist(d)}
                      style={[styles.chip, form.disturbances.includes(d) && styles.chipOn]}>
                      <Text style={[styles.chipTxt, form.disturbances.includes(d) && styles.chipTxtOn]}>
                        {d}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Field>
              <EnumRow
                label="Cervical position"
                options={POS_OPTS}
                value={form.cervical_position}
                onChange={(v) => setForm((f) => ({ ...f, cervical_position: v }))}
              />
              <EnumRow
                label="Cervical firmness"
                options={FIRM_OPTS}
                value={form.cervical_firmness}
                onChange={(v) => setForm((f) => ({ ...f, cervical_firmness: v }))}
              />
              <EnumRow
                label="Bleeding"
                options={BLEEDING_OPTS}
                value={form.bleeding}
                onChange={(v) => setForm((f) => ({ ...f, bleeding: v }))}
              />
              {showPeriodEndToggle ? (
                <>
                  <View style={styles.rowBetween}>
                    <Text style={styles.fieldLbl}>Period ended today</Text>
                    <Switch
                      value={form.period_end}
                      onValueChange={(v) => setForm((f) => ({ ...f, period_end: v }))}
                      trackColor={{ true: colors.primarySageGreen, false: colors.chartGrid }}
                    />
                  </View>
                  <Text style={styles.periodEndHint}>
                    Marks the last day of this flow. The calendar fills a muted-coral bridge from your last
                    logged Light–Heavy day through gap days (Spotting does not anchor the bridge).
                  </Text>
                </>
              ) : null}
              <EnumRow
                label="Intercourse"
                options={INTERCOURSE_OPTS}
                value={form.intercourse}
                onChange={(v) => setForm((f) => ({ ...f, intercourse: v }))}
              />
              <EnumRow
                label="Cervical fluid"
                options={FLUID_OPTS}
                value={form.cervical_fluid}
                onChange={(v) => setForm((f) => ({ ...f, cervical_fluid: v }))}
              />
              <Field label="Symptoms (comma-separated)">
                <TextInput
                  value={form.symptoms}
                  onChangeText={(t) => setForm((f) => ({ ...f, symptoms: t }))}
                  style={styles.input}
                  placeholder="Fatigue, cramping…"
                />
              </Field>
              <Field label="Test results (comma-separated)">
                <TextInput
                  value={form.test_results}
                  onChangeText={(t) => setForm((f) => ({ ...f, test_results: t }))}
                  style={styles.input}
                  placeholder="LH strip, HCG…"
                />
              </Field>
              <Pressable style={styles.saveBtn} onPress={() => void save()} disabled={saving}>
                <Text style={styles.saveTxt}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function CalendarLegend() {
  return (
    <View style={styles.legendWrap}>
      <Text style={styles.legendTitle}>Legend</Text>
      <View style={styles.legendGrid}>
        <LegendItem
          label="Fertile window"
          swatch={<View style={styles.legendSwatchFertile} />}
        />
        <LegendItem
          label="Estimated ovulation"
          swatch={<Text style={styles.legendOvSwatch}>{OVULATION_MARKER}</Text>}
        />
        <LegendItem
          label="Menstrual flow (heavy → light)"
          swatch={
            <View style={styles.legendFlowBar}>
              <View style={[styles.legendFlowSeg, { opacity: 1 }]} />
              <View style={[styles.legendFlowSeg, { opacity: 0.7 }]} />
              <View style={[styles.legendFlowSeg, { opacity: 0.4 }]} />
            </View>
          }
        />
        <LegendItem label="Spotting" swatch={<View style={styles.legendSpotSwatch} />} />
        <LegendItem
          label="Inferred period"
          swatch={<View style={styles.legendInferredSwatch} />}
        />
        <LegendItem
          label="Predicted period"
          swatch={<View style={styles.legendPredictedSwatch} />}
        />
      </View>
    </View>
  );
}

function LegendItem({ label, swatch }: { label: string; swatch: ReactNode }) {
  return (
    <View style={styles.legendItem}>
      {swatch}
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLbl}>{label}</Text>
      {children}
    </View>
  );
}

function EnumRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T | null;
  onChange: (v: T | null) => void;
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.fieldLbl}>{label}</Text>
      <View style={styles.chips}>
        <Pressable onPress={() => onChange(null)} style={[styles.chip, value == null && styles.chipOn]}>
          <Text style={[styles.chipTxt, value == null && styles.chipTxtOn]}>—</Text>
        </Pressable>
        {options.map((o) => (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            style={[styles.chip, value === o && styles.chipOn]}>
            <Text style={[styles.chipTxt, value === o && styles.chipTxtOn]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  mainScroll: { flex: 1 },
  mainScrollContent: { flexGrow: 1, paddingBottom: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  navBtn: { fontSize: 28, color: colors.primarySageGreen, paddingHorizontal: 12 },
  monthTitle: { fontSize: 20, fontWeight: '800', color: colors.textDark },
  hint: { paddingHorizontal: 16, marginTop: 6, color: colors.textMuted, fontSize: 13 },
  weekRow: { flexDirection: 'row', marginTop: 12, justifyContent: 'center' },
  weekLbl: { textAlign: 'center', fontSize: 12, fontWeight: '700', color: colors.textMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  cell: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.chartGrid,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fertile: { backgroundColor: colors.fertileTint },
  /** Coral outline only so fertile tint (`fertile`) still shows when both apply. */
  cellPredictedHollow: {
    borderWidth: 1,
    borderColor: colors.mutedCoral,
  },
  cellInner: {
    flex: 1,
    width: '100%',
    justifyContent: 'space-between',
    alignItems: 'center',
    position: 'relative',
  },
  cellBody: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 2,
  },
  dayNum: { fontSize: 16, fontWeight: '700', color: colors.textDark },
  ovMarker: { fontSize: 11, lineHeight: 13, opacity: 0.88, marginBottom: 1 },
  bleedStripeBase: {
    position: 'absolute',
    bottom: 4,
    left: 5,
    right: 5,
    height: 6,
    borderRadius: 2,
  },
  bleedStripeSpotting: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.mutedCoral,
  },
  legendWrap: {
    marginTop: 14,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.chartGrid,
  },
  legendTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.textDark,
    marginBottom: 4,
  },
  legendGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    rowGap: 12,
    columnGap: 0,
  },
  legendItem: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 10,
    columnGap: 8,
  },
  legendLabel: {
    flex: 1,
    flexShrink: 1,
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '600',
  },
  legendSwatchFertile: {
    width: 18,
    height: 18,
    borderRadius: 4,
    backgroundColor: 'rgba(156, 174, 150, 0.42)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(156, 174, 150, 0.55)',
  },
  legendOvSwatch: { fontSize: 14, width: 22, textAlign: 'center' },
  legendFlowBar: { flexDirection: 'row', width: 38, height: 10, borderRadius: 2, overflow: 'hidden' },
  legendFlowSeg: {
    flex: 1,
    marginHorizontal: 1,
    backgroundColor: colors.mutedCoral,
    borderRadius: 1,
  },
  legendSpotSwatch: {
    width: 28,
    height: 10,
    borderRadius: 2,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.mutedCoral,
    backgroundColor: 'transparent',
  },
  legendInferredSwatch: {
    width: 28,
    height: 10,
    borderRadius: 2,
    backgroundColor: colors.mutedCoral,
    opacity: 0.3,
  },
  legendPredictedSwatch: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.mutedCoral,
    backgroundColor: 'transparent',
  },
  periodEndHint: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
    marginBottom: 12,
    marginTop: -6,
  },
  modalRoot: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: colors.textDark, marginBottom: 12 },
  fieldLbl: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  fieldHint: { fontSize: 12, color: colors.textMuted, marginTop: 6, lineHeight: 17 },
  bbtDualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: '100%',
  },
  bbtDualPicker: {
    flex: 1,
    ...Platform.select({
      ios: { height: 168 },
      android: { flex: 1 },
      default: {},
    }),
  },
  bbtDecDot: { fontSize: 18, fontWeight: '800', color: colors.textDark, paddingBottom: 4 },
  bbtWebPart: { flex: 1, minWidth: 0, textAlign: 'center' },
  input: {
    borderWidth: 1,
    borderColor: colors.chartGrid,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: colors.textDark,
    backgroundColor: colors.background,
  },
  pickerWrap: {
    borderWidth: 1,
    borderColor: colors.chartGrid,
    borderRadius: 10,
    backgroundColor: colors.background,
    overflow: 'hidden',
    ...Platform.select({
      ios: { height: 168 },
      android: { height: 160 },
      default: { minHeight: 54 },
    }),
    justifyContent: 'center',
  },
  pickerItemIos: {
    fontSize: 20,
    height: 160,
    color: colors.textDark,
  },
  timeChip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.softLavender,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.chartGrid,
  },
  timeChipTxt: { fontSize: 16, fontWeight: '800', color: colors.textDark },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.chartGrid,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.primarySageGreen, borderColor: colors.primarySageGreen },
  chipTxt: { fontSize: 12, color: colors.textDark, fontWeight: '600' },
  chipTxtOn: { color: colors.card },
  saveBtn: {
    marginTop: 8,
    backgroundColor: colors.mutedCoral,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveTxt: { color: colors.card, fontWeight: '800', fontSize: 16 },
});
