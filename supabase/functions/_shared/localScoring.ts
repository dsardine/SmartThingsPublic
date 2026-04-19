/**
 * Free-tier wearable-first adjustments layered on symptothermal output.
 * SYNC with `src/lib/localScoring.ts`.
 */

import type {
  DailyFertilityInput,
  FertileWindowAlgorithmResult,
  TemperatureUnitForAlgo,
} from "./algorithms.ts";
import {
  addCalendarDaysIso,
  effectiveChartedTemp,
  findMostRecentCd1AnchorFromBleedingLogs,
  thresholdDelta,
  type ManualLogs,
} from "./algorithms.ts";

export const FREE_TIER_LOCAL_SCORE_CAP = 75;

export type ScoreBasis = "wearables" | "symptothermal";

export type TrackingGoal = "conceive" | "avoid" | "track_only";

export type LocalBioScoreResult = {
  fertility_score: number;
  score_basis: ScoreBasis;
  scoreAttributionLine: string;
  full_confidence_requires_premium?: boolean;
  confidence_cap_applied?: boolean;
};

const MUCUS_LOOKBACK_DAYS = 14;
const ROLLING_DAYS = 7;
const MIN_POINTS_FOR_AVG = 4;

const sympthermalLine =
  "Score verified via Symptothermal confirmation (Mucus + Vitals).";
const wearablesLine = "Score based on your wearable biometric trends (RHR & Temp).";

function sortAsc(series: DailyFertilityInput[]): DailyFertilityInput[] {
  return [...series].sort((a, b) => a.date.localeCompare(b.date));
}

function buildFinalLocalResult(
  rawConceptionScore: number,
  trackingGoal: TrackingGoal,
  isPremium: boolean,
  isLimitedData: boolean,
  rest: { score_basis: ScoreBasis; scoreAttributionLine: string },
): LocalBioScoreResult {
  const requiresCap = !isPremium || isLimitedData;
  let s = Math.round(Number(rawConceptionScore));
  if (!Number.isFinite(s)) s = 44;
  s = Math.max(0, Math.min(100, s));
  if (requiresCap) {
    if (trackingGoal === "avoid") {
      s = Math.max(30, s);
    } else {
      s = Math.min(70, s);
    }
  }
  return {
    fertility_score: s,
    full_confidence_requires_premium: !isPremium ? true : undefined,
    confidence_cap_applied: requiresCap ? true : undefined,
    ...rest,
  };
}

function hasRecentCervicalMucus(seriesAsc: DailyFertilityInput[]): boolean {
  const n = seriesAsc.length;
  if (n === 0) return false;
  const start = Math.max(0, n - MUCUS_LOOKBACK_DAYS);
  for (let i = start; i < n; i++) {
    const cf = seriesAsc[i]?.cervical_fluid;
    if (cf != null && String(cf).trim() !== "") return true;
  }
  return false;
}

function windowPrior(seriesAsc: DailyFertilityInput[], endExclusive: number, len: number): DailyFertilityInput[] {
  const start = Math.max(0, endExclusive - len);
  return seriesAsc.slice(start, endExclusive);
}

