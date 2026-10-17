begin;

create table if not exists public.account_device_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  session_id uuid not null,
  last_seen_at timestamptz not null default now()
);

alter table public.account_device_sessions enable row level security;
revoke all on public.account_device_sessions from anon, authenticated;
grant all on public.account_device_sessions to service_role;

create or replace function public.claim_account_device_session(p_user_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  insert into public.account_device_sessions as active_session (user_id, session_id, last_seen_at)
  values (p_user_id, p_session_id, now())
  on conflict (user_id) do update
    set session_id = excluded.session_id,
        last_seen_at = now()
    where active_session.session_id = excluded.session_id
       or active_session.last_seen_at < now() - interval '15 minutes';
  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
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
  update public.account_device_sessions
    set last_seen_at = now()
    where user_id = auth.uid()
      and session_id = p_session_id;
  return found;
end;
$$;

revoke all on function public.claim_account_device_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_account_device_session(uuid, uuid) to service_role;
revoke all on function public.touch_account_device_session(uuid) from public, anon;
grant execute on function public.touch_account_device_session(uuid) to authenticated;

commit;
