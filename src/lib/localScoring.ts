/**
 * Free-tier wearable-first adjustments layered on symptothermal output.
 * SYNC with `supabase/functions/_shared/localScoring.ts`.
 */

import {
  effectiveChartedTemp,
  thresholdDelta,
  type DailyFertilityInput,
  type FertileWindowAlgorithmResult,
  type TemperatureUnitForAlgo,
} from '@/src/lib/algorithms';
import {
  SCORE_ATTRIBUTION_SYMPTOTHERMAL,
  SCORE_ATTRIBUTION_WEARABLES,
} from '@/src/lib/cachedInsight';
import type { TrackingGoal } from '@/src/types/database';

/** Free users stay at or below this cap (passive + thermal) until premium / AI. */
export const FREE_TIER_LOCAL_SCORE_CAP = 75;

export type ScoreBasis = 'wearables' | 'symptothermal';

export type LocalBioScoreResult = {
  fertility_score: number;
  score_basis: ScoreBasis;
  /** Prepended to the rules narrative in `cached_insight`. */
  scoreAttributionLine: string;
};

const MUCUS_LOOKBACK_DAYS = 14;
const ROLLING_DAYS = 7;
const MIN_POINTS_FOR_AVG = 4;

function sortAsc(series: DailyFertilityInput[]): DailyFertilityInput[] {
  return [...series].sort((a, b) => a.date.localeCompare(b.date));
}

function hasRecentCervicalMucus(seriesAsc: DailyFertilityInput[]): boolean {
  const n = seriesAsc.length;
  if (n === 0) return false;
  const start = Math.max(0, n - MUCUS_LOOKBACK_DAYS);
  for (let i = start; i < n; i++) {
    const cf = seriesAsc[i]?.cervical_fluid;
    if (cf != null && String(cf).trim() !== '') return true;
  }
  return false;
}

/** Days with index in [endExclusive - len, endExclusive) — e.g. prior 7 days before `endExclusive`. */
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

/**
 * Passive proxy when recent manual mucus is absent: RHR / HRV vs 7-day means, synced vitals, goal weights.
 * Always caps free-tier output at {@link FREE_TIER_LOCAL_SCORE_CAP}.
 */
export function calculateLocalBioScore(args: {
  dailySeriesAsc: DailyFertilityInput[];
  temperatureUnit: TemperatureUnitForAlgo;
  thermal: FertileWindowAlgorithmResult;
  trackingGoal: TrackingGoal;
}): LocalBioScoreResult {
  const { temperatureUnit, thermal, trackingGoal } = args;
  const seriesAsc = sortAsc(args.dailySeriesAsc);

  let score = Math.round(Number(thermal.fertility_score));
  if (!Number.isFinite(score)) score = 44;

  if (hasRecentCervicalMucus(seriesAsc)) {
    return {
      fertility_score: Math.min(FREE_TIER_LOCAL_SCORE_CAP, score),
      score_basis: 'symptothermal',
      scoreAttributionLine: SCORE_ATTRIBUTION_SYMPTOTHERMAL,
    };
  }

  const passiveScale =
    trackingGoal === 'conceive' ? 1 : trackingGoal === 'avoid' ? 1 : 0.55;

  const i = lastVitalsIndex(seriesAsc);
  if (i < ROLLING_DAYS) {
    return {
      fertility_score: Math.min(FREE_TIER_LOCAL_SCORE_CAP, score),
      score_basis: 'wearables',
      scoreAttributionLine: SCORE_ATTRIBUTION_WEARABLES,
    };
  }

  const prior7 = windowPrior(seriesAsc, i, ROLLING_DAYS);
  const prevRhrAvg = meanFinite(prior7.map((r) => r.rhr));
  const latestRhr = seriesAsc[i]?.rhr;

  const hrvAvg = meanFinite(prior7.map((r) => r.hrv));
  const latestHrv = seriesAsc[i]?.hrv;

  // RHR vs 7-day mean while BBT has not confirmed a shift (follicular plateau).
  if (
    prevRhrAvg != null &&
    latestRhr != null &&
    Number.isFinite(latestRhr) &&
    latestRhr > prevRhrAvg + 2 &&
    bbtStillAtFollicularBaseline(seriesAsc, i, temperatureUnit, thermal)
  ) {
    const bump =
      trackingGoal === 'conceive'
        ? 12
        : trackingGoal === 'avoid'
          ? 6
          : 7;
    score += Math.round(bump * passiveScale);
  }

  // HRV dip >10% under trailing mean — estrogen / autonomic stress proxy when mucus is missing.
  if (hrvAvg != null && hrvAvg > 0 && latestHrv != null && Number.isFinite(latestHrv) && latestHrv < hrvAvg * 0.9) {
    const bump = trackingGoal === 'avoid' ? 14 : trackingGoal === 'conceive' ? 12 : 7;
    score += Math.round(bump * passiveScale);
  }

  // Synced rise: RHR up with material BBT rise vs prior window → supports post-ovulatory read.
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
      score += Math.round((trackingGoal === 'conceive' ? 8 : 5) * passiveScale);
    }
  }

  // Avoid: sustained thermal shift (3-over-6 path) is the safety anchor — pull score down when shift is firm.
  if (trackingGoal === 'avoid' && thermal.estimated_ovulation_date != null) {
    const strong = thermal.is_estimate === false && thermal.fertility_score >= 70;
    score -= strong ? 18 : 10;
  }

  // Conceive: modest lift when thermal already found ovulation timing.
  if (trackingGoal === 'conceive' && thermal.estimated_ovulation_date != null) {
    score += 4;
  }

  score = Math.max(0, Math.min(FREE_TIER_LOCAL_SCORE_CAP, Math.round(score)));

  return {
    fertility_score: score,
    score_basis: 'wearables',
    scoreAttributionLine: SCORE_ATTRIBUTION_WEARABLES,
  };
}
