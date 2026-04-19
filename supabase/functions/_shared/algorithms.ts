/**
 * Free-tier symptothermal rules (3-over-6 + RHR confirmation).
 * SYNC with `src/lib/algorithms.ts` — update both files together.
 */

export type TemperatureUnitForAlgo = "F" | "C";

export type DailyFertilityInput = {
  date: string;
  manual_bbt: number | null;
  sleeping_temp: number | null;
  rhr: number | null;
};

export type FertileWindowAlgorithmResult = {
  fertility_score: number;
  ai_narrative: string;
  is_implantation_dip: boolean;
  is_triphasic: boolean;
  estimated_ovulation_date: string | null;
  is_estimate: boolean;
};

export type ProfileCycleIntake = {
  last_period_date: string;
  cycle_length_avg: number;
};

/** One row per calendar day for cycle-length math (duplicate dates: last row wins). SYNC with app `ManualLogs`. */
export type ManualLogs = {
  date: string;
  bleeding: string | null;
};

function mergeManualLogsByDateChronological(manualLogs: ManualLogs[]): ManualLogs[] {
  const sorted = [...manualLogs].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map<string, ManualLogs>();
  for (const row of sorted) {
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function calendarDaysBetweenCd1Iso(fromIso: string, toIso: string): number {
  if (fromIso >= toIso) return 0;
  let n = 0;
  let cur = fromIso;
  while (cur < toIso) {
    n += 1;
    cur = addCalendarDaysIso(cur, 1);
  }
  return n;
}

function isFlowBleedingForCd1(b: string | null): boolean {
  return b === "Light" || b === "Medium" || b === "Heavy";
}

/**
 * Rolling cycle length from logged bleeding.
 * CD1: Light/Medium/Heavy when prior day is not Light/Medium/Heavy (Spotting/null = non-flow). SYNC with app.
 */
export function calculateDynamicCycleAverage(manualLogs: ManualLogs[], fallbackAverage: number): number {
  const fb = Math.round(Number(fallbackAverage));
  const safeFallback = Number.isFinite(fb) ? fb : 28;

  const series = mergeManualLogsByDateChronological(manualLogs);
  const byDate = new Map<string, string | null>();
  for (const row of series) {
    byDate.set(row.date, row.bleeding);
  }

  const cd1Dates: string[] = [];
  for (const row of series) {
    if (!isFlowBleedingForCd1(row.bleeding)) continue;
    const prev = addCalendarDaysIso(row.date, -1);
    const prevBleed = byDate.get(prev) ?? null;
    if (isFlowBleedingForCd1(prevBleed)) continue;
    cd1Dates.push(row.date);
  }

  const rawLengths: number[] = [];
  for (let i = 0; i < cd1Dates.length - 1; i += 1) {
    rawLengths.push(calendarDaysBetweenCd1Iso(cd1Dates[i]!, cd1Dates[i + 1]!));
  }

  const validLengths = rawLengths.filter((len) => len >= 21 && len <= 45);
  if (validLengths.length < 2) return safeFallback;

  const recent = validLengths.slice(-6);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return Math.round(mean);
}

function addCalendarDaysIso(iso: string, days: number): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function estimatedOvulationFromProfileIntake(intake: ProfileCycleIntake): string | null {
  const { last_period_date, cycle_length_avg } = intake;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last_period_date)) return null;
  const cl = Math.round(Number(cycle_length_avg));
  if (!Number.isFinite(cl) || cl < 21 || cl > 50) return null;
  return addCalendarDaysIso(last_period_date, cl - 14);
}

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
  return temperatureUnit === "F" ? 0.4 : 0.2;
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

function noThermalShiftResult(
  temperatureUnit: TemperatureUnitForAlgo,
  profileFallback?: ProfileCycleIntake | null,
): FertileWindowAlgorithmResult {
  if (profileFallback) {
    const est = estimatedOvulationFromProfileIntake(profileFallback);
    if (est) {
      return {
        fertility_score: 46,
        ai_narrative: `No sustained thermal shift matching the 3-over-6 rule yet. Using your intake cycle (${profileFallback.cycle_length_avg} days from LMP ${profileFallback.last_period_date}), approximate ovulation is ${est} (luteal-phase heuristic). Keep logging BBT or sleeping temperature plus RHR; we will replace this estimate once the chart confirms a shift (${temperatureUnit === "F" ? "≥0.4°F" : "≥0.2°C"} rule).`,
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
      "No sustained thermal shift matching the 3-over-6 rule yet. Keep logging BBT or sleeping temperature plus RHR; we will flag ovulation once the pattern is clear.",
    is_implantation_dip: false,
    is_triphasic: false,
    estimated_ovulation_date: null,
    is_estimate: true,
  };
}

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
    ? `Thermal shift confirmed (3-over-6 vs the highest of the prior six days, ${temperatureUnit === "F" ? "≥0.4°F" : "≥0.2°C"}). Resting HR supports a progesterone shift (≥3 BPM vs your trailing 7-day average). Estimated ovulation (night before first elevated temp): ${estimatedOvulationDate ?? "unknown"}.`
    : `Thermal shift matches the 3-over-6 rule, but resting HR has not confirmed the usual progesterone pattern (need ≥3 BPM above the trailing 7-day average on the first elevated day). Treat ovulation timing as provisional. Estimated ovulation: ${estimatedOvulationDate ?? "unknown"}.`;

  return {
    fertility_score,
    ai_narrative,
    is_implantation_dip: false,
    is_triphasic: false,
    estimated_ovulation_date: estimatedOvulationDate,
    is_estimate,
  };
}
