import type { MMKV } from 'react-native-mmkv';

import type { DailyFertilityInput } from '@/src/lib/algorithms';

/** Must match calendar ghost keys: `ghost:manual:{YYYY-MM-DD}`. */
export const GHOST_MANUAL_KEY_PREFIX = 'ghost:manual:';

/** Fields from Ghost Mode JSON overlaid onto a Supabase-shaped manual row (ghost wins on conflict). */
function parseGhostManualOverlay(raw: string): Record<string, unknown> | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const excludeTemp = o.exclude_temp === true;
  let manualBbt: number | null = null;
  if (!excludeTemp) {
    const rawBbt = o.manual_bbt;
    const s =
      typeof rawBbt === 'string' ? rawBbt.trim() : rawBbt != null ? String(rawBbt) : '';
    if (s) {
      const n = Number(s);
      manualBbt = Number.isFinite(n) ? n : null;
    }
  }
  const ic = o.intercourse;
  const intercourse =
    typeof ic === 'string' && ic.trim().length > 0 ? ic : null;

  const tests = o.test_results;
  let test_results: string[] | null = null;
  if (Array.isArray(tests) && tests.length > 0) {
    test_results = tests.map((t) => String(t));
  } else if (typeof tests === 'string' && tests.trim().length > 0) {
    test_results = tests
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    manual_bbt: manualBbt,
    intercourse,
    test_results,
    exclude_temp: excludeTemp,
  };
}

/**
 * Merges Supabase `manual_logs` rows with on-device Ghost Mode entries.
 * On date conflicts, ghost storage wins (full overlay for overlapping fields).
 */
export function mergeManualLogsWithGhostStorage(
  supabaseRows: Record<string, unknown>[],
  ghostStorage: MMKV,
): { mergedRows: Record<string, unknown>[]; ghostDates: Set<string> } {
  const byDate = new Map<string, Record<string, unknown>>();
  for (const row of supabaseRows) {
    const d = typeof row.date === 'string' ? row.date : null;
    if (!d) continue;
    byDate.set(d, { ...row });
  }

  const ghostDates = new Set<string>();
  for (const key of ghostStorage.getAllKeys()) {
    if (!key.startsWith(GHOST_MANUAL_KEY_PREFIX)) continue;
    const iso = key.slice(GHOST_MANUAL_KEY_PREFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const raw = ghostStorage.getString(key);
    if (raw && raw.trim().length > 0) ghostDates.add(iso);
    if (!raw) continue;
    const overlay = parseGhostManualOverlay(raw);
    if (!overlay) continue;
    const prev = byDate.get(iso) ?? { date: iso };
    byDate.set(iso, { ...prev, ...overlay });
  }

  const mergedRows = [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  return { mergedRows, ghostDates };
}

/** Builds ascending `DailyFertilityInput[]` for `getAlgorithmicCoverlineY` / fertile window math. */
export function mergeDailyInputsForAlgorithms(
  bios: Record<string, unknown>[],
  logs: Record<string, unknown>[],
): DailyFertilityInput[] {
  const map = new Map<string, DailyFertilityInput>();
  for (const row of bios) {
    const d = typeof row.date === 'string' ? row.date : null;
    if (!d) continue;
    const cur = map.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (row.sleeping_temp != null) cur.sleeping_temp = Number(row.sleeping_temp);
    if (row.rhr != null) cur.rhr = Number(row.rhr);
    map.set(d, cur);
  }
  for (const row of logs) {
    const d = typeof row.date === 'string' ? row.date : null;
    if (!d) continue;
    const cur = map.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    const excluded = row.exclude_temp === true;
    if (excluded) {
      cur.manual_bbt = null;
    } else if (row.manual_bbt != null && Number.isFinite(Number(row.manual_bbt))) {
      cur.manual_bbt = Number(row.manual_bbt);
    } else {
      cur.manual_bbt = null;
    }
    map.set(d, cur);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
