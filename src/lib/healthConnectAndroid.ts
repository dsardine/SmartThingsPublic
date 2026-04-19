import { Platform } from 'react-native';

import { addCalendarDays, isoDateString, parseIsoDate } from '@/src/lib/dateDisplay';
import { GHOST_MANUAL_KEY_PREFIX } from '@/src/lib/manualGhostMerge';
import {
  maybeSetClinicalCycleAnchorAfterMenstrualCd1,
  persistDynamicCycleLengthAfterBleedingLog,
} from '@/src/lib/persistDynamicCycleLength';
import { ghostStorage } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import type { ManualLogBleeding, TemperatureUnit } from '@/src/types/database';

import type { Permission, ReadHealthDataHistoryPermission, RecordResult, RecordType } from 'react-native-health-connect';
import type { TimeRangeFilter } from 'react-native-health-connect/lib/typescript/types/base.types';
import { MenstruationFlow } from 'react-native-health-connect';

/** Read types aligned with `app.json` android.health permissions and Sardine features. */
export const SARDINE_HEALTH_CONNECT_READ: Permission[] = [
  { accessType: 'read', recordType: 'BasalBodyTemperature' },
  /** Wrist / overnight skin temp when the OEM writes it (preferred for `biometrics.sleeping_temp`). */
  { accessType: 'read', recordType: 'BodyTemperature' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'RespiratoryRate' },
  { accessType: 'read', recordType: 'SleepSession' },
  { accessType: 'read', recordType: 'MenstruationFlow' },
  /** Same OS grant as flow; Pixel / Fit often log cycle as interval periods, not daily flow. */
  { accessType: 'read', recordType: 'MenstruationPeriod' },
];

export const SARDINE_HEALTH_CONNECT_HISTORY: ReadHealthDataHistoryPermission = {
  accessType: 'read',
  recordType: 'ReadHealthDataHistory',
};

const SARDINE_HC_PERMISSION_REQUEST: (
  | Permission
  | ReadHealthDataHistoryPermission
)[] = [...SARDINE_HEALTH_CONNECT_READ, SARDINE_HEALTH_CONNECT_HISTORY];

export const HEALTH_CONNECT_SOFT_NUDGE_DISMISSED_KEY = 'health_connect_soft_nudge_dismissed';

type GrantedPermissionLike = {
  accessType?: string;
  recordType?: string;
};

function permissionSatisfied(granted: GrantedPermissionLike[], want: Permission): boolean {
  return granted.some((g) => g.accessType === want.accessType && g.recordType === want.recordType);
}

async function loadHealthConnectModule(): Promise<typeof import('react-native-health-connect') | null> {
  if (Platform.OS !== 'android') return null;
  try {
    return await import('react-native-health-connect');
  } catch {
    return null;
  }
}

function parseGranted(raw: unknown[]): GrantedPermissionLike[] {
  return raw.filter(
    (item): item is GrantedPermissionLike =>
      item != null && typeof item === 'object' && 'recordType' in item && 'accessType' in item,
  );
}

export async function healthConnectEnsureInitialized(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Platform.OS !== 'android') {
    return { ok: false, reason: 'Health Connect is only available on Android.' };
  }
  const hc = await loadHealthConnectModule();
  if (!hc) {
    return {
      ok: false,
      reason:
        'Health Connect native module is not available. Rebuild the Android app (development or production build — not Expo Go).',
    };
  }
  try {
    const status = await hc.getSdkStatus();
    if (status !== hc.SdkAvailabilityStatus.SDK_AVAILABLE) {
      return {
        ok: false,
        reason:
          'Health Connect is not ready on this device. On Android 13 and below, install Health Connect from the Play Store; on Android 14+ ensure the system Health Connect service is available.',
      };
    }
    const initialized = await hc.initialize();
    if (!initialized) {
      return { ok: false, reason: 'Could not initialize Health Connect.' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Health Connect initialization failed.',
    };
  }
}

/**
 * True when every record-type read in `SARDINE_HEALTH_CONNECT_READ` is granted.
 *
 * Note: `react-native-health-connect`’s Android `mapPermissionResult` does **not** surface
 * `PERMISSION_READ_HEALTH_DATA_HISTORY` back to JS as `{ recordType: 'ReadHealthDataHistory' }`, so we
 * cannot verify historical read here without forking the library. We still **request** that
 * permission together with the others; extended history may work when the OS has granted it.
 */
