begin;

alter table public.account_device_sessions
  drop constraint if exists account_device_sessions_pkey;
alter table public.account_device_sessions
  add constraint account_device_sessions_pkey primary key (user_id, session_id);

create or replace function public.claim_account_device_session(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.account_device_sessions (user_id, session_id, last_seen_at)
  values (p_user_id, p_session_id, now())
  on conflict (user_id, session_id) do update
    set last_seen_at = now();
  return true;
end;
$$;

create or replace function public.touch_account_device_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  insert into public.account_device_sessions (user_id, session_id, last_seen_at)
  values (auth.uid(), p_session_id, now())
  on conflict (user_id, session_id) do update
    set last_seen_at = now();
  return true;
end;
$$;

commit;
