alter table public.business_settings
  drop constraint if exists business_settings_geofence_radius_m_check;

update public.business_settings
set geofence_radius_m = 10
where geofence_radius_m <> 10;

alter table public.business_settings
  alter column geofence_radius_m set default 10,
  add constraint business_settings_geofence_radius_m_check
    check (geofence_radius_m = 10);

create table if not exists public.attendance_geofence_violations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  department_id uuid references public.departments (id) on delete set null,
  distance_meters double precision not null check (distance_meters >= 0),
  accuracy_meters double precision not null check (accuracy_meters >= 0),
  created_at timestamptz not null default now()
);

create index if not exists attendance_geofence_violations_company_created_idx
  on public.attendance_geofence_violations (company_id, created_at desc);

create index if not exists attendance_geofence_violations_user_created_idx
  on public.attendance_geofence_violations (user_id, created_at desc);

alter table public.attendance_geofence_violations enable row level security;
revoke all on public.attendance_geofence_violations from anon, authenticated;
    alter table public.business_settings
  drop constraint if exists business_settings_geofence_qr_radius_m_check;
