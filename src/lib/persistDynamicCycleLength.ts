import { calculateDynamicCycleAverage, type ManualLogs } from '@/src/lib/algorithms';
import { addCalendarDays, isoDateString, parseIsoDate } from '@/src/lib/dateDisplay';
import { collectGhostManualLogsForCycleAverage } from '@/src/lib/manualGhostMerge';
import { appStorage, ghostStorage, GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY } from '@/src/lib/storage';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import type { ClinicalState, ManualLogBleeding } from '@/src/types/database';

function isFlowMenstrualBleeding(b: ManualLogBleeding | null): boolean {
  return b === 'Light' || b === 'Medium' || b === 'Heavy';
}

/**
 * After pregnancy, loss, or postpartum, the first logged CD1 (new flow day) anchors rolling
 * cycle-length math so the long gap is excluded from the dynamic average.
 */
export async function maybeSetClinicalCycleAnchorAfterMenstrualCd1(opts: {
  userId: string;
  logDateIso: string;
  bleeding: ManualLogBleeding | null;
}): Promise<void> {
  const { userId, logDateIso, bleeding } = opts;
  if (!isFlowMenstrualBleeding(bleeding)) return;

  const prevIso = isoDateString(addCalendarDays(parseIsoDate(logDateIso), -1));
  const { data: prevRow } = await supabase
    .from('manual_logs')
    .select('bleeding')
    .eq('user_id', userId)
    .eq('date', prevIso)
    .maybeSingle();
  const prevBleed = (prevRow?.bleeding as ManualLogBleeding | null) ?? null;
  if (isFlowMenstrualBleeding(prevBleed)) return;

  const { data: prof } = await supabase
    .from('profiles')
    .select('clinical_state')
    .eq('id', userId)
    .maybeSingle();
  const cs = (prof?.clinical_state as ClinicalState | undefined) ?? 'cycling';
  if (cs !== 'pregnant' && cs !== 'loss' && cs !== 'postpartum') return;

  const { error } = await supabase
    .from('profiles')
    .update({ clinical_cycle_anchor_iso: logDateIso })
    .eq('id', userId);
  if (error) return;
  useAppStore.getState().setClinicalCycleAnchorIso(logDateIso);
}

/**
 * Recomputes rolling cycle length from bleeding history and mirrors the calendar save path:
 * ghost → MMKV + store; signed-in → profiles upsert + store.
 */
export async function persistDynamicCycleLengthAfterBleedingLog(opts: {
  isGhost: boolean;
  userId: string | null;
}): Promise<void> {
  const { isGhost, userId } = opts;

  /** Algorithm shield: rolling CD1 / cycle-length math only while charting as usual. */
  if (useAppStore.getState().clinicalState !== 'cycling') {
    return;
  }

  const fallback = useAppStore.getState().cycleLengthIntakeFallback;

  if (isGhost) {
    const logs = collectGhostManualLogsForCycleAverage(ghostStorage);
    const next = calculateDynamicCycleAverage(logs, fallback);
    const cur = useAppStore.getState().cycleLengthAvg;
    if (next === cur) return;
    appStorage.set(GHOST_DYNAMIC_CYCLE_LENGTH_AVG_KEY, next);
    useAppStore.getState().setCycleLengthAvg(next);
    return;
  }

  if (!userId) return;

  const { data: profileRow, error: profileErr } = await supabase
    .from('profiles')
    .select('clinical_state, clinical_cycle_anchor_iso')
    .eq('id', userId)
    .maybeSingle();
  if (profileErr || !profileRow) return;
  const clinicalState = (profileRow.clinical_state as ClinicalState | undefined) ?? 'cycling';
  if (clinicalState !== 'cycling') {
    return;
  }

  const anchorRaw = profileRow.clinical_cycle_anchor_iso;
  const anchor =
    typeof anchorRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchorRaw) ? anchorRaw : null;

  const { data, error } = await supabase
    .from('manual_logs')
    .select('date, bleeding')
    .eq('user_id', userId)
    .order('date', { ascending: true });
  if (error || !data) return;
  const logs: ManualLogs[] = (data as { date: string; bleeding: ManualLogBleeding | null }[]).map(
    (r) => ({
      date: String(r.date),
      bleeding: (r.bleeding as ManualLogBleeding | null) ?? null,
    }),
  );

  const next = calculateDynamicCycleAverage(logs, fallback, {
    clinicalState,
    cycleCountingAnchorIso: anchor,
  });
  const cur = useAppStore.getState().cycleLengthAvg;
  if (next === cur) return;

  const { error: upErr } = await supabase
    .from('profiles')
    .upsert({ id: userId, cycle_length_avg: next }, { onConflict: 'id' });
  if (upErr) return;
  useAppStore.getState().setCycleLengthAvg(next);
}
