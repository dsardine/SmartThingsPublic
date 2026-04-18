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

export function calculateFertileWindow(
  dailySeriesAsc: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
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
