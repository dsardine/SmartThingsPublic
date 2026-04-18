-- Required for postgres_changes / WebSocket listeners on this table.
alter publication supabase_realtime add table public.cached_insight;
