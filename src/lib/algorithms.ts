/**
 * Free-tier symptothermal rules (3-over-6 + RHR confirmation).
 * Keep in sync with `supabase/functions/_shared/algorithms.ts` for Edge parity.
 */

import { addCalendarDays, isoDateString, parseIsoDate } from '@/src/lib/dateDisplay';

export type TemperatureUnitForAlgo = 'F' | 'C';

/** One calendar day of chartable inputs (manual BBT overrides wearable temp). */
export type DailyFertilityInput = {
  date: string;
  manual_bbt: number | null;
  sleeping_temp: number | null;
  rhr: number | null;
};

export type FertileWindowAlgorithmResult = {
  fertility_score: number;
  ai_narrative: string;
  /** Premium-only signals; always false for rules engine output. */
  is_implantation_dip: boolean;
  is_triphasic: boolean;
  estimated_ovulation_date: string | null;
  /** True when RHR does not confirm the shift or data are sparse. */
  is_estimate: boolean;
};

/** Day-zero intake: LMP + typical cycle length (used when temps are not yet decisive). */
export type ProfileCycleIntake = {
  last_period_date: string;
  cycle_length_avg: number;
};

/** Data priority: `manual_bbt` first, else `sleeping_temp`. */
export function effectiveChartedTemp(row: DailyFertilityInput): number | null {
  if (row.manual_bbt != null && Number.isFinite(row.manual_bbt)) {
    return row.manual_bbt;
  }
  if (row.sleeping_temp != null && Number.isFinite(row.sleeping_temp)) {
    return row.sleeping_temp;
  }
  return null;
}

export function thresholdDelta(temperatureUnit: TemperatureUnitForAlgo): number {
  return temperatureUnit === 'F' ? 0.4 : 0.2;
}

