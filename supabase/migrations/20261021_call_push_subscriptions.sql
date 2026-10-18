begin;

create table if not exists public.call_push_subscriptions (
  user_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid not null,
  company_id uuid not null references public.companies (id) on delete cascade,
  endpoint text not null check (endpoint like 'https://%'),
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);

create index if not exists call_push_subscriptions_company_user_idx
  on public.call_push_subscriptions (company_id, user_id);

alter table public.call_push_subscriptions enable row level security;
revoke all on public.call_push_subscriptions from anon, authenticated;
grant all on public.call_push_subscriptions to service_role;

create or replace function public.is_active_account_device_session(p_user_id uuid, p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.account_device_sessions active_session
    where active_session.user_id = p_user_id
      and active_session.session_id = p_session_id
  );
$$;

revoke all on function public.is_active_account_device_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_active_account_device_session(uuid, uuid) to service_role;

commit;
