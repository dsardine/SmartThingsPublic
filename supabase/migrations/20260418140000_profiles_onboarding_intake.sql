-- Sprint 6: Day-zero intake + onboarding gate (profiles)

alter table public.profiles
  add column if not exists last_period_date date;

alter table public.profiles
  add column if not exists cycle_length_avg integer not null default 28;

alter table public.profiles
  add column if not exists onboarding_completed boolean not null default false;

alter table public.profiles drop constraint if exists profiles_cycle_length_avg_check;
alter table public.profiles
  add constraint profiles_cycle_length_avg_check
  check (cycle_length_avg >= 21 and cycle_length_avg <= 50);

comment on column public.profiles.last_period_date is 'First day of last menstrual period (LMP) from intake; ISO calendar date.';
comment on column public.profiles.cycle_length_avg is 'Typical cycle length in days (intake default 28; clamped 21–50).';
comment on column public.profiles.onboarding_completed is 'When false, client routes to onboarding before main tabs.';
