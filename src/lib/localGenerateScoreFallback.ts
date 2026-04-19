/**
 * When `generate-score` is not deployed (404 / "not found"), run the same free-tier
 * rules + local scoring path the edge function uses and insert into `cached_insight`.
 * SYNC logic with `supabase/functions/generate-score/index.ts` (computeFreeTierUnified,
 * statistical period-only, paused clinical).
 */

import { buildCachedInsightText } from '@/src/lib/cachedInsight';
import {
  calculateFertileWindow,
  type DailyFertilityInput,
  type FertileWindowAlgorithmResult,
  type ProfileCycleIntake,
  type TemperatureUnitForAlgo,
} from '@/src/lib/algorithms';
import { calculateLocalBioScore } from '@/src/lib/localScoring';
import { fetchPeriodCountdownAnchorIso } from '@/src/lib/periodCd1Anchor';
import { supabase } from '@/src/lib/supabase';
import { useAppStore } from '@/src/store';
import type { ClinicalState, TrackingGoal } from '@/src/types/database';

const STATISTICAL_DETECTIVE_TAIL =
  '\n\n— Based on your cycle history so far. Logging morning BBT or cervical fluid would help verify this estimated window with higher precision.';

type ScoreBasis = 'wearables' | 'symptothermal';

type UnifiedScore = {
  fertility_score: number;
  ai_narrative: string;
  is_implantation_dip: boolean;
  is_triphasic: boolean;
  estimated_ovulation_date: string | null;
  is_estimate: boolean;
  clinical_engine_paused?: boolean;
  score_basis?: ScoreBasis;
  statistical_period_only?: boolean;
  full_confidence_requires_premium?: boolean;
  confidence_cap_applied?: boolean;
};

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function rulesResultToUnified(r: FertileWindowAlgorithmResult): UnifiedScore {
  return {
    fertility_score: clampScore(r.fertility_score),
    ai_narrative: r.ai_narrative,
    is_implantation_dip: r.is_implantation_dip,
    is_triphasic: r.is_triphasic,
    estimated_ovulation_date: r.estimated_ovulation_date,
    is_estimate: r.is_estimate,
    clinical_engine_paused: r.clinical_engine_paused ?? false,
  };
}

function computeFreeTierUnified(
  dailySeries: DailyFertilityInput[],
  temperatureUnit: TemperatureUnitForAlgo,
  profileFallback: ProfileCycleIntake | null,
  clinicalState: ClinicalState,
  trackingGoal: TrackingGoal,
  isPremium: boolean,
  isLimitedData: boolean,
): UnifiedScore {
  const algo = calculateFertileWindow(
    dailySeries,
    temperatureUnit,
    profileFallback,
    clinicalState,
  );
  const local = calculateLocalBioScore({
    dailySeriesAsc: dailySeries,
    temperatureUnit,
    thermal: algo,
    trackingGoal,
    isPremium,
    isLimitedData,
  });
  const rules = rulesResultToUnified(algo);
  return {
    ...rules,
    fertility_score: local.fertility_score,
    ai_narrative: `${local.scoreAttributionLine}\n\n${algo.ai_narrative}`,
    score_basis: local.score_basis,
    full_confidence_requires_premium: local.full_confidence_requires_premium,
    confidence_cap_applied: local.confidence_cap_applied,
  };
}

function applyStatisticalDetectiveAdjustments(
  u: UnifiedScore,
  active: boolean,
): UnifiedScore {
  if (!active) return u;
  const fertility_score = Math.min(70, clampScore(u.fertility_score));
  const ai_narrative = u.ai_narrative.includes('cycle history so far')
    ? u.ai_narrative
    : `${u.ai_narrative.trimEnd()}${STATISTICAL_DETECTIVE_TAIL}`;
  return {
    ...u,
    fertility_score,
    is_estimate: true,
    statistical_period_only: true,
    ai_narrative,
  };
}

function seriesHasAnyBbt(series: DailyFertilityInput[]): boolean {
  return series.some((d) => d.manual_bbt != null && Number.isFinite(Number(d.manual_bbt)));
}

