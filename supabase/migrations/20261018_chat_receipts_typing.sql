begin;

alter table public.chat_messages
  add column if not exists delivered_at timestamptz;

alter table public.notifications
  alter column sale_id drop not null;

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (char_length(trim(type)) between 1 and 80);

create or replace function public.can_access_chat_typing_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_conversation_id uuid;
begin
  if p_topic !~ '^chat-typing:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  target_conversation_id := substring(p_topic from char_length('chat-typing:') + 1)::uuid;
  return exists (
    select 1
    from public.chat_conversations conversation
    join public.chat_conversation_participants participant
      on participant.conversation_id = conversation.id
    join public.profiles profile
      on profile.id = participant.user_id
    where conversation.id = target_conversation_id
      and participant.user_id = (select auth.uid())
      and participant.company_id = conversation.company_id
      and profile.company_id = conversation.company_id
      and profile.is_active
      and not profile.is_archived
  );
end;
$$;

revoke all on function public.can_access_chat_typing_topic(text) from public, anon;
grant execute on function public.can_access_chat_typing_topic(text) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'chat_typing_presence_read'
  ) then
    execute $policy$
      create policy chat_typing_presence_read
        on realtime.messages
        for select
        to authenticated
        using (public.can_access_chat_typing_topic(realtime.topic()))
    $policy$;
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'chat_typing_presence_write'
  ) then
    execute $policy$
      create policy chat_typing_presence_write
        on realtime.messages
        for insert
        to authenticated
        with check (public.can_access_chat_typing_topic(realtime.topic()))
    $policy$;
  end if;
end;
$$;

commit;
