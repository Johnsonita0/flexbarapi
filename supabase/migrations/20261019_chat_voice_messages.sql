begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-voice-messages',
  'chat-voice-messages',
  false,
  15728640,
  array['audio/webm', 'audio/ogg', 'audio/mp4']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_access_chat_voice_message(p_object_name text, p_upload boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  path_parts text[];
begin
  path_parts := storage.foldername(p_object_name);
  if coalesce(array_length(path_parts, 1), 0) <> 2
    or path_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or path_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return false;
  end if;

  if p_upload and path_parts[2] <> (select auth.uid())::text then
    return false;
  end if;

  return exists (
    select 1
    from public.chat_conversations conversation
    join public.chat_conversation_participants participant
      on participant.conversation_id = conversation.id
    join public.profiles profile
      on profile.id = participant.user_id
    where conversation.id = path_parts[1]::uuid
      and participant.user_id = (select auth.uid())
      and participant.company_id = conversation.company_id
      and profile.company_id = conversation.company_id
      and profile.is_active
      and not profile.is_archived
  );
end;
$$;

revoke all on function public.can_access_chat_voice_message(text, boolean) from public, anon;
grant execute on function public.can_access_chat_voice_message(text, boolean) to authenticated;

drop policy if exists chat_voice_messages_read on storage.objects;
create policy chat_voice_messages_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'chat-voice-messages'
    and public.can_access_chat_voice_message(name, false)
  );

drop policy if exists chat_voice_messages_upload on storage.objects;
create policy chat_voice_messages_upload
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'chat-voice-messages'
    and public.can_access_chat_voice_message(name, true)
  );

drop policy if exists chat_voice_messages_remove_own_uploads on storage.objects;
create policy chat_voice_messages_remove_own_uploads
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'chat-voice-messages'
    and public.can_access_chat_voice_message(name, true)
  );

commit;
