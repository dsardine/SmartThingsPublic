import { Platform } from 'react-native';

import { isoDateString } from '@/src/lib/dateDisplay';
import { GHOST_MANUAL_KEY_PREFIX } from '@/src/lib/manualGhostMerge';
import { persistDynamicCycleLengthAfterBleedingLog } from '@/src/lib/persistDynamicCycleLength';
import { ghostStorage } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import type { ManualLogBleeding, TemperatureUnit } from '@/src/types/database';

import type { Permission, ReadHealthDataHistoryPermission, RecordResult } from 'react-native-health-connect';
import type { TimeRangeFilter } from 'react-native-health-connect/lib/typescript/types/base.types';
import { MenstruationFlow } from 'react-native-health-connect';

/** Read types aligned with `app.json` android.health permissions and Sardine features. */
export const SARDINE_HEALTH_CONNECT_READ: Permission[] = [
  { accessType: 'read', recordType: 'BasalBodyTemperature' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'RespiratoryRate' },
  { accessType: 'read', recordType: 'MenstruationFlow' },
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

function historyPermissionGranted(granted: GrantedPermissionLike[]): boolean {
  return granted.some((g) => g.accessType === 'read' && g.recordType === 'ReadHealthDataHistory');
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

export async function healthConnectHasAllReadPermissions(): Promise<boolean> {
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return false;
  const hc = await loadHealthConnectModule();
  if (!hc) return false;
  try {
    const raw = (await hc.getGrantedPermissions()) as unknown[];
    const granted = parseGranted(raw);
    const readsOk = SARDINE_HEALTH_CONNECT_READ.every((p) => permissionSatisfied(granted, p));
    return readsOk && historyPermissionGranted(granted);
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

function buildTimeRangeFilter(lookbackDays: number | null | undefined): TimeRangeFilter {
  const end = new Date();
  const endTime = end.toISOString();
  if (lookbackDays == null) {
    return { operator: 'before', endTime };
  }
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - lookbackDays);
  return {
    operator: 'between',
    startTime: start.toISOString(),
    endTime,
  };
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
  return null;
}

type HcDayPatch = { iso: string; manualBbt?: number; bbtTime?: string; bleeding?: ManualLogBleeding };

async function readMenstruationAndBbtPatches(
  hc: typeof import('react-native-health-connect'),
  timeRangeFilter: TimeRangeFilter,
  profileTempUnit: TemperatureUnit,
): Promise<Map<string, HcDayPatch>> {
  const profileU: 'F' | 'C' = profileTempUnit === 'C' ? 'C' : 'F';

  async function readPaged<T extends 'MenstruationFlow' | 'BasalBodyTemperature'>(
    recordType: T,
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

  const [flows, bbts] = await Promise.all([
    readPaged('MenstruationFlow'),
    readPaged('BasalBodyTemperature'),
  ]);

  const byDate = new Map<string, HcDayPatch>();

  const touch = (iso: string): HcDayPatch => {
    let p = byDate.get(iso);
    if (!p) {
      p = { iso };
      byDate.set(iso, p);
    }
    return p;
  };

  for (const r of flows) {
    const iso = isoDateString(new Date(r.time));
    const bleeding = flowIntToBleeding(r.flow);
    if (!bleeding) continue;
    const cur = touch(iso);
    cur.bleeding = bleeding;
  }

  for (const r of bbts) {
    const iso = isoDateString(new Date(r.time));
    const t = r.temperature;
    if (!t || !Number.isFinite(t.inCelsius) || !Number.isFinite(t.inFahrenheit)) continue;
    const manualBbt = bbtFromReadResult(t, profileU);
    const cur = touch(iso);
    cur.manualBbt = manualBbt;
    cur.bbtTime = localTimeHHMMSS(r.time);
  }

  return byDate;
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

export type HealthConnectManualSyncResult =
  | { ok: true; daysTouched: number }
  | { ok: false; reason: string };

/**
 * Reads MenstruationFlow + BasalBodyTemperature from Health Connect for the given window and merges
 * into `manual_logs` (or Ghost MMKV). Does not overwrite existing manual BBT or bleeding when already set.
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
      reason: 'Allow Sardine to read Health Connect data (including historical access) first, using “Allow access”.',
    };
  }

  const hc = await loadHealthConnectModule();
  if (!hc) return { ok: false, reason: 'Health Connect module failed to load.' };

  const timeRangeFilter = buildTimeRangeFilter(lookbackDays);
  let byDate: Map<string, HcDayPatch>;
  try {
    byDate = await readMenstruationAndBbtPatches(hc, timeRangeFilter, temperatureUnit);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : 'Could not read Health Connect records.',
    };
  }

  if (byDate.size === 0) {
    await persistDynamicCycleLengthAfterBleedingLog({ isGhost: isGhostMode, userId });
    return { ok: true, daysTouched: 0 };
  }

  if (isGhostMode) {
    for (const patch of byDate.values()) {
      mergeGhostDayFromHc(patch.iso, patch);
    }
    await persistDynamicCycleLengthAfterBleedingLog({ isGhost: true, userId: null });
    return { ok: true, daysTouched: byDate.size };
  }

  const dates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
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
    const patch = byDate.get(iso)!;
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
  }

  await persistDynamicCycleLengthAfterBleedingLog({ isGhost: false, userId });
  return { ok: true, daysTouched: byDate.size };
}

/** Short status line for the menu card. */
export async function getHealthConnectMenuSummary(): Promise<string> {
  if (Platform.OS !== 'android') return '';
  const init = await healthConnectEnsureInitialized();
  if (!init.ok) return init.reason;
  const all = await healthConnectHasAllReadPermissions();
  return all
    ? 'Sardine can read your permitted vitals, BBT, period flow, and extended history from Health Connect.'
    : 'Not connected — tap below to allow read access for BBT, period flow, vitals, and historical health data.';
}
