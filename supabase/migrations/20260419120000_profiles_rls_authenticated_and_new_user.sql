-- Fix onboarding / Day-zero upsert: "new row violates row-level security policy for table profiles"
-- when INSERT policy was missing, not applied, or not limited to role `authenticated`.
-- Also auto-create a profiles row on signup so upserts usually hit UPDATE only.

grant select, insert, update on table public.profiles to authenticated;

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own_has_new_biometrics" on public.profiles;
create policy "profiles_update_own_has_new_biometrics"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- Backfill: users in auth without a profiles row (migration-time; bypasses RLS).
-- ---------------------------------------------------------------------------

insert into public.profiles (id)
select u.id
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- New auth users: ensure a profiles row exists (defaults fill NOT NULL columns).
-- SECURITY DEFINER bypasses RLS for this insert.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user_profiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_sardine_profiles on auth.users;
create trigger on_auth_user_created_sardine_profiles
  after insert on auth.users
  for each row
  execute procedure public.handle_new_user_profiles();

comment on function public.handle_new_user_profiles() is
  'Creates public.profiles for new auth users so client upserts are updates when possible.';
