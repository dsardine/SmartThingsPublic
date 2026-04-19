-- BBT time display preference (calendar + manual log UI); stored as 24h in manual_logs, display toggles in app.
alter table public.profiles
  add column if not exists bbt_time_format text not null default '12h';

alter table public.profiles drop constraint if exists profiles_bbt_time_format_check;

alter table public.profiles
  add constraint profiles_bbt_time_format_check
  check (bbt_time_format in ('12h', '24h'));

comment on column public.profiles.bbt_time_format is 'How BBT "time taken" is shown in the app: 12h or 24h; values still stored as HH:MM 24h.';
