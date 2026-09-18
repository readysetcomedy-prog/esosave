-- ESO Save: one row per ESO login. Holds only the open settings (quick buttons, facility chips)
-- and the ids of the runs that login worked. Never a run's contents. Run once in the Supabase
-- SQL editor of the project the extension points at (Rmedems).
create table if not exists public.esosave_users (
  name text primary key,
  settings jsonb not null default '{}'::jsonb,
  runs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.esosave_users enable row level security;
drop policy if exists esosave_users_read on public.esosave_users;
drop policy if exists esosave_users_insert on public.esosave_users;
drop policy if exists esosave_users_update on public.esosave_users;
-- the extension carries the project's public (anon) key and may only read and write this table
create policy esosave_users_read on public.esosave_users for select to anon using (true);
create policy esosave_users_insert on public.esosave_users for insert to anon with check (true);
create policy esosave_users_update on public.esosave_users for update to anon using (true) with check (true);
grant select, insert, update on public.esosave_users to anon;
