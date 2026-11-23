-- SiteClone database schema (Supabase / Postgres).
-- Safe to run more than once. The backend uses the service-role key (bypasses RLS);
-- RLS stays ON so the public anon key can only read a user's own rows and never write.

-- ---------------------------------------------------------------- profiles (1 row per auth user)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null default '',
  role text not null default 'user' check (role in ('user', 'admin')),
  monthly_limit integer default 10 check (monthly_limit is null or monthly_limit >= 0), -- null = unlimited
  usage_period_start timestamptz not null default now(),
  usage_used integer not null default 0,
  disabled boolean not null default false,
  plan_name text not null default 'Free',
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_email_key on public.profiles (lower(email));

-- ---------------------------------------------------------------- downloads
create table if not exists public.downloads (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  url text not null,
  domain text not null,
  mode text not null check (mode in ('single_page', 'full_website', 'cookie_export')),
  max_pages integer not null default 1,
  status text not null default 'queued' check (status in ('queued', 'running', 'processing', 'completed', 'failed')),
  pages integer,
  pages_found integer,
  assets integer,
  zip_size_bytes bigint,
  zip_storage_path text,           -- copy of the ZIP in Supabase Storage (survives server restarts)
  error_code text,
  error_message text,
  login_method text,
  authorized_confirmed_at timestamptz,
  authorized_ip text,
  stop_requested_at timestamptz,
  stopped_early boolean not null default false,
  counted boolean not null default true,
  queue_position integer,
  progress jsonb,
  options jsonb not null default '{}'::jsonb,
  library_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists downloads_user_created_idx on public.downloads (user_id, created_at desc);
create index if not exists downloads_status_idx on public.downloads (status);

-- ---------------------------------------------------------------- website library
create table if not exists public.library_items (
  id uuid primary key,
  title text not null,
  url text not null,
  domain text not null,
  pages integer,
  zip_size_bytes bigint,
  source_download_id uuid references public.downloads (id) on delete set null,
  storage_path text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- admin audit log
create table if not exists public.admin_events (
  id bigint generated always as identity primary key,
  admin_id uuid references public.profiles (id) on delete set null,
  target_user_id uuid references public.profiles (id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_events_created_idx on public.admin_events (created_at desc);

-- ---------------------------------------------------------------- updated_at trigger
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists downloads_touch on public.downloads;
create trigger downloads_touch before update on public.downloads for each row execute function public.touch_updated_at();
drop trigger if exists library_touch on public.library_items;
create trigger library_touch before update on public.library_items for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- new auth user -> profile row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and not p.disabled);
$$;

-- ---------------------------------------------------------------- row level security
alter table public.profiles enable row level security;
alter table public.downloads enable row level security;
alter table public.library_items enable row level security;
alter table public.admin_events enable row level security;

drop policy if exists "own profile readable" on public.profiles;
create policy "own profile readable" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "own downloads readable" on public.downloads;
create policy "own downloads readable" on public.downloads for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "library readable" on public.library_items;
create policy "library readable" on public.library_items for select to authenticated using (true);

drop policy if exists "admin events readable" on public.admin_events;
create policy "admin events readable" on public.admin_events for select to authenticated using ((select public.is_admin()));
-- No insert/update/delete policies: every write goes through the backend (service role).

-- ---------------------------------------------------------------- storage buckets (private, 50 MB per file)
insert into storage.buckets (id, name, public, file_size_limit)
values ('zips', 'zips', false, 52428800)   -- user ZIPs at <user_id>/<download_id>.zip, library copies at library/<id>.zip
on conflict (id) do nothing;

-- ---------------------------------------------------------------- grants
-- (new Supabase projects don't expose public tables automatically)
grant usage on schema public to service_role, authenticated;
grant select, insert, update, delete on public.profiles, public.downloads, public.library_items, public.admin_events to service_role;
grant usage, select on all sequences in schema public to service_role;
grant select on public.profiles, public.downloads, public.library_items, public.admin_events to authenticated;

-- ---------------------------------------------------------------- sign a user out everywhere (backend only)
create or replace function public.revoke_user_sessions(uid uuid) returns void
language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id = uid;
$$;
revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;

-- ---------------------------------------------------------------- per-user download limits (null = site default)
alter table public.profiles add column if not exists max_pages_limit integer check (max_pages_limit is null or max_pages_limit >= 1);
alter table public.profiles add column if not exists allowed_modes text[];          -- null = every mode
alter table public.profiles add column if not exists max_active_jobs integer check (max_active_jobs is null or max_active_jobs >= 1);
alter table public.profiles add column if not exists notes text;

-- ---------------------------------------------------------------- site-wide settings (admin panel)
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
grant select, insert, update, delete on public.app_settings to service_role;
insert into public.app_settings (key, value) values
  ('default_monthly_limit', '10'::jsonb),
  ('registration_open', 'true'::jsonb)
on conflict (key) do nothing;
