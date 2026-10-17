alter table public.department_meetings
  add column if not exists is_instant boolean not null default false;
