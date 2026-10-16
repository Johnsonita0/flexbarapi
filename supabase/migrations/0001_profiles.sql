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

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

drop policy if exists "Users can read their own profile" on public.profiles;

create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

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