export async function healthConnectHasAllReadPermissions(): Promise<boolean> {
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return false;
  const hc = await loadHealthConnectModule();
  if (!hc) return false;
  try {
    const raw = (await hc.getGrantedPermissions()) as unknown[];
    const granted = parseGranted(raw);
    return SARDINE_HEALTH_CONNECT_READ.every((p) => permissionSatisfied(granted, p));
  } catch {
    return false;
  }
}

export async function healthConnectRequestReadPermissions(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return { ok: false, reason: init.reason };
  const hc = await loadHealthConnectModule();
  if (!hc) return { ok: false, reason: 'Health Connect module failed to load.' };
  try {
    await hc.requestPermission(SARDINE_HC_PERMISSION_REQUEST);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Permission request failed.',
    };
  }
}

export async function healthConnectOpenSettings(): Promise<void> {
  const hc = await loadHealthConnectModule();
  if (!hc) return;
  try {
    hc.openHealthConnectSettings();
  } catch {
    // no-op
  }
}

/**
 * Open-ended read window for Health Connect imports.
 * Using `between` with a start older than the OS “recent data” window can yield **zero rows**
 * when `READ_HEALTH_DATA_HISTORY` is not in effect (common on API 34 / limited history grant).
 * We read everything the OS allows, then apply `lookbackDays` on the client.
 */
function buildHcImportReadTimeRangeFilter(): TimeRangeFilter {
  return { operator: 'before', endTime: new Date().toISOString() };
}

/** Local-midnight cutoff instant for bounded imports; `null` = no cutoff (all rows HC returns). */
function importCutoffMs(lookbackDays: number | null | undefined): number | null {
  if (lookbackDays == null) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - lookbackDays);
  return d.getTime();
}