function mergeByDate(sortedAsc: DailyFertilityInput[]): DailyFertilityInput[] {
  const byDate = new Map<string, DailyFertilityInput>();
  for (const row of sortedAsc) {
    const cur: DailyFertilityInput = byDate.get(row.date) ?? {
      date: row.date,
      manual_bbt: null,
      sleeping_temp: null,
      rhr: null,
    };
    if (row.manual_bbt != null) cur.manual_bbt = row.manual_bbt;
    if (row.sleeping_temp != null) cur.sleeping_temp = row.sleeping_temp;
    if (row.rhr != null) cur.rhr = row.rhr;
    byDate.set(row.date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calendar-style ovulation estimate from intake: ovulation ≈ LMP + (cycleLength − 14).
 * Returns ISO `YYYY-MM-DD` or null if inputs are unusable.
 */
export function estimatedOvulationFromProfileIntake(intake: ProfileCycleIntake): string | null {
  const { last_period_date, cycle_length_avg } = intake;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last_period_date)) return null;
  const cl = Math.round(Number(cycle_length_avg));
  if (!Number.isFinite(cl) || cl < 21 || cl > 50) return null;
  const lmp = parseIsoDate(last_period_date);
  if (Number.isNaN(lmp.getTime())) return null;
  const ov = addCalendarDays(lmp, cl - 14);
  return isoDateString(ov);
}

function noThermalShiftResult(
  temperatureUnit: TemperatureUnitForAlgo,
  profileFallback?: ProfileCycleIntake | null,
): FertileWindowAlgorithmResult {
  if (profileFallback) {
    const est = estimatedOvulationFromProfileIntake(profileFallback);
    if (est) {
      return {
        fertility_score: 46,
        ai_narrative: `No sustained thermal shift matching the 3-over-6 rule yet. Using your intake cycle (${profileFallback.cycle_length_avg} days from LMP ${profileFallback.last_period_date}), approximate ovulation is ${est} (luteal-phase heuristic). Keep logging BBT or sleeping temperature plus RHR; we will replace this estimate once the chart confirms a shift (${temperatureUnit === 'F' ? '≥0.4°F' : '≥0.2°C'} rule).`,
        is_implantation_dip: false,
        is_triphasic: false,
        estimated_ovulation_date: est,
        is_estimate: true,
      };
    }
  }
  return {
    fertility_score: 44,
    ai_narrative:
      'No sustained thermal shift matching the 3-over-6 rule yet. Keep logging BBT or sleeping temperature plus RHR; we will flag ovulation once the pattern is clear.',
    is_implantation_dip: false,
    is_triphasic: false,
    estimated_ovulation_date: null,
    is_estimate: true,
  };
}

/**
 * Symptothermal 3-over-6: three consecutive charted temps are each >= threshold above
 * the maximum of the six prior calendar days (same unit as `temperatureUnit`).
 *
 * Progesterone inversion: on the first elevated day, RHR must be >= 3 BPM above the
 * trailing 7-day mean RHR (uses up to 7 finite samples before that day; needs >= 4).
 *
 * When no shift is detected and `profileFallback` is provided, uses LMP + cycle length
 * for an approximate ovulation date until enough biometric data exist.
 */
export function calculateFertileWindow(
  dailySeriesAsc: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
  profileFallback?: ProfileCycleIntake | null,
): FertileWindowAlgorithmResult {
  const series = mergeByDate(
    [...dailySeriesAsc].sort((a, b) => a.date.localeCompare(b.date)),
  );
  const delta = thresholdDelta(temperatureUnit);
  const n = series.length;

  let chosenStart = -1;
  for (let i = 6; i + 2 < n; i++) {
    const prev6 = series.slice(i - 6, i);
    const prevTemps = prev6.map(effectiveChartedTemp);
    if (prevTemps.some((t) => t == null)) continue;
    const baseline = Math.max(...(prevTemps as number[]));

    const h0 = effectiveChartedTemp(series[i]!);
    const h1 = effectiveChartedTemp(series[i + 1]!);
    const h2 = effectiveChartedTemp(series[i + 2]!);
    if (h0 == null || h1 == null || h2 == null) continue;

    if (h0 >= baseline + delta && h1 >= baseline + delta && h2 >= baseline + delta) {
      chosenStart = i;
    }
  }

  if (chosenStart < 0) {
    return noThermalShiftResult(temperatureUnit, profileFallback ?? null);
  }

  const i = chosenStart;
  const trailingRhr = series.slice(i - 7, i).map((r) => r.rhr);
  const finite = trailingRhr.filter((x): x is number => x != null && Number.isFinite(x));
  const rhrFirstHigh = series[i]!.rhr;
  let rhrConfirmed = false;
  if (finite.length >= 4 && rhrFirstHigh != null && Number.isFinite(rhrFirstHigh)) {
    const avg = finite.reduce((a, b) => a + b, 0) / finite.length;
    rhrConfirmed = rhrFirstHigh >= avg + 3;
  }

  const estimatedOvulationDate = i > 0 ? series[i - 1]!.date : null;

  const fertility_score = rhrConfirmed ? 80 : 63;
  const is_estimate = !rhrConfirmed;

  const ai_narrative = rhrConfirmed
    ? `Thermal shift confirmed (3-over-6 vs the highest of the prior six days, ${temperatureUnit === 'F' ? '≥0.4°F' : '≥0.2°C'}). Resting HR supports a progesterone shift (≥3 BPM vs your trailing 7-day average). Estimated ovulation (night before first elevated temp): ${estimatedOvulationDate ?? 'unknown'}.`
    : `Thermal shift matches the 3-over-6 rule, but resting HR has not confirmed the usual progesterone pattern (need ≥3 BPM above the trailing 7-day average on the first elevated day). Treat ovulation timing as provisional. Estimated ovulation: ${estimatedOvulationDate ?? 'unknown'}.`;

  return {
    fertility_score,
    ai_narrative,
    is_implantation_dip: false,
    is_triphasic: false,
    estimated_ovulation_date: estimatedOvulationDate,
    is_estimate,
  };
}

/**
 * Algorithmic coverline (no user dragging): baseline of the six days before the
 * confirmed shift plus the symptothermal threshold — same construction as 3-over-6.
 */
export function getAlgorithmicCoverlineY(
  dailySeriesAsc: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
): { coverlineY: number; shiftStartDate: string } | null {
  const series = mergeByDate(
    [...dailySeriesAsc].sort((a, b) => a.date.localeCompare(b.date)),
  );
  const delta = thresholdDelta(temperatureUnit);
  const n = series.length;
  let chosenStart = -1;
  for (let i = 6; i + 2 < n; i++) {
    const prev6 = series.slice(i - 6, i);
    const prevTemps = prev6.map(effectiveChartedTemp);
    if (prevTemps.some((t) => t == null)) continue;
    const baseline = Math.max(...(prevTemps as number[]));

    const h0 = effectiveChartedTemp(series[i]!);
    const h1 = effectiveChartedTemp(series[i + 1]!);
    const h2 = effectiveChartedTemp(series[i + 2]!);
    if (h0 == null || h1 == null || h2 == null) continue;

    if (h0 >= baseline + delta && h1 >= baseline + delta && h2 >= baseline + delta) {
      chosenStart = i;
    }
  }
  if (chosenStart < 0) return null;

  const prev6 = series.slice(chosenStart - 6, chosenStart);
  const baseline = Math.max(...(prev6.map(effectiveChartedTemp) as number[]));
  return {
    coverlineY: baseline + delta,
    shiftStartDate: series[chosenStart]!.date,
  };
}
