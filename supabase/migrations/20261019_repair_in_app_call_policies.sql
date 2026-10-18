begin;

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
