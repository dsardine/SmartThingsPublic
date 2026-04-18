-- Ensure profiles exists (standard Supabase pattern); then add the biometrics flag.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz default now()
);

alter table public.profiles
  add column if not exists has_new_biometrics boolean not null default false;

alter table public.profiles
  add column if not exists partner_id uuid references auth.users (id) on delete set null;

comment on column public.profiles.has_new_biometrics is
  'When true, the client may call generate-score once, then persist to cached_insight and clear this flag.';

-- Cached LLM outputs (one row per refresh; app reads latest).
create table if not exists public.cached_insight (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conception_score integer not null
    check (conception_score >= 0 and conception_score <= 100),
  is_estimate boolean not null default false,
  insight_text text not null,
  created_at timestamptz not null default now()
);

create index if not exists cached_insight_user_created_at_idx
  on public.cached_insight (user_id, created_at desc);

-- Partner reads must not rely on SELECT access to the primary's profiles row (RLS would hide it).
-- This helper runs with definer rights so the partnership check is authoritative.
create or replace function public.cached_insight_reader_matches_partner(primary_uid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = primary_uid
      and p.partner_id is not null
      and p.partner_id = auth.uid()
  );
$$;

revoke all on function public.cached_insight_reader_matches_partner(uuid) from public;
grant execute on function public.cached_insight_reader_matches_partner(uuid) to authenticated;

alter table public.cached_insight enable row level security;

drop policy if exists "cached_insight_select_own" on public.cached_insight;
drop policy if exists "cached_insight_select_own_or_partner" on public.cached_insight;
create policy "cached_insight_select_own_or_partner"
  on public.cached_insight for select
  using (
    auth.uid() = user_id
    or public.cached_insight_reader_matches_partner(user_id)
  );

drop policy if exists "cached_insight_insert_own" on public.cached_insight;
create policy "cached_insight_insert_own"
  on public.cached_insight for insert
  with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own_has_new_biometrics" on public.profiles;
create policy "profiles_update_own_has_new_biometrics"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
