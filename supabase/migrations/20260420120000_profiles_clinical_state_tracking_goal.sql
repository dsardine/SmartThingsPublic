-- Clinical mode + user goal; anchor resets CD1-based cycle math after pregnancy/loss/postpartum.

alter table public.profiles
  add column if not exists clinical_state text not null default 'cycling';

alter table public.profiles
  add column if not exists tracking_goal text not null default 'track_only';

alter table public.profiles
  add column if not exists clinical_cycle_anchor_iso date;

alter table public.profiles drop constraint if exists profiles_clinical_state_check;
alter table public.profiles
  add constraint profiles_clinical_state_check
  check (clinical_state in ('cycling', 'pregnant', 'postpartum', 'loss'));

alter table public.profiles drop constraint if exists profiles_tracking_goal_check;
alter table public.profiles
  add constraint profiles_tracking_goal_check
  check (tracking_goal in ('conceive', 'avoid', 'track_only'));

comment on column public.profiles.clinical_state is
  'cycling = full algorithms; other values pause symptothermal / ovulation math until cycling resumes.';
comment on column public.profiles.tracking_goal is
  'conceive | avoid | track_only — drives dashboard prompts and background score cadence.';
comment on column public.profiles.clinical_cycle_anchor_iso is
  'When set, dynamic cycle length uses only manual_logs bleeding on/after this date (new CD1 stream after pregnancy/loss).';
