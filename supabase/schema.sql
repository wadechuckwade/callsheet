-- Callsheet database schema (Supabase / Postgres)
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
--
-- Privacy model
--   • Everything is private to its owner by default.
--   • A project can be shared with specific people as 'viewer' or 'editor'.
--     They can then see the project and its tasks; editors can change them.
--   • Nobody else can read anything, unless the owner publishes a public
--     version of their profile or a project (stored separately, so private
--     notes never leak into the public copy).
-- These rules are enforced by Postgres row-level security, not by the app.


-- ---------- profiles ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  bio         text not null default '',
  location    text not null default '',
  disciplines text[] not null default '{}',
  links       jsonb not null default '[]',
  avatar      text not null default '',
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- records: every planner item, one row each ----------
-- col        : the kind of item ('projects', 'tasks', 'deadlines', 'songs', …)
-- id         : the item's id (unique within its kind)
-- owner      : who created it
-- project_id : set for items that belong to a project (e.g. tasks), so they are
--              shared along with that project
-- is_public  : only used for the public copies ('pubprojects')
create table if not exists public.records (
  col         text not null check (col ~ '^[a-z]{2,24}$'),
  id          text not null check (char_length(id) between 1 and 200),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id  text,
  data        jsonb not null default '{}',
  is_public   boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists records_owner_idx on public.records(owner);
create index if not exists records_project_idx on public.records(project_id) where project_id is not null;

-- ---------- shares: who a project is shared with ----------
create table if not exists public.shares (
  project_id  text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('viewer','editor')),
  added_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists shares_user_idx on public.shares(user_id);

-- ---------- invites for people who haven't signed up yet ----------
create table if not exists public.invites (
  project_id  text not null,
  email       text not null,
  role        text not null check (role in ('viewer','editor')),
  invited_by  uuid default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (project_id, email)
);

-- ---------- helper functions (security definer so policies don't recurse) ----------
create or replace function public.project_owner(pid text) returns uuid
language sql stable security definer set search_path = public as $$
  select owner from public.records where col = 'projects' and id = pid
$$;

create or replace function public.project_role(pid text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when pid is null then null
    when (select owner from public.records where col = 'projects' and id = pid) = auth.uid() then 'owner'
    else (select role from public.shares where project_id = pid and user_id = auth.uid())
  end
$$;

create or replace function public.can_read_project(pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.project_role(pid) is not null
$$;

create or replace function public.can_edit_project(pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.project_role(pid) in ('owner','editor'), false)
$$;

create or replace function public.shares_a_project_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.shares s
    where (s.user_id = auth.uid() and (public.project_owner(s.project_id) = other
           or exists (select 1 from public.shares s2 where s2.project_id = s.project_id and s2.user_id = other)))
       or (s.user_id = other and public.project_owner(s.project_id) = auth.uid())
  )
$$;

-- ---------- row-level security ----------
alter table public.profiles enable row level security;
alter table public.records  enable row level security;
alter table public.shares   enable row level security;
alter table public.invites  enable row level security;

-- profiles: you see your own, public ones, and people you share a project with
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or is_public or public.shares_a_project_with(id));
drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- records
drop policy if exists records_read on public.records;
create policy records_read on public.records for select using (
  owner = auth.uid()
  or (is_public and col = 'pubprojects')
  or (col = 'projects' and public.can_read_project(id))
  or (project_id is not null and public.can_read_project(project_id))
);
drop policy if exists records_insert on public.records;
create policy records_insert on public.records for insert with check (
  owner = auth.uid()
  and (project_id is null or public.can_edit_project(project_id))
  and (not is_public or col = 'pubprojects')
);
drop policy if exists records_update on public.records;
create policy records_update on public.records for update using (
  owner = auth.uid()
  or (col = 'projects' and public.can_edit_project(id))
  or (project_id is not null and public.can_edit_project(project_id))
) with check (
  (not is_public or col = 'pubprojects')
  and (project_id is null or public.can_edit_project(project_id) or owner = auth.uid())
);
drop policy if exists records_delete on public.records;
create policy records_delete on public.records for delete using (
  owner = auth.uid()
  or (col <> 'projects' and project_id is not null and public.can_edit_project(project_id))
);

-- an item's owner can never be changed by someone else's edit
create or replace function public.keep_owner() returns trigger
language plpgsql as $$
begin
  new.owner := old.owner;
  if old.col = 'projects' then new.project_id := old.project_id; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists records_keep_owner on public.records;
create trigger records_keep_owner before update on public.records
  for each row execute function public.keep_owner();

-- shares: visible to the project's owner and its members; managed by owner and editors
drop policy if exists shares_read on public.shares;
create policy shares_read on public.shares for select using (
  user_id = auth.uid() or public.can_read_project(project_id)
);
drop policy if exists shares_write on public.shares;
create policy shares_write on public.shares for insert with check (
  public.can_edit_project(project_id) and user_id <> public.project_owner(project_id)
);
drop policy if exists shares_update on public.shares;
create policy shares_update on public.shares for update using (public.can_edit_project(project_id));
drop policy if exists shares_delete on public.shares;
create policy shares_delete on public.shares for delete using (
  public.can_edit_project(project_id) or user_id = auth.uid()   -- anyone can leave a project
);

-- invites: only visible to the project's owner and editors
drop policy if exists invites_all on public.invites;
create policy invites_all on public.invites for all
  using (public.can_edit_project(project_id)) with check (public.can_edit_project(project_id));

-- ---------- sharing by email ----------
-- Shares a project with an email address. If that person already has an
-- account they get access straight away; otherwise access is waiting for them
-- when they sign up with that email.
create or replace function public.share_project(pid text, invitee_email text, share_role text)
returns text language plpgsql security definer set search_path = public, auth as $$
declare uid uuid; clean text := lower(trim(invitee_email));
begin
  if not coalesce(public.can_edit_project(pid), false) then raise exception 'not allowed'; end if;
  if share_role not in ('viewer','editor') then raise exception 'bad role'; end if;
  select id into uid from auth.users where lower(email) = clean limit 1;
  if uid is not null then
    if uid = public.project_owner(pid) then return 'owner'; end if;
    insert into public.shares(project_id, user_id, role, added_by) values (pid, uid, share_role, auth.uid())
      on conflict (project_id, user_id) do update set role = excluded.role;
    return 'shared';
  end if;
  insert into public.invites(project_id, email, role, invited_by) values (pid, clean, share_role, auth.uid())
    on conflict (project_id, email) do update set role = excluded.role;
  return 'invited';
end $$;

-- When someone signs up, turn any invites for their email into shares and create their profile.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  insert into public.profiles(id, name) values (new.id, coalesce(new.raw_user_meta_data->>'name', ''))
    on conflict (id) do nothing;
  insert into public.shares(project_id, user_id, role, added_by)
    select project_id, new.id, role, invited_by from public.invites where email = lower(new.email)
    on conflict do nothing;
  delete from public.invites where email = lower(new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Members of a project with their names (and emails for pending invites), for the Share box.
create or replace function public.project_members(pid text)
returns table(user_id uuid, name text, email text, role text, pending boolean)
language sql stable security definer set search_path = public, auth as $$
  select u.id, coalesce(p.name, ''), case when public.can_edit_project(pid) then u.email else null end, 'owner', false
    from auth.users u left join public.profiles p on p.id = u.id
    where public.can_read_project(pid) and u.id = public.project_owner(pid)
  union all
  select s.user_id, coalesce(p.name, ''), case when public.can_edit_project(pid) then u.email else null end, s.role, false
    from public.shares s join auth.users u on u.id = s.user_id left join public.profiles p on p.id = s.user_id
    where s.project_id = pid and public.can_read_project(pid)
  union all
  select null, '', i.email, i.role, true from public.invites i
    where i.project_id = pid and public.can_edit_project(pid)
$$;

-- ---------- grants ----------
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.records to anon;
grant select, insert, update, delete on public.profiles, public.records, public.shares, public.invites to authenticated;
grant execute on function public.share_project(text, text, text) to authenticated;
grant execute on function public.project_members(text) to authenticated;

-- ---------- realtime ----------
do $$ begin
  begin alter publication supabase_realtime add table public.records; exception when others then null; end;
  begin alter publication supabase_realtime add table public.shares; exception when others then null; end;
end $$;

-- ---------- file storage ----------
-- One bucket for covers, documents, recordings and fonts. Files live under
-- <user id>/<random name>; only the owner can upload or delete their files.
-- Files are served by unguessable links so shared projects can show them.
insert into storage.buckets (id, name, public) values ('files', 'files', true) on conflict (id) do nothing;
drop policy if exists files_insert on storage.objects;
create policy files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists files_delete on storage.objects;
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
