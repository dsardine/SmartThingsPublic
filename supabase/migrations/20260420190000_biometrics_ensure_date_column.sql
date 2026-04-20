-- Repair: some projects had `public.biometrics` created before sprint2 or via an empty stub.
-- `create table if not exists` in 20260418120000 does not add columns to an existing table, so
-- PostgREST then errors with "column biometrics.date does not exist" on import / graphs / score.

alter table public.biometrics
  add column if not exists date date;

comment on column public.biometrics.date is
  'Calendar day (YYYY-MM-DD) for nightly vitals; same semantics as manual_logs.date.';

update public.biometrics
set date = (created_at at time zone 'utc')::date
where date is null and created_at is not null;

do $$
begin
  if not exists (select 1 from public.biometrics where date is null) then
    alter table public.biometrics alter column date set not null;
  end if;
end;
$$;

create index if not exists biometrics_user_id_date_idx
  on public.biometrics (user_id, date desc);