function meanFinite(nums: (number | null | undefined)[]): number | null {
  const vals = nums.filter((n): n is number => n != null && Number.isFinite(n));
  if (vals.length < MIN_POINTS_FOR_AVG) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function medianFinite(nums: (number | null)[]): number | null {
  const vals = nums.filter((n): n is number => n != null && Number.isFinite(n));
  if (vals.length < 3) return null;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

function lastVitalsIndex(seriesAsc: DailyFertilityInput[]): number {
  for (let i = seriesAsc.length - 1; i >= 0; i--) {
    const r = seriesAsc[i]!;
    if (
      (r.rhr != null && Number.isFinite(r.rhr)) ||
      effectiveChartedTemp(r) != null ||
      (r.hrv != null && Number.isFinite(r.hrv))
    ) {
      return i;
    }
  }
  return -1;
}

function bbtStillAtFollicularBaseline(
  seriesAsc: DailyFertilityInput[],
  dayIdx: number,
  temperatureUnit: TemperatureUnitForAlgo,
  thermal: FertileWindowAlgorithmResult,
): boolean {
  if (thermal.estimated_ovulation_date != null) return false;
  const prior = windowPrior(seriesAsc, dayIdx, ROLLING_DAYS);
  const med = medianFinite(prior.map((r) => effectiveChartedTemp(r)));
  const latest = effectiveChartedTemp(seriesAsc[dayIdx]!);
  if (med == null || latest == null) return false;
  const tol = thresholdDelta(temperatureUnit) * 0.35;
  return Math.abs(latest - med) <= tol;
}

function bleedingManualLogsFromSeries(seriesAsc: DailyFertilityInput[]): ManualLogs[] {
  const byDate = new Map<string, string | null>();
  for (const r of seriesAsc) {
    if (r.bleeding != null && String(r.bleeding).trim() !== "") {
      byDate.set(r.date, String(r.bleeding));
    }
  }
  return [...byDate.entries()]
    .map(([date, bleeding]) => ({ date, bleeding }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function cycleDayFromCd1(cd1Iso: string, todayIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cd1Iso) || !/^\d{4}-\d{2}-\d{2}$/.test(todayIso)) return null;
  if (todayIso < cd1Iso) return null;
  let cd = 1;
  let cur = cd1Iso;
  while (cur < todayIso) {
    cd += 1;
    cur = addCalendarDaysIso(cur, 1);
  }
  return cd;
}

function baseRiskFromCycleDay(cd: number | null): number {
  if (cd == null) return 85;
  if (cd >= 1 && cd <= 5) return 20;
  if (cd >= 6 && cd <= 7) return 60;
  if (cd >= 8 && cd <= 18) return 85;
  return 40;
}

function utcCalendarIsoToday(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function strictSensiplanThreeOverSixLoggedBbt(
  seriesAsc: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
): boolean {
  const charted: { date: string; t: number }[] = [];
  for (const r of seriesAsc) {
    const t = effectiveChartedTemp(r);
    if (t != null && Number.isFinite(t)) charted.push({ date: r.date, t });
  }
  charted.sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map<string, number>();
  for (const c of charted) {
    byDate.set(c.date, c.t);
  }
  const dNeed = thresholdDelta(temperatureUnit);

  for (let i = charted.length - 3; i >= 0; i -= 1) {
    const a = charted[i]!;
    const b = charted[i + 1]!;
    const c = charted[i + 2]!;
    const bExpect = addCalendarDaysIso(a.date, 1);
    const cExpect = addCalendarDaysIso(b.date, 1);
    if (b.date !== bExpect || c.date !== cExpect) continue;

    const priorTemps: number[] = [];
    let walk = addCalendarDaysIso(a.date, -1);
    for (let guard = 0; guard < 400 && priorTemps.length < 6; guard += 1) {
      const tv = byDate.get(walk);
      if (tv != null && Number.isFinite(tv)) priorTemps.push(tv);
      walk = addCalendarDaysIso(walk, -1);
    }
    if (priorTemps.length < 6) continue;
    const m = Math.max(...priorTemps);
    if (a.t >= m + dNeed && b.t >= m + dNeed && c.t >= m + dNeed) return true;
  }
  return false;
}

function meanOfFinite(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function rollingBaselineAndLatest(
  seriesAsc: DailyFertilityInput[],
  currentIso: string,
  getter: (r: DailyFertilityInput) => number | null | undefined,
): { baseline: number | null; latest: number | null } {
  const windowStartIso = addCalendarDaysIso(currentIso, -14);
  const vals: number[] = [];
  for (const r of seriesAsc) {
    if (r.date < windowStartIso || r.date >= currentIso) continue;
    const v = getter(r);
    if (v != null && Number.isFinite(v)) vals.push(Number(v));
  }
  const baseline = meanOfFinite(vals);
  const curRow = seriesAsc.find((r) => r.date === currentIso);
  const lv = curRow ? getter(curRow) : null;
  const latest = lv != null && Number.isFinite(lv) ? Number(lv) : null;
  return { baseline, latest };
}

function calculateAvoidTunedLocalBioScore(
  seriesAsc: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
  isPremium: boolean,
  isLimitedData: boolean,
): LocalBioScoreResult {
  if (strictSensiplanThreeOverSixLoggedBbt(seriesAsc, temperatureUnit)) {
    return buildFinalLocalResult(10, "avoid", isPremium, isLimitedData, {
      score_basis: "symptothermal",
      scoreAttributionLine: sympthermalLine,
    });
  }

  const todayIso = seriesAsc.length > 0 ? seriesAsc[seriesAsc.length - 1]!.date : utcCalendarIsoToday();
  const logs = bleedingManualLogsFromSeries(seriesAsc);
  const cd1 = findMostRecentCd1AnchorFromBleedingLogs(logs, null);
  const cd = cd1 ? cycleDayFromCd1(cd1, todayIso) : null;
  const baseRisk = baseRiskFromCycleDay(cd);

  let hrvPenalty = 0;
  let rhrPenalty = 0;
  let rrPenalty = 0;

  const h = rollingBaselineAndLatest(seriesAsc, todayIso, (r) => r.hrv);
  if (h.baseline != null && h.latest != null && Number.isFinite(h.baseline)) {
    const deltaHrv = h.latest - h.baseline;
    if (deltaHrv < -3) hrvPenalty = 15;
  }

  const rh = rollingBaselineAndLatest(seriesAsc, todayIso, (r) => r.rhr);
  if (rh.baseline != null && rh.latest != null && Number.isFinite(rh.baseline)) {
    const deltaRhr = rh.latest - rh.baseline;
    if (deltaRhr > 2) rhrPenalty = 10;
  }

  const rr = rollingBaselineAndLatest(seriesAsc, todayIso, (r) => r.respiratory_rate);
  if (rr.baseline != null && rr.latest != null && Number.isFinite(rr.baseline)) {
    const deltaRr = rr.latest - rr.baseline;
    if (deltaRr > 0.5) rrPenalty = 5;
  }

  const raw = Math.min(100, baseRisk + hrvPenalty + rhrPenalty + rrPenalty);

  return buildFinalLocalResult(raw, "avoid", isPremium, isLimitedData, {
    score_basis: "wearables",
    scoreAttributionLine: wearablesLine,
  });
}

export function calculateLocalBioScore(args: {
  dailySeriesAsc: DailyFertilityInput[];
  temperatureUnit: TemperatureUnitForAlgo;
  thermal: FertileWindowAlgorithmResult;
  trackingGoal: TrackingGoal;
  isPremium: boolean;
  isLimitedData: boolean;
}): LocalBioScoreResult {
  const { temperatureUnit, thermal, trackingGoal, isPremium, isLimitedData } = args;
  const seriesAsc = sortAsc(args.dailySeriesAsc);

  if (trackingGoal === "avoid") {
    return calculateAvoidTunedLocalBioScore(seriesAsc, temperatureUnit, isPremium, isLimitedData);
  }

  let score = Math.round(Number(thermal.fertility_score));
  if (!Number.isFinite(score)) score = 44;

  if (hasRecentCervicalMucus(seriesAsc)) {
    return buildFinalLocalResult(
      Math.min(FREE_TIER_LOCAL_SCORE_CAP, score),
      trackingGoal,
      isPremium,
      isLimitedData,
      { score_basis: "symptothermal", scoreAttributionLine: sympthermalLine },
    );
  }

  const passiveScale = trackingGoal === "conceive" ? 1 : 0.55;

  const i = lastVitalsIndex(seriesAsc);
  if (i < ROLLING_DAYS) {
    return buildFinalLocalResult(
      Math.min(FREE_TIER_LOCAL_SCORE_CAP, score),
      trackingGoal,
      isPremium,
      isLimitedData,
      { score_basis: "wearables", scoreAttributionLine: wearablesLine },
    );
  }

  const prior7 = windowPrior(seriesAsc, i, ROLLING_DAYS);
  const prevRhrAvg = meanFinite(prior7.map((r) => r.rhr));
  const latestRhr = seriesAsc[i]?.rhr;

  const hrvAvg = meanFinite(prior7.map((r) => r.hrv));
  const latestHrv = seriesAsc[i]?.hrv;

  if (
    prevRhrAvg != null &&
    latestRhr != null &&
    Number.isFinite(latestRhr) &&
    latestRhr > prevRhrAvg + 2 &&
    bbtStillAtFollicularBaseline(seriesAsc, i, temperatureUnit, thermal)
  ) {
    score += Math.round(12 * passiveScale);
  }

  if (hrvAvg != null && hrvAvg > 0 && latestHrv != null && Number.isFinite(latestHrv) && latestHrv < hrvAvg * 0.9) {
    const bump = trackingGoal === "conceive" ? 12 : 7;
    score += Math.round(bump * passiveScale);
  }

  const priorTemps = prior7.map((r) => effectiveChartedTemp(r)).filter((t): t is number => t != null);
  const last3 = windowPrior(seriesAsc, i + 1, 3);
  const recentTemps = last3.map((r) => effectiveChartedTemp(r)).filter((t): t is number => t != null);
  if (
    prevRhrAvg != null &&
    latestRhr != null &&
    Number.isFinite(latestRhr) &&
    priorTemps.length >= 3 &&
    recentTemps.length >= 2
  ) {
    const meanPriorT = priorTemps.reduce((a, b) => a + b, 0) / priorTemps.length;
    const meanRecentT = recentTemps.reduce((a, b) => a + b, 0) / recentTemps.length;
    const deltaT = thresholdDelta(temperatureUnit);
    if (latestRhr > prevRhrAvg + 1 && meanRecentT >= meanPriorT + deltaT * 0.45) {
      score += Math.round((trackingGoal === "conceive" ? 8 : 5) * passiveScale);
    }
  }

  if (trackingGoal === "conceive" && thermal.estimated_ovulation_date != null) {
    score += 4;
  }

  score = Math.max(0, Math.min(FREE_TIER_LOCAL_SCORE_CAP, Math.round(score)));

  return buildFinalLocalResult(score, trackingGoal, isPremium, isLimitedData, {
    score_basis: "wearables",
    scoreAttributionLine: wearablesLine,
  });
}