async function loadDailySeriesForScore(userId: string): Promise<DailyFertilityInput[]> {
  const [{ data: bio, error: bioErr }, { data: logs, error: logsErr }] = await Promise.all([
    supabase
      .from('biometrics')
      .select('date, sleeping_temp, rhr, hrv, respiratory_rate, created_at')
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .limit(200),
    supabase
      .from('manual_logs')
      .select('date, manual_bbt, exclude_temp, disturbances, cervical_fluid, bleeding')
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .limit(200),
  ]);
  if (bioErr) console.warn('local score: biometrics slice', bioErr.message);
  if (logsErr) console.warn('local score: manual_logs slice', logsErr.message);

  const byDate = new Map<string, DailyFertilityInput>();

  for (const row of bio ?? []) {
    const r = row as Record<string, unknown>;
    const d = typeof r.date === 'string' ? r.date : null;
    if (!d) continue;
    const cur = byDate.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (r.sleeping_temp != null) cur.sleeping_temp = Number(r.sleeping_temp);
    if (r.rhr != null) cur.rhr = Number(r.rhr);
    if (r.hrv != null && Number.isFinite(Number(r.hrv))) cur.hrv = Number(r.hrv);
    if (r.respiratory_rate != null && Number.isFinite(Number(r.respiratory_rate))) {
      cur.respiratory_rate = Number(r.respiratory_rate);
    }
    byDate.set(d, cur);
  }

  for (const row of logs ?? []) {
    const r = row as Record<string, unknown>;
    const d = typeof r.date === 'string' ? r.date : null;
    if (!d) continue;
    const cur = byDate.get(d) ?? { date: d, manual_bbt: null, sleeping_temp: null, rhr: null };
    if (r.manual_bbt != null) cur.manual_bbt = Number(r.manual_bbt);
    if (r.exclude_temp === true) cur.exclude_temp = true;
    const dist = r.disturbances;
    if (Array.isArray(dist) && dist.length > 0) {
      cur.disturbances = dist.map((x) => String(x));
    }
    const cf = r.cervical_fluid;
    if (cf != null && String(cf).trim() !== '') {
      cur.cervical_fluid = String(cf);
    }
    const bl = r.bleeding;
    if (bl != null && String(bl).trim() !== '') {
      cur.bleeding = String(bl);
    }
    byDate.set(d, cur);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function manualLogsHaveBleeding(userId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('manual_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .not('bleeding', 'is', null);
  if (error) {
    console.warn('local score: bleeding probe', error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

async function biometricsRowCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('biometrics')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) {
    console.warn('local score: biometrics count', error.message);
    return 0;
  }
  return count ?? 0;
}

function isStatisticalDetectivePeriod(
  biometricsRowCount: number,
  dailySeries: DailyFertilityInput[],
  hasBleeding: boolean,
): boolean {
  if (biometricsRowCount > 0) return false;
  if (seriesHasAnyBbt(dailySeries)) return false;
  return hasBleeding;
}

async function clearHasNewBiometrics(userId: string): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ has_new_biometrics: false })
    .eq('id', userId);
  if (error) console.warn('local score: has_new_biometrics clear', error.message);
}

export function isEdgeFunctionNotFoundMessage(detail: string, httpStatus?: number): boolean {
  if (httpStatus === 404) return true;
  const t = detail.toLowerCase();
  return (
    t.includes('not found') ||
    t.includes('not_found') ||
    t.includes('requested function') ||
    /function.*not.*found/i.test(detail)
  );
}

export async function runLocalGenerateScoreFallback(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'Not signed in.' };

  const { data: prof, error: pErr } = await supabase
    .from('profiles')
    .select(
      'temperature_unit, last_period_date, cycle_length_avg, onboarding_completed, clinical_state, tracking_goal, user_tier',
    )
    .eq('id', user.id)
    .maybeSingle();

  if (pErr || !prof) {
    return { ok: false, reason: pErr?.message ?? 'Profile row missing.' };
  }

  const tempUnit: TemperatureUnitForAlgo = prof.temperature_unit === 'C' ? 'C' : 'F';

  const rawClinical = prof.clinical_state as ClinicalState | null | undefined;
  const clinicalState: ClinicalState =
    rawClinical === 'pregnant' ||
    rawClinical === 'postpartum' ||
    rawClinical === 'loss' ||
    rawClinical === 'cycling'
      ? rawClinical
      : 'cycling';

  let profileFallback: ProfileCycleIntake | null = null;
  const clRaw = prof.cycle_length_avg;
  const clNum = typeof clRaw === 'number' ? clRaw : Number(clRaw);
  if (
    prof.onboarding_completed === true &&
    typeof prof.last_period_date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(prof.last_period_date) &&
    Number.isFinite(clNum)
  ) {
    profileFallback = { last_period_date: prof.last_period_date, cycle_length_avg: clNum };
  }

  if (profileFallback == null && Number.isFinite(clNum)) {
    const clRounded = Math.round(Number(clNum));
    if (clRounded >= 21 && clRounded <= 50) {
      try {
        const cd1 = await fetchPeriodCountdownAnchorIso(useAppStore.getState().isGhostModeEnabled);
        if (cd1) {
          profileFallback = { last_period_date: cd1, cycle_length_avg: clRounded };
        }
      } catch {
        /* keep null */
      }
    }
  }

  const rawGoal = prof.tracking_goal;
  const trackingGoal: TrackingGoal =
    rawGoal === 'conceive' || rawGoal === 'avoid' || rawGoal === 'track_only' ? rawGoal : 'track_only';

  const tierRaw = (prof as { user_tier?: string | null }).user_tier;
  const isPremium = tierRaw === 'premium';

  if (clinicalState !== 'cycling') {
    const paused = calculateFertileWindow([], tempUnit, profileFallback, clinicalState);
    const unified = rulesResultToUnified(paused);
    const insight_text = buildCachedInsightText({
      narrative: unified.ai_narrative,
      estimatedOvulationDate: unified.estimated_ovulation_date,
      isImplantationDip: unified.is_implantation_dip,
      isTriphasic: unified.is_triphasic,
      clinicalEnginePaused: unified.clinical_engine_paused === true,
    });
    const { error: insErr } = await supabase.from('cached_insight').insert({
      user_id: user.id,
      conception_score: unified.fertility_score,
      is_estimate: unified.is_estimate,
      insight_text,
    });
    if (insErr) return { ok: false, reason: insErr.message };
    await clearHasNewBiometrics(user.id);
    return { ok: true };
  }

  const dailySeries = await loadDailySeriesForScore(user.id);
  const bioCount = await biometricsRowCount(user.id);
  const hasBleeding = await manualLogsHaveBleeding(user.id);
  const periodOnly = isStatisticalDetectivePeriod(bioCount, dailySeries, hasBleeding);

  let unified = computeFreeTierUnified(
    dailySeries,
    tempUnit,
    profileFallback,
    clinicalState,
    trackingGoal,
    isPremium,
    periodOnly,
  );
  unified = applyStatisticalDetectiveAdjustments(unified, periodOnly);

  const insight_text = buildCachedInsightText({
    narrative: unified.ai_narrative,
    estimatedOvulationDate: unified.estimated_ovulation_date,
    isImplantationDip: unified.is_implantation_dip,
    isTriphasic: unified.is_triphasic,
    clinicalEnginePaused: unified.clinical_engine_paused === true,
    scoreBasis: unified.score_basis ?? null,
    statisticalPeriodOnly: unified.statistical_period_only === true,
    fullConfidenceRequiresPremium: unified.full_confidence_requires_premium === true,
    confidenceCapApplied: unified.confidence_cap_applied === true,
  });

  const { error: insErr } = await supabase.from('cached_insight').insert({
    user_id: user.id,
    conception_score: unified.fertility_score,
    is_estimate: unified.is_estimate,
    insight_text,
  });
  if (insErr) return { ok: false, reason: insErr.message };
  await clearHasNewBiometrics(user.id);
  return { ok: true };
}
