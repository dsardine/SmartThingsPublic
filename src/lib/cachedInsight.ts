export type ParsedInsight = {
  narrative: string;
  estimatedOvulationDate: string | null;
  isImplantationDip: boolean;
  isTriphasic: boolean;
};

export function parseInsightText(insightText: string): ParsedInsight {
  try {
    const o = JSON.parse(insightText) as Record<string, unknown>;
    if (typeof o.narrative === 'string') {
      const est = o.estimated_ovulation_date;
      return {
        narrative: o.narrative,
        estimatedOvulationDate:
          typeof est === 'string' && est.trim() !== '' ? est.trim() : null,
        isImplantationDip: o.is_implantation_dip === true,
        isTriphasic: o.is_triphasic === true,
      };
    }
  } catch {
    // plain text legacy
  }
  return {
    narrative: insightText,
    estimatedOvulationDate: null,
    isImplantationDip: false,
    isTriphasic: false,
  };
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
