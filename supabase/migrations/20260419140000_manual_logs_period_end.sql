-- Hotfix: retro period logging — mark last day of flow; calendar fills visual bleed gap to last logged bleeding.

alter table public.manual_logs
  add column if not exists period_end boolean not null default false;

comment on column public.manual_logs.period_end is
  'When true, calendar treats bleeding as continuous from the latest prior bleeding day through this date.';
