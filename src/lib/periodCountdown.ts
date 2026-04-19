import { addCalendarDays, isoDateString, parseIsoDate } from '@/src/lib/dateDisplay';

/** Next period start from cycle day 1 anchor (profile LMP and/or calendar bleeding) + typical cycle length. */
export function nextPeriodStartIso(lastPeriodIso: string | null, cycleLengthAvg: number): string | null {
  if (lastPeriodIso == null || !/^\d{4}-\d{2}-\d{2}$/.test(lastPeriodIso)) return null;
  const cl = Math.round(Number(cycleLengthAvg));
  if (!Number.isFinite(cl) || cl < 21 || cl > 50) return null;
  const start = parseIsoDate(lastPeriodIso);
  if (Number.isNaN(start.getTime())) return null;
  return isoDateString(addCalendarDays(start, cl));
}

/**
 * Human-readable countdown for track-only dashboard (e.g. "Period in 5 days").
 * `lastPeriodIso` is the resolved CD1 anchor (see `fetchPeriodCountdownAnchorIso`).
 * Uses local calendar midnight for "today".
 */
export function formatNextPeriodCountdown(
  lastPeriodIso: string | null,
  cycleLengthAvg: number,
): string {
  const nextIso = nextPeriodStartIso(lastPeriodIso, cycleLengthAvg);
  if (nextIso == null) {
    return 'Log your period on the calendar to see a countdown';
  }
  const target = parseIsoDate(nextIso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'Period expected today';
  if (diff === 1) return 'Period in 1 day';
  if (diff > 1) return `Period in ${diff} days`;
  if (diff === -1) return 'Period ~1 day overdue — log when it starts';
  return `Period ~${Math.abs(diff)} days overdue`;
}
