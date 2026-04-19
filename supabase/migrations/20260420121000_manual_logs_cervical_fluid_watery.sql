-- Allow "Watery" cervical fluid (premium / AI context); keep Eggwhite as stored enum value.

alter table public.manual_logs drop constraint if exists manual_logs_cervical_fluid_check;
alter table public.manual_logs
  add constraint manual_logs_cervical_fluid_check
  check (cervical_fluid is null or cervical_fluid in ('Dry', 'Sticky', 'Creamy', 'Eggwhite', 'Watery'));
