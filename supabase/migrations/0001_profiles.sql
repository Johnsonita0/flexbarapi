do $$
begin
  create type public.app_role as enum (
    'super_admin',
    'management_admin',
    'department_supervisor',
    'inventory_officer',
    'cash_sales_officer',
    'staff'
  );
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role public.app_role not null default 'staff',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists departments_name_unique
  on public.departments (lower(name));

insert into public.departments (name)
values
  ('Management'),
  ('Bar'),
  ('Kitchen'),
  ('Restaurant Floor'),
  ('Cashier'),
  ('Inventory & Store'),
  ('Cleaning & Maintenance')
on conflict do nothing;

alter table public.profiles
  add column if not exists department_id uuid references public.departments (id) on delete set null,
  add column if not exists avatar_path text,
  add column if not exists is_archived boolean not null default false,
  add column if not exists lock_pin_hash text,
  add column if not exists lock_pin_failed_attempts integer not null default 0,
  add column if not exists lock_pin_locked_until timestamptz;

create table if not exists public.business_settings (
  id smallint primary key default 1 check (id = 1),
  latitude double precision,
  longitude double precision,
  geofence_radius_m integer not null default 100 check (geofence_radius_m between 25 and 2000),
  timezone text not null default 'Africa/Lagos',
  currency text not null default 'NGN' check (currency in ('NGN', 'USD', 'GBP', 'EUR')),
  opening_time time not null default '08:00',
  closing_time time not null default '23:00',
  notify_task_assignments boolean not null default true,
  notify_low_stock boolean not null default true,
  notify_sales_updates boolean not null default true,
  notify_new_messages boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.business_settings
  add column if not exists currency text not null default 'NGN',
  add column if not exists opening_time time not null default '08:00',
  add column if not exists closing_time time not null default '23:00',
  add column if not exists notify_task_assignments boolean not null default true,
  add column if not exists notify_low_stock boolean not null default true,
  add column if not exists notify_sales_updates boolean not null default true,
  add column if not exists notify_new_messages boolean not null default true;

insert into public.business_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  work_date date not null,
  check_in_at timestamptz not null default now(),
  check_out_at timestamptz,
  check_in_latitude double precision not null,
  check_in_longitude double precision not null,
  check_out_latitude double precision,
  check_out_longitude double precision,
  created_at timestamptz not null default now(),
  unique (user_id, work_date)
);

alter table public.attendance_records
  add column if not exists staff_name_snapshot text,
  add column if not exists staff_email_snapshot text;

alter table public.attendance_records
  drop constraint if exists attendance_records_user_id_fkey;

alter table public.attendance_records
  alter column user_id drop not null,
  add constraint attendance_records_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete set null;

update public.attendance_records as attendance
set staff_name_snapshot = coalesce(profiles.display_name, auth_users.email, 'Former staff member'),
    staff_email_snapshot = auth_users.email
from public.profiles as profiles
left join auth.users as auth_users on auth_users.id = profiles.id
where attendance.user_id = profiles.id
  and attendance.staff_name_snapshot is null;

create table if not exists public.admin_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  actor_name text not null,
  actor_email text,
  action text not null,
  target_type text not null,
  target_id text,
  target_label text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_activity_logs_created_at_idx
  on public.admin_activity_logs (created_at desc);

create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_staff_lock_pin(p_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN must contain exactly four digits';
  end if;

  select * into profile_row
  from public.profiles
  where id = p_user_id
  for update;

  if not found or profile_row.role = 'super_admin'::public.app_role then
    raise exception 'Staff account not found';
  end if;

  update public.profiles
  set lock_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')),
      lock_pin_failed_attempts = 0,
      lock_pin_locked_until = null,
      updated_at = now()
  where id = p_user_id;
end;
$$;

create or replace function public.verify_staff_lock_pin(p_user_id uuid, p_pin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  failed_attempts integer;
begin
  if p_pin !~ '^[0-9]{4}$' then
    return 'invalid';
  end if;

  select * into profile_row
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    return 'missing';
  end if;
  if profile_row.lock_pin_hash is null then
    return 'unconfigured';
  end if;
  if profile_row.lock_pin_locked_until is not null and profile_row.lock_pin_locked_until > now() then
    return 'locked';
  end if;
  if extensions.crypt(p_pin, profile_row.lock_pin_hash) = profile_row.lock_pin_hash then
    update public.profiles
    set lock_pin_failed_attempts = 0,
        lock_pin_locked_until = null
    where id = p_user_id;
    return 'verified';
  end if;

  failed_attempts := profile_row.lock_pin_failed_attempts + 1;
  update public.profiles
  set lock_pin_failed_attempts = failed_attempts,
      lock_pin_locked_until = case
        when failed_attempts >= 5 then now() + interval '15 minutes'
        else null
      end
  where id = p_user_id;

  if failed_attempts >= 5 then
    return 'locked';
  end if;
  return 'invalid';
end;
$$;

revoke all on function public.set_staff_lock_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.verify_staff_lock_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.set_staff_lock_pin(uuid, text) to service_role;
grant execute on function public.verify_staff_lock_pin(uuid, text) to service_role;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_active'
      and column_default in ('true', 'true::boolean')
  ) then
    update public.profiles
    set is_active = false,
        updated_at = now()
    where id <> '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid;
  end if;
end;
$$;

alter table public.profiles
  alter column is_active set default false;

alter table public.profiles enable row level security;
alter table public.departments enable row level security;
alter table public.business_settings enable row level security;
alter table public.attendance_records enable row level security;
alter table public.admin_activity_logs enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on public.departments from anon, authenticated;
grant select on public.departments to authenticated;
revoke all on public.business_settings, public.attendance_records from anon, authenticated;
revoke all on public.admin_activity_logs from anon, authenticated;

drop policy if exists "Authenticated users can read departments" on public.departments;
create policy "Authenticated users can read departments"
  on public.departments
  for select
  to authenticated
  using (true);

drop policy if exists "Users can read their own profile" on public.profiles;

create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 8388608, array['image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own profile photo" on storage.objects;
create policy "Users can upload their own profile photo"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own profile photo" on storage.objects;
create policy "Users can update their own profile photo"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own profile photo" on storage.objects;
create policy "Users can delete their own profile photo"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, role, is_active)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), ''),
    case
      when new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid then 'super_admin'::public.app_role
      else 'staff'::public.app_role
    end,
    new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

insert into public.profiles (id, display_name, role, is_active)
select
  id,
  nullif(trim(coalesce(raw_user_meta_data ->> 'display_name', '')), ''),
  case
    when id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid then 'super_admin'::public.app_role
    else 'staff'::public.app_role
  end,
  id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid
from auth.users
on conflict (id) do update
set role = 'super_admin',
    is_active = true,
    updated_at = now()
where excluded.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid;
