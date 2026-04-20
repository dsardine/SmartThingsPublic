-- Repair: stub or legacy `public.biometrics` tables may omit vitals columns.
-- PostgREST errors like "could not find the 'respiratory_rate' column ... in the schema cache"
-- mean the column is absent in Postgres — not that Health Connect returned no RR samples.

alter table public.biometrics add column if not exists sleeping_temp double precision;
alter table public.biometrics add column if not exists rhr double precision;
alter table public.biometrics add column if not exists hrv double precision;
alter table public.biometrics add column if not exists respiratory_rate double precision;

-- Some hand-created tables skipped `created_at`; merge logic orders by it.
alter table public.biometrics add column if not exists created_at timestamptz not null default now();

comment on column public.biometrics.sleeping_temp is 'Nocturnal / sleep-window skin or blended temp (°C) for charts.';
comment on column public.biometrics.rhr is 'Resting heart rate (bpm), sleep-window minimum when available.';
comment on column public.biometrics.hrv is 'HRV RMSSD (ms) in sleep window when available.';
comment on column public.biometrics.respiratory_rate is 'Respiratory rate (breaths/min) in sleep window when available.';
