import type { ClinicalState, TrackingGoal } from '@/src/types/database';

/** Shown on onboarding and Settings — matches `profiles.tracking_goal`. */
export const WHY_HERE_OPTIONS: {
  value: TrackingGoal;
  title: string;
  subtitle: string;
}[] = [
  {
    value: 'conceive',
    title: 'Trying to get pregnant',
    subtitle: "We'll lean into timing, BBT, and fertile-window cues.",
  },
  {
    value: 'avoid',
    title: 'Avoiding pregnancy',
    subtitle: "We'll foreground fertile windows and clear confirmations.",
  },
  {
    value: 'track_only',
    title: 'Just understanding my cycle',
    subtitle: 'Fewer nudges — mainly period rhythm and logging.',
  },
];

/** Shown on Settings — matches `profiles.clinical_state`. */
export const LIFE_STAGE_CHOICES: { value: ClinicalState; title: string }[] = [
  { value: 'cycling', title: 'Charting as usual' },
  { value: 'pregnant', title: 'Pregnant' },
  { value: 'postpartum', title: 'Postpartum' },
  { value: 'loss', title: 'After a loss' },
];
