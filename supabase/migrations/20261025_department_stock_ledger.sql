begin;

alter table public.products
  add column if not exists central_stock_quantity integer not null default 0
  check (central_stock_quantity >= 0);

alter table public.stock_deliveries
  add column if not exists received_quantity integer not null default 0
  check (received_quantity >= 0 and received_quantity <= quantity);

alter table public.stock_deliveries
  add column if not exists central_reserved boolean not null default false;

update public.stock_deliveries
set received_quantity = quantity
where received_at is not null and received_quantity = 0;

create table if not exists public.central_stock_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  received_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'central_stock_receipts_company_id_fkey'
      and conrelid = 'public.central_stock_receipts'::regclass
  ) then
    alter table public.central_stock_receipts
      add constraint central_stock_receipts_company_id_fkey
      foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
end;
$$;

create index if not exists central_stock_receipts_product_created_idx
  on public.central_stock_receipts (product_id, created_at desc);

alter table public.central_stock_receipts enable row level security;
revoke all on public.central_stock_receipts from anon, authenticated;

create or replace function public.add_central_stock(
  p_product_id uuid,
  p_quantity integer,
  p_receiver_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  updated_quantity integer;
begin
  if p_quantity < 1 then
    raise exception 'Stock quantity must be greater than zero';
  end if;
  select * into product_row
  from public.products
  where id = p_product_id
  for update;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_receiver_id and is_active and not is_archived
      and company_id = product_row.company_id
      and role in ('super_admin', 'management_admin', 'inventory_officer')
  ) then
    raise exception 'You do not have permission to add central stock';
  end if;

  update public.products
  set central_stock_quantity = central_stock_quantity + p_quantity,
      updated_at = now()
  where id = p_product_id
  returning central_stock_quantity into updated_quantity;

  insert into public.central_stock_receipts (company_id, product_id, quantity, received_by)
  values (product_row.company_id, p_product_id, p_quantity, p_receiver_id);

  return updated_quantity;
end;
$$;

revoke all on function public.add_central_stock(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.add_central_stock(uuid, integer, uuid) to service_role;

create or replace function public.dispatch_department_stock(
  p_product_id uuid,
  p_quantity integer,
  p_sender_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  department_head_id uuid;
  delivery_id uuid;
begin
  if p_quantity < 1 then
    raise exception 'Stock quantity must be greater than zero';
  end if;
  select * into product_row
  from public.products
  where id = p_product_id
  for update;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_sender_id and is_active and not is_archived
      and company_id = product_row.company_id
      and role in ('super_admin', 'management_admin', 'inventory_officer')
  ) then
    raise exception 'You do not have permission to dispatch stock';
  end if;
  if product_row.department_id is null then
    raise exception 'Assign the product to a department before dispatching stock';
  end if;
  if product_row.central_stock_quantity < p_quantity then
    raise exception 'There is not enough stock in central inventory';
  end if;

  select head_user_id into department_head_id
  from public.departments
  where id = product_row.department_id
    and company_id = product_row.company_id;
  if department_head_id is null or not exists (
    select 1 from public.profiles
    where id = department_head_id
      and department_id = product_row.department_id
      and company_id = product_row.company_id
      and is_active and not is_archived
  ) then
    raise exception 'Assign an active department head before sending stock';
  end if;

  update public.products
  set central_stock_quantity = central_stock_quantity - p_quantity,
      updated_at = now()
  where id = p_product_id;

  insert into public.stock_deliveries (department_id, product_id, quantity, central_reserved, created_by)
  values (product_row.department_id, p_product_id, p_quantity, true, p_sender_id)
  returning id into delivery_id;

  return delivery_id;
end;
$$;

revoke all on function public.dispatch_department_stock(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.dispatch_department_stock(uuid, integer, uuid) to service_role;

drop function if exists public.receive_department_stock(uuid, uuid);
create or replace function public.receive_department_stock(
  p_delivery_id uuid,
  p_receiver_id uuid,
  p_received_quantity integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery_row public.stock_deliveries%rowtype;
  product_row public.products%rowtype;
  delivery_product_id uuid;
  department_head_id uuid;
  updated_quantity integer;
begin
  select product_id into delivery_product_id
  from public.stock_deliveries
  where id = p_delivery_id;
  if not found then
    raise exception 'This stock delivery could not be found';
  end if;

  select * into product_row
  from public.products
  where id = delivery_product_id
  for update;
  if not found then
    raise exception 'The delivered product could not be found';
  end if;

  select * into delivery_row
  from public.stock_deliveries
  where id = p_delivery_id
  for update;
  if not found or delivery_row.received_at is not null then
    raise exception 'This stock delivery is not awaiting receipt';
  end if;
  if p_received_quantity < 0 or p_received_quantity > delivery_row.quantity then
    raise exception 'The received quantity must be between zero and the sent quantity';
  end if;
  select head_user_id into department_head_id
  from public.departments
  where id = delivery_row.department_id;
  if department_head_id is distinct from p_receiver_id or not exists (
    select 1 from public.profiles
    where id = p_receiver_id
      and is_active and not is_archived
      and department_id = delivery_row.department_id
      and company_id = product_row.company_id
  ) then
    raise exception 'Only the active head of this department can receive its stock';
  end if;
  if product_row.department_id is distinct from delivery_row.department_id then
    raise exception 'The delivered product is no longer assigned to this department';
  end if;

  update public.products
  set stock_quantity = stock_quantity + p_received_quantity,
      central_stock_quantity = central_stock_quantity
        + case when delivery_row.central_reserved then delivery_row.quantity - p_received_quantity else 0 end,
      updated_at = now()
  where id = delivery_row.product_id
  returning stock_quantity into updated_quantity;

  update public.stock_deliveries
  set received_by = p_receiver_id,
      received_at = now(),
      received_quantity = p_received_quantity
  where id = delivery_row.id;

  return updated_quantity;
end;
$$;

revoke all on function public.receive_department_stock(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.receive_department_stock(uuid, uuid, integer) to service_role;

commit;