function recordTimeAtOrAfterCutoff(isoInstant: string, cutoffMs: number | null): boolean {
  if (cutoffMs == null) return true;
  const t = new Date(isoInstant).getTime();
  return !Number.isNaN(t) && t >= cutoffMs;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function localTimeHHMMSS(isoInstant: string): string {
  const d = new Date(isoInstant);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

function bbtFromReadResult(t: { inFahrenheit: number; inCelsius: number }, profile: 'F' | 'C'): number {
  const n = profile === 'F' ? t.inFahrenheit : t.inCelsius;
  return Math.round(n * 100) / 100;
}

function flowIntToBleeding(flow: number | undefined): ManualLogBleeding | null {
  if (flow === undefined) return null;
  if (flow === MenstruationFlow.LIGHT) return 'Light';
  if (flow === MenstruationFlow.MEDIUM) return 'Medium';
  if (flow === MenstruationFlow.HEAVY) return 'Heavy';
  /** OEMs often log flow as UNKNOWN (0); still import as generic period presence. */
  if (flow === MenstruationFlow.UNKNOWN) return 'Medium';
  return null;
}

type HcDayPatch = { iso: string; manualBbt?: number; bbtTime?: string; bleeding?: ManualLogBleeding };

/** Per-calendar-day nocturnal-style vitals for `biometrics` (°C for temperature column — see `rowToNocturnalBiometrics`). */
type HcBioDayPatch = {
  iso: string;
  sleepingTempC?: number;
  rhr?: number;
  hrvMs?: number;
  respiratoryRate?: number;
};

async function readPagedRecords<T extends RecordType>(
  hc: typeof import('react-native-health-connect'),
  recordType: T,
  timeRangeFilter: TimeRangeFilter,
): Promise<RecordResult<T>[]> {
  const acc: RecordResult<T>[] = [];
  let pageToken: string | undefined;
  do {
    const res = await hc.readRecords(recordType, {
      timeRangeFilter,
      ascendingOrder: true,
      pageSize: 500,
      pageToken,
    });
    acc.push(...(res.records as RecordResult<T>[]));
    pageToken = res.pageToken;
  } while (pageToken);
  return acc;
}

async function readPagedRecordsSafe<T extends RecordType>(
  hc: typeof import('react-native-health-connect'),
  recordType: T,
  timeRangeFilter: TimeRangeFilter,
): Promise<RecordResult<T>[]> {
  try {
    return await readPagedRecords(hc, recordType, timeRangeFilter);
  } catch (e) {
    if (__DEV__) {
      console.warn(`[HealthConnect] readRecords(${recordType}) failed:`, e);
    }
    return [];
  }
}

type SleepInterval = { start: Date; end: Date };

function intervalsOverlap(a0: Date, a1: Date, b0: Date, b1: Date): boolean {
  return a0.getTime() < b1.getTime() && a1.getTime() > b0.getTime();
}

/** Local midnight and 10:00 on the given wake calendar day (YYYY-MM-DD). */
function localMidnightToTenAm(wakeIso: string): { morningStart: Date; morningEnd: Date } {
  const d = parseIsoDate(wakeIso);
  const morningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const morningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0, 0);
  return { morningStart, morningEnd };
}

function parseSleepIntervals(sessions: RecordResult<'SleepSession'>[]): SleepInterval[] {
  const out: SleepInterval[] = [];
  for (const r of sessions) {
    const start = new Date(r.startTime);
    const end = new Date(r.endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (start.getTime() >= end.getTime()) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * Sleep sessions that overlap the wake-day morning window [00:00, 10:00) local.
 * Primary: longest duration; tie-break: end closest to 09:00 local (nocturnal vs nap).
 */
function pickPrimaryNocturnalSleep(
  sessions: SleepInterval[],
  wakeIso: string,
): SleepInterval | null {
  const { morningStart, morningEnd } = localMidnightToTenAm(wakeIso);
  const idealWake = parseIsoDate(wakeIso);
  idealWake.setHours(9, 0, 0, 0);

  const candidates = sessions.filter((s) =>
    intervalsOverlap(s.start, s.end, morningStart, morningEnd),
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const da = a.end.getTime() - a.start.getTime();
    const db = b.end.getTime() - b.start.getTime();
    if (db !== da) return db - da;
    return (
      Math.abs(a.end.getTime() - idealWake.getTime()) - Math.abs(b.end.getTime() - idealWake.getTime())
    );
  });
  return candidates[0] ?? null;
}

/** Vitals window: full sleep session if found, else local 00:00–10:00 on the wake day. */
function bioBoundsForWakeDay(wakeIso: string, sleep: SleepInterval | null): SleepInterval {
  if (sleep) return sleep;
  const { morningStart, morningEnd } = localMidnightToTenAm(wakeIso);
  return { start: morningStart, end: morningEnd };
}

function instantInRange(timeIso: string, bounds: SleepInterval): boolean {
  const t = new Date(timeIso).getTime();
  return t >= bounds.start.getTime() && t <= bounds.end.getTime();
}

function minFinite(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return Math.min(...v);
}

function averageFinite(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function bioImportLocalDayRange(lookbackDays: number | null | undefined): { start: Date; end: Date } {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  if (lookbackDays == null) {
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 800);
    return { start, end };
  }
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - lookbackDays);
  return { start, end };
}

function iterateWakeIsoDatesInclusive(rangeStart: Date, rangeEnd: Date): string[] {
  const out: string[] = [];
  let d = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  const last = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
  while (d <= last) {
    out.push(isoDateString(d));
    d = addCalendarDays(d, 1);
  }
  return out;
}

type HcImportMaps = {
  manualByDate: Map<string, HcDayPatch>;
  bioByDate: Map<string, HcBioDayPatch>;
};

async function readHealthConnectImportMaps(
  hc: typeof import('react-native-health-connect'),
  profileTempUnit: TemperatureUnit,
  lookbackDays: number | null | undefined,
): Promise<HcImportMaps> {
  const profileU: 'F' | 'C' = profileTempUnit === 'C' ? 'C' : 'F';
  const readFilter = buildHcImportReadTimeRangeFilter();
  const cutoffMs = importCutoffMs(lookbackDays);

  const [flows, periodRanges, bbts, bodyTemps, rhrRows, hrvRows, rrRows, sleepRows] = await Promise.all([
    readPagedRecordsSafe(hc, 'MenstruationFlow', readFilter),
    readPagedRecordsSafe(hc, 'MenstruationPeriod', readFilter),
    readPagedRecordsSafe(hc, 'BasalBodyTemperature', readFilter),
    readPagedRecordsSafe(hc, 'BodyTemperature', readFilter),
    readPagedRecordsSafe(hc, 'RestingHeartRate', readFilter),
    readPagedRecordsSafe(hc, 'HeartRateVariabilityRmssd', readFilter),
    readPagedRecordsSafe(hc, 'RespiratoryRate', readFilter),
    readPagedRecordsSafe(hc, 'SleepSession', readFilter),
  ]);

  const manualByDate = new Map<string, HcDayPatch>();
  const touchManual = (iso: string): HcDayPatch => {
    let p = manualByDate.get(iso);
    if (!p) {
      p = { iso };
      manualByDate.set(iso, p);
    }
    return p;
  };

  for (const r of flows) {
    if (!recordTimeAtOrAfterCutoff(r.time, cutoffMs)) continue;
    const iso = isoDateString(new Date(r.time));
    const bleeding = flowIntToBleeding(r.flow);
    if (!bleeding) continue;
    const cur = touchManual(iso);
    cur.bleeding = bleeding;
  }

  /** Google Fit / Pixel "cycle tracking" often writes interval rows, not per-day MenstruationFlow. */
  for (const r of periodRanges) {
    const pr = r as { startTime?: string; endTime?: string; time?: string };
    let startIso = typeof pr.startTime === 'string' ? pr.startTime : null;
    let endIso = typeof pr.endTime === 'string' ? pr.endTime : null;
    if ((!startIso || !endIso) && typeof pr.time === 'string') {
      startIso = pr.time;
      endIso = pr.time;
    }
    if (!startIso || !endIso) continue;
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (cutoffMs != null && end.getTime() < cutoffMs) continue;
    let dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const dayEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    if (cutoffMs != null) {
      const co = new Date(cutoffMs);
      const cutoffDay = new Date(co.getFullYear(), co.getMonth(), co.getDate());
      if (dayStart < cutoffDay) dayStart = cutoffDay;
    }
    for (const iso of iterateWakeIsoDatesInclusive(dayStart, dayEnd)) {
      const cur = touchManual(iso);
      if (cur.bleeding == null) {
        cur.bleeding = 'Medium';
      }
    }
  }

  for (const r of bbts) {
    if (!recordTimeAtOrAfterCutoff(r.time, cutoffMs)) continue;
    const iso = isoDateString(new Date(r.time));
    const t = r.temperature;
    if (!t || !Number.isFinite(t.inCelsius) || !Number.isFinite(t.inFahrenheit)) continue;
    const manualBbt = bbtFromReadResult(t, profileU);
    const cur = touchManual(iso);
    cur.manualBbt = manualBbt;
    cur.bbtTime = localTimeHHMMSS(r.time);
  }

  const sleepIntervals = parseSleepIntervals(sleepRows);
  const { start: rangeStart, end: rangeEnd } = bioImportLocalDayRange(lookbackDays);
  const wakeIsos = iterateWakeIsoDatesInclusive(rangeStart, rangeEnd);

  const bioByDate = new Map<string, HcBioDayPatch>();
  for (const wakeIso of wakeIsos) {
    const primarySleep = pickPrimaryNocturnalSleep(sleepIntervals, wakeIso);
    const bounds = bioBoundsForWakeDay(wakeIso, primarySleep);

    const tempsC: number[] = [];
    for (const r of bodyTemps) {
      const tr = r as RecordResult<'BodyTemperature'>;
      if (!instantInRange(tr.time, bounds)) continue;
      const c = tr.temperature?.inCelsius;
      if (c != null && Number.isFinite(c)) tempsC.push(c);
    }
    for (const r of bbts) {
      const tr = r as RecordResult<'BasalBodyTemperature'>;
      if (!instantInRange(tr.time, bounds)) continue;
      const c = tr.temperature?.inCelsius;
      if (c != null && Number.isFinite(c)) tempsC.push(c);
    }
    const sleepingTempRaw = minFinite(tempsC);
    const sleepingTempC =
      sleepingTempRaw == null ? null : Math.round(sleepingTempRaw * 1000) / 1000;

    const rhrSamples: number[] = [];
    for (const r of rhrRows) {
      const tr = r as RecordResult<'RestingHeartRate'>;
      if (!instantInRange(tr.time, bounds)) continue;
      if (typeof tr.beatsPerMinute === 'number' && Number.isFinite(tr.beatsPerMinute)) {
        rhrSamples.push(tr.beatsPerMinute);
      }
    }
    const rhr = minFinite(rhrSamples);

    const hrvSamples: number[] = [];
    for (const r of hrvRows) {
      const tr = r as RecordResult<'HeartRateVariabilityRmssd'>;
      if (!instantInRange(tr.time, bounds)) continue;
      if (
        typeof tr.heartRateVariabilityMillis === 'number' &&
        Number.isFinite(tr.heartRateVariabilityMillis)
      ) {
        hrvSamples.push(tr.heartRateVariabilityMillis);
      }
    }
    const hrvMs = hrvSamples.length > 0 ? averageFinite(hrvSamples) : null;

    const rrSamples: number[] = [];
    for (const r of rrRows) {
      const tr = r as RecordResult<'RespiratoryRate'>;
      if (!instantInRange(tr.time, bounds)) continue;
      if (typeof tr.rate === 'number' && Number.isFinite(tr.rate)) rrSamples.push(tr.rate);
    }
    const respiratoryRate = rrSamples.length > 0 ? averageFinite(rrSamples) : null;

    if (sleepingTempC == null && rhr == null && hrvMs == null && respiratoryRate == null) {
      continue;
    }
    bioByDate.set(wakeIso, {
      iso: wakeIso,
      ...(sleepingTempC != null ? { sleepingTempC } : {}),
      ...(rhr != null ? { rhr } : {}),
      ...(hrvMs != null ? { hrvMs } : {}),
      ...(respiratoryRate != null ? { respiratoryRate } : {}),
    });
  }

  return { manualByDate, bioByDate };
}

const GHOST_MANUAL_DEFAULT: Record<string, unknown> = {
  manual_bbt: '',
  bbt_time_taken: '07:00',
  exclude_temp: false,
  disturbances: [],
  cervical_position: null,
  cervical_firmness: null,
  bleeding: null,
  period_end: false,
  intercourse: null,
  cervical_fluid: null,
  symptoms: [],
  test_results: [],
};

function mergeGhostDayFromHc(iso: string, patch: HcDayPatch): void {
  const key = `${GHOST_MANUAL_KEY_PREFIX}${iso}`;
  const raw = ghostStorage.getString(key);
  let existing: Record<string, unknown> = {};
  if (raw) {
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const merged: Record<string, unknown> = { ...GHOST_MANUAL_DEFAULT, ...existing };

  const exBbt = merged.manual_bbt;
  const hasUserBbt =
    typeof exBbt === 'string'
      ? exBbt.trim() !== ''
      : exBbt != null && String(exBbt).trim() !== '' && Number(exBbt) !== 0;

  if (patch.manualBbt != null && !hasUserBbt) {
    merged.manual_bbt = String(patch.manualBbt);
    if (patch.bbtTime) {
      const short = patch.bbtTime.slice(0, 5);
      merged.bbt_time_taken = /^\d{1,2}:\d{2}$/.test(short) ? short : merged.bbt_time_taken;
    }
  }

  if (patch.bleeding != null && merged.bleeding == null) {
    merged.bleeding = patch.bleeding;
  }

  ghostStorage.set(key, JSON.stringify(merged));
}

async function mergeHcBiometricsToSupabase(
  userId: string,
  bioByDate: Map<string, HcBioDayPatch>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (bioByDate.size === 0) return { ok: true };

  const dates = [...bioByDate.keys()].sort((a, b) => a.localeCompare(b));
  const chunkSize = 150;
  const existingByDate = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < dates.length; i += chunkSize) {
    const chunk = dates.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('biometrics')
      .select('*')
      .eq('user_id', userId)
      .in('date', chunk);
    if (error) return { ok: false, reason: error.message };
    for (const row of data ?? []) {
      const d = (row as { date?: string }).date;
      if (typeof d !== 'string') continue;
      const prev = existingByDate.get(d);
      const prevCreated = prev?.created_at != null ? String(prev.created_at) : '';
      const rowCreated = (row as { created_at?: string }).created_at != null ? String((row as { created_at?: string }).created_at) : '';
      if (!prev || rowCreated > prevCreated) {
        existingByDate.set(d, row as Record<string, unknown>);
      }
    }
  }

  for (const iso of dates) {
    const patch = bioByDate.get(iso)!;
    const existing = existingByDate.get(iso) ?? null;

    const hasSleep =
      existing != null &&
      existing.sleeping_temp != null &&
      String(existing.sleeping_temp).trim() !== '' &&
      Number.isFinite(Number(existing.sleeping_temp));
    const hasRhr =
      existing != null && existing.rhr != null && Number.isFinite(Number(existing.rhr));
    const hasHrv =
      existing != null && existing.hrv != null && Number.isFinite(Number(existing.hrv));
    const hasRr =
      existing != null &&
      existing.respiratory_rate != null &&
      Number.isFinite(Number(existing.respiratory_rate));

    const sleeping_temp = hasSleep ? Number(existing!.sleeping_temp) : patch.sleepingTempC ?? null;
    const rhr = hasRhr ? Number(existing!.rhr) : patch.rhr ?? null;
    const hrv = hasHrv ? Number(existing!.hrv) : patch.hrvMs ?? null;
    const respiratory_rate = hasRr ? Number(existing!.respiratory_rate) : patch.respiratoryRate ?? null;

    const row = {
      user_id: userId,
      date: iso,
      sleeping_temp,
      rhr,
      hrv,
      respiratory_rate,
    };

    if (existing?.id) {
      const { error: upErr } = await supabase.from('biometrics').update(row).eq('id', String(existing.id));
      if (upErr) return { ok: false, reason: upErr.message };
    } else {
      const { error: insErr } = await supabase.from('biometrics').insert(row);
      if (insErr) return { ok: false, reason: insErr.message };
    }
  }

  return { ok: true };
}

export type HealthConnectManualSyncResult =
  | { ok: true; daysTouched: number }
  | { ok: false; reason: string };

/**
 * Reads Health Connect data for the window and merges into `manual_logs` (cycle + BBT) and
 * `biometrics` (nocturnal vitals). **Biometrics** use two-step sleep anchoring: for each local wake
 * calendar day, a primary **SleepSession** overlapping [00:00, 10:00) is chosen (longest, then end
 * closest to 09:00 local). Vitals are taken only inside that session’s `[startTime, endTime]`; if no
 * session matches, the window defaults to local **00:00–10:00** on that day. **Clinical math:**
 * BodyTemperature + BasalBodyTemperature °C and RHR → **minimum** in-window; HRV RMSSD and
 * respiratory rate → **average** in-window. Manual BBT on the calendar still uses the latest
 * same-day basal sample (full import range), not the sleep-bounded pool.
 * Ghost Mode: only `manual_logs` (MMKV); biometrics stay cloud-only and are skipped.
 * Does not overwrite existing manual or biometrics fields when already set.
 *
 * @param lookbackDays When `null` or `undefined`, uses a non-restrictive time filter (all history allowed by Health Connect).
 */
export async function healthConnectSyncMenstruationAndBbtToManualLogs(args: {
  lookbackDays?: number | null;
  temperatureUnit: TemperatureUnit;
  isGhostMode: boolean;
  userId: string | null;
}): Promise<HealthConnectManualSyncResult> {
  const { lookbackDays, temperatureUnit, isGhostMode, userId } = args;

  if (Platform.OS !== 'android') {
    return { ok: false, reason: 'Health Connect is only available on Android.' };
  }
  if (!isGhostMode && !userId) {
    return { ok: false, reason: 'Sign in to import Health Connect data into your manual log.' };
  }

  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return { ok: false, reason: init.reason };

  const hasPerms = await healthConnectHasAllReadPermissions();
  if (!hasPerms) {
    return {
      ok: false,
      reason: 'Allow Sardine to read the Health Connect data types listed in the permission screen (use “Allow access” on the previous card).',
    };
  }

  const hc = await loadHealthConnectModule();
  if (!hc) return { ok: false, reason: 'Health Connect module failed to load.' };

  let manualByDate: Map<string, HcDayPatch>;
  let bioByDate: Map<string, HcBioDayPatch>;
  try {
    const maps = await readHealthConnectImportMaps(hc, temperatureUnit, lookbackDays);
    manualByDate = maps.manualByDate;
    bioByDate = maps.bioByDate;
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Could not read Health Connect records.',
    };
  }

  if (manualByDate.size === 0 && bioByDate.size === 0) {
    await persistDynamicCycleLengthAfterBleedingLog({ isGhost: isGhostMode, userId });
    return { ok: true, daysTouched: 0 };
  }

  if (isGhostMode) {
    for (const patch of manualByDate.values()) {
      mergeGhostDayFromHc(patch.iso, patch);
    }
    await persistDynamicCycleLengthAfterBleedingLog({ isGhost: true, userId: null });
    return { ok: true, daysTouched: manualByDate.size };
  }

  const dates = [...manualByDate.keys()].sort((a, b) => a.localeCompare(b));
  const chunkSize = 150;
  const existingByDate = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < dates.length; i += chunkSize) {
    const chunk = dates.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('manual_logs')
      .select('*')
      .eq('user_id', userId!)
      .in('date', chunk);
    if (error) {
      return { ok: false, reason: error.message };
    }
    for (const row of data ?? []) {
      const d = (row as { date?: string }).date;
      if (typeof d === 'string') existingByDate.set(d, row as Record<string, unknown>);
    }
  }

  for (const iso of dates) {
    const patch = manualByDate.get(iso)!;
    const existing = existingByDate.get(iso) ?? null;

    const hasUserBbt =
      existing != null &&
      existing.manual_bbt != null &&
      String(existing.manual_bbt).trim() !== '' &&
      Number.isFinite(Number(existing.manual_bbt));
    const hasUserBleed = existing != null && existing.bleeding != null;

    const manual_bbt = hasUserBbt ? Number(existing!.manual_bbt) : patch.manualBbt ?? null;
    const bbt_time_taken =
      hasUserBbt && typeof existing!.bbt_time_taken === 'string'
        ? String(existing!.bbt_time_taken).slice(0, 8)
        : patch.manualBbt != null && patch.bbtTime
          ? patch.bbtTime
          : (existing?.bbt_time_taken as string | null | undefined) ?? null;

    const bleeding = hasUserBleed ? (existing!.bleeding as ManualLogBleeding) : patch.bleeding ?? null;

    const row = {
      user_id: userId!,
      date: iso,
      manual_bbt,
      bbt_time_taken,
      exclude_temp: existing?.exclude_temp === true,
      disturbances: (existing?.disturbances as string[] | null) ?? null,
      cervical_position: (existing?.cervical_position as string | null) ?? null,
      cervical_firmness: (existing?.cervical_firmness as string | null) ?? null,
      bleeding,
      period_end: existing?.period_end === true,
      intercourse: (existing?.intercourse as string | null) ?? null,
      cervical_fluid: (existing?.cervical_fluid as string | null) ?? null,
      symptoms: (existing?.symptoms as string[] | null) ?? null,
      test_results: (existing?.test_results as string[] | null) ?? null,
    };

    if (existing?.id) {
      const { error: upErr } = await supabase.from('manual_logs').update(row).eq('id', String(existing.id));
      if (upErr) return { ok: false, reason: upErr.message };
    } else {
      const { error: insErr } = await supabase.from('manual_logs').insert(row);
      if (insErr) return { ok: false, reason: insErr.message };
    }
    await maybeSetClinicalCycleAnchorAfterMenstrualCd1({
      userId: userId!,
      logDateIso: iso,
      bleeding: (row.bleeding as ManualLogBleeding | null) ?? null,
    });
  }

  const bioRes = await mergeHcBiometricsToSupabase(userId!, bioByDate);
  if (!bioRes.ok) {
    return { ok: false, reason: bioRes.reason };
  }

  if (bioByDate.size > 0) {
    const { error: flagErr } = await supabase
      .from('profiles')
      .update({ has_new_biometrics: true })
      .eq('id', userId!);
    if (flagErr) {
      console.warn('profiles has_new_biometrics (optional column):', flagErr.message);
    }
  }

  await persistDynamicCycleLengthAfterBleedingLog({ isGhost: false, userId });
  const touched = new Set<string>([...manualByDate.keys(), ...bioByDate.keys()]);
  return { ok: true, daysTouched: touched.size };
}

/** Short status line for the menu card. */
export async function getHealthConnectMenuSummary(): Promise<string> {
  if (Platform.OS !== 'android') return '';
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return init.reason;
  const all = await healthConnectHasAllReadPermissions();
  return all
    ? 'Sardine can read sleep sessions, vitals (RHR, HRV, respiratory rate, body temp), BBT, and period flow. Biometrics import anchors vitals to detected sleep (or 00:00–10:00 fallback). Past-data access is requested when you tap Allow access.'
    : 'Not connected — tap below to allow read access for those Health Connect types (plus past data when the system offers it).';
}
