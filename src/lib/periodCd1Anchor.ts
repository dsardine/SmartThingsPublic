import { findMostRecentCd1AnchorFromBleedingLogs } from '@/src/lib/algorithms';
import { addCalendarDays, isoDateString } from '@/src/lib/dateDisplay';
import { GHOST_MANUAL_KEY_PREFIX } from '@/src/lib/manualGhostMerge';
import { ghostStorage } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import type { ManualLogBleeding } from '@/src/types/database';

/** Logged menstrual flow for CD1 detection (excludes Spotting). */
export function isLoggedMenstrualFlow(b: ManualLogBleeding | null): b is 'Light' | 'Medium' | 'Heavy' {
  return b === 'Light' || b === 'Medium' || b === 'Heavy';
}

export type BleedingRow = { date: string; bleeding: ManualLogBleeding | null };

/**
 * Latest CD1 from calendar rows + optional profile LMP fallback.
 * Delegates to `findMostRecentCd1AnchorFromBleedingLogs` (shared with edge `_shared/algorithms.ts`).
 */
export function findMostRecentCd1AnchorFromBleedingRows(
  rows: BleedingRow[],
  intakeLmpFallback: string | null,
): string | null {
  return findMostRecentCd1AnchorFromBleedingLogs(rows, intakeLmpFallback);
}

/**
 * Profile LMP + bleeding rows (Supabase or Ghost storage), same anchor logic as the calendar.
 */
export async function fetchPeriodCountdownAnchorIso(isGhost: boolean): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let intakeLmp: string | null = null;
  if (user) {
    const { data: pr } = await supabase
      .from('profiles')
      .select('last_period_date')
      .eq('id', user.id)
      .maybeSingle();
    const raw = (pr as { last_period_date?: string | null } | null)?.last_period_date;
    intakeLmp = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
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
    return findMostRecentCd1AnchorFromBleedingRows(rows, intakeLmp);
  }

  if (!user) {
    return findMostRecentCd1AnchorFromBleedingRows([], intakeLmp);
  }

  const minIso = isoDateString(addCalendarDays(new Date(), -730));
  const { data: bleedRows, error } = await supabase
    .from('manual_logs')
    .select('date, bleeding')
    .eq('user_id', user.id)
    .gte('date', minIso)
    .order('date', { ascending: true });
  if (error || !bleedRows) {
    return findMostRecentCd1AnchorFromBleedingRows([], intakeLmp);
  }
  for (const r of bleedRows) {
    const row = r as Record<string, unknown>;
    rows.push({
      date: String(row.date),
      bleeding: (row.bleeding as ManualLogBleeding) ?? null,
    });
  }
  return findMostRecentCd1AnchorFromBleedingRows(rows, intakeLmp);
}
