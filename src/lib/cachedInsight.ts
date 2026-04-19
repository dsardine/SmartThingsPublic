export const SCORE_ATTRIBUTION_WEARABLES =
  'Score based on your wearable biometric trends (RHR & Temp).';
export const SCORE_ATTRIBUTION_SYMPTOTHERMAL =
  'Score verified via Symptothermal confirmation (Mucus + Vitals).';

export type ScoreBasis = 'wearables' | 'symptothermal';

export type ParsedInsight = {
  narrative: string;
  /** Narrative with leading score-attribution line removed when `scoreBasis` is set. */
  narrativeBody: string;
  estimatedOvulationDate: string | null;
  isImplantationDip: boolean;
  isTriphasic: boolean;
  /** True when algorithms were bypassed (non–actively-cycling clinical state). */
  clinicalEnginePaused: boolean;
  /** Present when `cached_insight.insight_text` JSON includes `score_basis` (free tier passive scoring). */
  scoreBasis: ScoreBasis | null;
  /** Period/bleeding logs only — no BBT and no wearable rows (see generate-score data density). */
  statisticalPeriodOnly: boolean;
};

/** Remove prepended attribution block so UI can show it separately. */
export function stripScoreAttributionPrefix(narrative: string): string {
  let t = narrative.trimStart();
  for (const prefix of [SCORE_ATTRIBUTION_WEARABLES, SCORE_ATTRIBUTION_SYMPTOTHERMAL]) {
    if (t.startsWith(prefix)) {
      t = t.slice(prefix.length).trimStart();
      if (t.startsWith('\n\n')) t = t.slice(2).trimStart();
      return t;
    }
  }
  return narrative;
}

function parseScoreBasis(raw: unknown): ScoreBasis | null {
  if (raw === 'wearables' || raw === 'symptothermal') return raw;
  return null;
}

export function parseInsightText(insightText: string): ParsedInsight {
  try {
    const o = JSON.parse(insightText) as Record<string, unknown>;
    if (typeof o.narrative === 'string') {
      const est = o.estimated_ovulation_date;
      const scoreBasis = parseScoreBasis(o.score_basis);
      const narrative = o.narrative;
      return {
        narrative,
        narrativeBody:
          scoreBasis != null ? stripScoreAttributionPrefix(narrative) : narrative,
        estimatedOvulationDate:
          typeof est === 'string' && est.trim() !== '' ? est.trim() : null,
        isImplantationDip: o.is_implantation_dip === true,
        isTriphasic: o.is_triphasic === true,
        clinicalEnginePaused: o.clinical_engine_paused === true,
        scoreBasis,
        statisticalPeriodOnly: o.statistical_period_only === true,
      };
    }
  } catch {
    // plain text legacy
  }
  return {
    narrative: insightText,
    narrativeBody: insightText,
    estimatedOvulationDate: null,
    isImplantationDip: false,
    isTriphasic: false,
    clinicalEnginePaused: false,
    scoreBasis: null,
    statisticalPeriodOnly: false,
  };
}

/** JSON stored in `cached_insight.insight_text` — mirrors edge `toStoredInsightText`. */
export function buildCachedInsightText(args: {
  narrative: string;
  estimatedOvulationDate: string | null;
  isImplantationDip: boolean;
  isTriphasic: boolean;
  clinicalEnginePaused?: boolean;
  scoreBasis?: ScoreBasis | null;
  statisticalPeriodOnly?: boolean;
}): string {
  const payload: Record<string, unknown> = {
    narrative: args.narrative,
    is_implantation_dip: args.isImplantationDip,
    is_triphasic: args.isTriphasic,
    estimated_ovulation_date: args.estimatedOvulationDate,
  };
  if (args.clinicalEnginePaused === true) payload.clinical_engine_paused = true;
  if (args.scoreBasis === 'wearables' || args.scoreBasis === 'symptothermal') {
    payload.score_basis = args.scoreBasis;
  }
  if (args.statisticalPeriodOnly === true) payload.statistical_period_only = true;
  return JSON.stringify(payload);
}

/** Human-readable countdown / offset to an ISO calendar date (YYYY-MM-DD). */
export function formatDaysToOvulation(isoDate: string | null): string {
  if (isoDate == null || isoDate === '') return '—';
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return '—';
  const [y, m, d] = parts;
  const target = new Date(y!, m! - 1, d!);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return '1 day to go';
  if (diff > 1) return `${diff} days to go`;
  if (diff === -1) return '1 day past';
  return `${Math.abs(diff)} days past`;
}
