-- ESO Save: template approval (the Management tab). A shared template is seen by others only
-- once approved; the owner always sees their own. Templates by the agency owner, or by a manager
-- holding the approve permission, are approved as they are saved. Applied through the
-- Management API from the repo (see CLAUDE.md); kept here as the record of the schema.
alter table public.esosave_templates add column if not exists approved boolean not null default false;
alter table public.esosave_templates add column if not exists approved_by text;
alter table public.esosave_templates add column if not exists approved_at timestamptz;
-- what already exists: the agency owner's templates stand approved, everyone else's wait
update public.esosave_templates set approved = true, approved_by = 'GASTON, MICHAEL', approved_at = now()
  where owner_id = 'd4e45fac-ee36-4ac8-bf9a-3fb3e265c0d0' and approved = false;
