begin;

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
