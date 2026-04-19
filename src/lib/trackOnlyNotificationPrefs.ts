import { appStorage } from '@/src/lib/storage';

const TRACK_ONLY_BBT_DAILY_OPT_IN = 'track_only_bbt_daily_reminders_opt_in';

/** Default off: track-only users are not nudged for daily BBT unless they opt in here. */
export function getTrackOnlyBbtDailyRemindersOptIn(): boolean {
  return appStorage.getBoolean(TRACK_ONLY_BBT_DAILY_OPT_IN) === true;
}

export function setTrackOnlyBbtDailyRemindersOptIn(value: boolean): void {
  appStorage.set(TRACK_ONLY_BBT_DAILY_OPT_IN, value);
}
