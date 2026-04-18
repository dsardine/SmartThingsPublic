-- Sprint 2: profiles (localization + tier), biometrics, manual_logs — aligned with src/types/database.ts
-- Timestamps use timestamptz (UTC). Calendar fields use `date`. Arrays are explicit text[].

-- ---------------------------------------------------------------------------
-- profiles: new columns with safe defaults for existing rows
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists user_tier text not null default 'free';

alter table public.profiles
  add column if not exists allow_partner_manual_entry boolean not null default false;

alter table public.profiles
  add column if not exists temperature_unit text not null default 'F';

alter table public.profiles
  add column if not exists first_day_of_week text not null default 'Sunday';

alter table public.profiles
  add column if not exists date_format text not null default 'MM/DD/YYYY';

-- Enforce enum-like text values (idempotent constraint refresh)
alter table public.profiles drop constraint if exists profiles_user_tier_check;
alter table public.profiles
  add constraint profiles_user_tier_check
  check (user_tier in ('free', 'premium'));

alter table public.profiles drop constraint if exists profiles_temperature_unit_check;
alter table public.profiles
  add constraint profiles_temperature_unit_check
  check (temperature_unit in ('F', 'C'));

alter table public.profiles drop constraint if exists profiles_first_day_of_week_check;
alter table public.profiles
  add constraint profiles_first_day_of_week_check
  check (first_day_of_week in ('Sunday', 'Monday'));

alter table public.profiles drop constraint if exists profiles_date_format_check;
alter table public.profiles
  add constraint profiles_date_format_check
  check (date_format in ('MM/DD/YYYY', 'DD/MM/YYYY'));

comment on column public.profiles.user_tier is 'Subscription tier: free or premium.';
comment on column public.profiles.allow_partner_manual_entry is 'When true, partner may add manual cycle logs on behalf of the user.';
comment on column public.profiles.temperature_unit is 'Display and entry preference: F or C.';
comment on column public.profiles.first_day_of_week is 'Calendar week start: Sunday or Monday.';
comment on column public.profiles.date_format is 'Preferred date display pattern.';

-- ---------------------------------------------------------------------------
-- biometrics (wearable / nightly rows)
-- ---------------------------------------------------------------------------

create table if not exists public.biometrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  sleeping_temp double precision,
  rhr double precision,
  hrv double precision,
  respiratory_rate double precision,
  created_at timestamptz not null default now()
);

create index if not exists biometrics_user_id_created_at_idx
  on public.biometrics (user_id, created_at desc);

comment on table public.biometrics is 'Per-user biometric samples; created_at is UTC (timestamptz).';

-- ---------------------------------------------------------------------------
-- manual_logs (manual cycle / symptom entry)
-- ---------------------------------------------------------------------------

create table if not exists public.manual_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  manual_bbt numeric,
  bbt_time_taken time,
  exclude_temp boolean,
  bleeding text,
  intercourse text,
  cervical_fluid text,
  cervical_position text,
  cervical_firmness text,
  disturbances text[],
  symptoms text[],
  test_results text[],
  constraint manual_logs_bleeding_check
    check (bleeding is null or bleeding in ('Spotting', 'Light', 'Medium', 'Heavy')),
  constraint manual_logs_intercourse_check
    check (intercourse is null or intercourse in ('Protected', 'Unprotected', 'Insemination')),
  constraint manual_logs_cervical_fluid_check
    check (cervical_fluid is null or cervical_fluid in ('Dry', 'Sticky', 'Creamy', 'Eggwhite')),
  constraint manual_logs_cervical_position_check
    check (cervical_position is null or cervical_position in ('High', 'Medium', 'Low')),
  constraint manual_logs_cervical_firmness_check
    check (cervical_firmness is null or cervical_firmness in ('Soft', 'Firm'))
);

create index if not exists manual_logs_user_id_date_idx
  on public.manual_logs (user_id, date desc);

comment on table public.manual_logs is 'Manual BBT/symptom logs; disturbances/symptoms/test_results are text[] (UTC via related timestamptz only when added later).';
comment on column public.manual_logs.disturbances is 'text[] e.g. Fever, Alcohol, Poor Sleep, Travel.';
comment on column public.manual_logs.symptoms is 'Free-form symptom labels as text[].';
comment on column public.manual_logs.test_results is 'Free-form test result labels as text[].';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.biometrics enable row level security;
alter table public.manual_logs enable row level security;

drop policy if exists "biometrics_select_own" on public.biometrics;
create policy "biometrics_select_own"
  on public.biometrics for select
  using (auth.uid() = user_id);

drop policy if exists "biometrics_insert_own" on public.biometrics;
create policy "biometrics_insert_own"
  on public.biometrics for insert
  with check (auth.uid() = user_id);

drop policy if exists "biometrics_update_own" on public.biometrics;
create policy "biometrics_update_own"
  on public.biometrics for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "biometrics_delete_own" on public.biometrics;
create policy "biometrics_delete_own"
  on public.biometrics for delete
  using (auth.uid() = user_id);

drop policy if exists "manual_logs_select_own" on public.manual_logs;
create policy "manual_logs_select_own"
  on public.manual_logs for select
  using (auth.uid() = user_id);

drop policy if exists "manual_logs_insert_own" on public.manual_logs;
create policy "manual_logs_insert_own"
  on public.manual_logs for insert
  with check (auth.uid() = user_id);

drop policy if exists "manual_logs_update_own" on public.manual_logs;
create policy "manual_logs_update_own"
  on public.manual_logs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "manual_logs_delete_own" on public.manual_logs;
create policy "manual_logs_delete_own"
  on public.manual_logs for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Grants (authenticated app users)
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on public.biometrics to authenticated;
grant select, insert, update, delete on public.manual_logs to authenticated;
