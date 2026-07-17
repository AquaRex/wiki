-- Wiki schema. Run once in the Supabase SQL editor.
--
-- Privacy model: is_private is stored per row and enforced by RLS, so a private
-- row is never sent to an anonymous client. Folder locks are resolved at write
-- time (locking a folder stamps its descendants) rather than by walking the path
-- hierarchy in a policy — every row therefore carries its own truth.
--
-- Signup is disabled in Auth settings, so `authenticated` means "trusted".

create table if not exists projects (
  slug        text primary key,
  title       text not null default '',
  lede        text not null default '',
  is_private  boolean not null default false,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists folders (
  id           uuid primary key default gen_random_uuid(),
  project_slug text not null references projects(slug) on delete cascade,
  rel          text not null,
  is_private   boolean not null default false,
  sort_order   int not null default 0,
  unique (project_slug, rel)
);

create table if not exists pages (
  id           uuid primary key default gen_random_uuid(),
  project_slug text not null references projects(slug) on delete cascade,
  rel          text not null,
  title        text not null default '',
  header       text not null default '',
  eyebrow      text not null default '',
  lede         text not null default '',
  tags         text[] not null default '{}',
  blocks       jsonb not null default '[]',
  is_private   boolean not null default false,
  sort_order   int not null default 0,
  updated_at   timestamptz not null default now(),
  unique (project_slug, rel)
);

-- Added after initial launch; `if not exists` keeps re-runs safe on a live table.
alter table pages add column if not exists header text not null default '';

create index if not exists pages_project_idx on pages (project_slug);
create index if not exists folders_project_idx on folders (project_slug);

alter table projects enable row level security;
alter table folders  enable row level security;
alter table pages    enable row level security;

-- Reads: public rows to anyone, private rows only to a signed-in user.
-- Anonymous clients do not receive private rows at all — not even their titles.
create policy projects_read on projects for select
  using (not is_private or auth.role() = 'authenticated');
create policy folders_read on folders for select
  using (not is_private or auth.role() = 'authenticated');
create policy pages_read on pages for select
  using (not is_private or auth.role() = 'authenticated');

-- Writes: signed-in users only.
create policy projects_write on projects for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy folders_write on folders for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy pages_write on pages for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Image storage is split in two because one bucket cannot serve both cases:
-- a private bucket needs a signed URL, and an anonymous visitor can neither
-- read it nor sign one — so images on public pages would break for them.
--
-- wiki-public  — plain, permanent, cacheable URLs. Readable by anyone.
-- wiki-private — signed URLs only, 1h expiry. Readable only when signed in.
--
-- Uploads pick the bucket from the page's is_private, and locking or unlocking
-- a page moves its objects between buckets so storage always matches the lock.
insert into storage.buckets (id, name, public)
values ('wiki-public', 'wiki-public', true), ('wiki-private', 'wiki-private', false)
on conflict (id) do nothing;

create policy wiki_public_read on storage.objects for select
  using (bucket_id = 'wiki-public');
create policy wiki_public_write on storage.objects for all
  using (bucket_id = 'wiki-public' and auth.role() = 'authenticated')
  with check (bucket_id = 'wiki-public' and auth.role() = 'authenticated');

create policy wiki_private_read on storage.objects for select
  using (bucket_id = 'wiki-private' and auth.role() = 'authenticated');
create policy wiki_private_write on storage.objects for all
  using (bucket_id = 'wiki-private' and auth.role() = 'authenticated')
  with check (bucket_id = 'wiki-private' and auth.role() = 'authenticated');
