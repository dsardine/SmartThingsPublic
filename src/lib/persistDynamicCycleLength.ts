import { calculateDynamicCycleAverage, type ManualLogs } from '@/src/lib/algorithms';
import { collectGhostManualLogsForCycleAverage } from '@/src/lib/manualGhostMerge';
import { appStorage, ghostStorage, GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import type { ManualLogBleeding } from '@/src/types/database';

/**
 * Recomputes rolling cycle length from bleeding history and mirrors the calendar save path:
 * ghost → MMKV + store; signed-in → profiles upsert + store.
 */
export async function persistDynamicCycleLengthAfterBleedingLog(opts: {
  isGhost: boolean;
  userId: string | null;
}): Promise<void> {
  const { isGhost, userId } = opts;
  const fallback = useAppStore.getState().cycleLengthIntakeFallback;

  let logs: ManualLogs[];
  if (isGhost) {
    logs = collectGhostManualLogsForCycleAverage(ghostStorage);
  } else {
    if (!userId) return;
    const { data, error } = await supabase
      .from('manual_logs')
      .select('date, bleeding')
      .eq('user_id', userId)
      .order('date', { ascending: true });
    if (error || !data) return;
    logs = (data as { date: string; bleeding: ManualLogBleeding | null }[]).map((r) => ({
      date: String(r.date),
      bleeding: (r.bleeding as ManualLogBleeding | null) ?? null,
    }));
  }

  const next = calculateDynamicCycleAverage(logs, fallback);
  const cur = useAppStore.getState().cycleLengthAvg;
  if (next === cur) return;

  if (isGhost) {
    appStorage.set(GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY, next);
    useAppStore.getState().setCycleLengthAvg(next);
    return;
  }

  if (!userId) return;
  const { error: upErr } = await supabase
    .from('profiles')
    .upsert({ id: userId, cycle_length_avg: next }, { onConflict: 'id' });
  if (upErr) return;
  useAppStore.getState().setCycleLengthAvg(next);
}
