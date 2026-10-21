begin;

create table if not exists public.api_idempotency_keys (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null check (char_length(request_hash) = 64),
  response_status integer check (response_status between 100 and 599),
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (company_id, user_id, idempotency_key)
);

create index if not exists api_idempotency_keys_created_idx
  on public.api_idempotency_keys (created_at);

alter table public.api_idempotency_keys enable row level security;
revoke all on public.api_idempotency_keys from anon, authenticated;

commit;
