begin;

create table if not exists public.call_rooms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  media_mode text not null check (media_mode in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

alter table public.call_rooms add column if not exists company_id uuid;
update public.call_rooms room
set company_id = profile.company_id
from public.profiles profile
where profile.id = room.created_by
  and room.company_id is null;
alter table public.call_rooms alter column company_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'call_rooms_company_id_fkey'
      and conrelid = 'public.call_rooms'::regclass
  ) then
    alter table public.call_rooms
      add constraint call_rooms_company_id_fkey
      foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
end;
$$;

create table if not exists public.call_room_participants (
  room_id uuid not null references public.call_rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  status text not null default 'ringing' check (status in ('ringing', 'joined', 'left')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  left_at timestamptz,
  primary key (room_id, user_id)
);

alter table public.call_room_participants add column if not exists company_id uuid;
update public.call_room_participants participant
set company_id = room.company_id
from public.call_rooms room
where room.id = participant.room_id
  and participant.company_id is null;
alter table public.call_room_participants alter column company_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'call_room_participants_company_id_fkey'
      and conrelid = 'public.call_room_participants'::regclass
  ) then
    alter table public.call_room_participants
      add constraint call_room_participants_company_id_fkey
      foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
end;
$$;

create or replace function public.set_call_participant_company_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  room_company_id uuid;
begin
  select company_id into room_company_id
  from public.call_rooms
  where id = new.room_id;
  if room_company_id is null then
    raise exception 'Call room does not exist';
  end if;
  if new.company_id is not null and new.company_id <> room_company_id then
    raise exception 'Call participant workspace does not match the call room';
  end if;
  new.company_id := room_company_id;
  return new;
end;
$$;

drop trigger if exists call_room_participants_set_company on public.call_room_participants;
create trigger call_room_participants_set_company
  before insert or update of room_id, company_id
  on public.call_room_participants
  for each row execute function public.set_call_participant_company_id();
revoke all on function public.set_call_participant_company_id() from public, anon, authenticated;
grant execute on function public.set_call_participant_company_id() to service_role;

create index if not exists call_room_participants_user_status_idx
  on public.call_room_participants (user_id, status, invited_at desc);

alter table public.call_rooms enable row level security;
alter table public.call_room_participants enable row level security;
revoke all on public.call_rooms, public.call_room_participants from anon, authenticated;

create or replace function public.can_access_call_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  room_id uuid;
begin
  if p_topic !~ '^call:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  room_id := substring(p_topic from char_length('call:') + 1)::uuid;
  return exists (
    select 1
    from public.call_rooms room
    join public.call_room_participants participant on participant.room_id = room.id
    join public.profiles profile on profile.id = participant.user_id
    where room.id = room_id
      and room.status in ('ringing', 'active')
      and (room.status = 'active' or room.created_at > now() - interval '5 minutes')
      and participant.user_id = (select auth.uid())
      and participant.status in ('ringing', 'joined')
      and participant.company_id = room.company_id
      and profile.is_active
      and not profile.is_archived
      and profile.company_id = room.company_id
  );
end;
$$;

revoke all on function public.can_access_call_topic(text) from public, anon;
grant execute on function public.can_access_call_topic(text) to authenticated;

grant usage on schema realtime to authenticated;
grant select, insert on table realtime.messages to authenticated;

drop policy if exists in_app_call_signaling_read on realtime.messages;
create policy in_app_call_signaling_read
  on realtime.messages
  for select
  to authenticated
  using (public.can_access_call_topic(realtime.topic()));

drop policy if exists in_app_call_signaling_write on realtime.messages;
create policy in_app_call_signaling_write
  on realtime.messages
  for insert
  to authenticated
  with check (public.can_access_call_topic(realtime.topic()));

commit;
