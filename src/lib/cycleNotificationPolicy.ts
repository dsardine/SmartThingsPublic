import type { TrackingGoal } from '@/src/types/database';

import { getTrackOnlyBbtDailyRemindersOptIn } from '@/src/lib/trackOnlyNotificationPrefs';

/**
 * Whether the product may surface **daily** BBT logging nudges (local alerts, future push, etc.).
 * Track-only: only when the user has explicitly opted in under Preferences.
 */
export function shouldOfferDailyBbtReminders(trackingGoal: TrackingGoal): boolean {
  if (trackingGoal === 'track_only') {
    return getTrackOnlyBbtDailyRemindersOptIn();
  }
  return true;
}

/**
 * High-level alerts that are appropriate for `track_only` (period horizon, coarse phase shifts).
 * Wire these when adding scheduled notifications or inbox-style summaries.
 */
export const TRACK_ONLY_HIGH_LEVEL_ALERT_KINDS = [
  'period_expected_window',
  'phase_change_luteal',
  'phase_change_follicular',
] as const;
