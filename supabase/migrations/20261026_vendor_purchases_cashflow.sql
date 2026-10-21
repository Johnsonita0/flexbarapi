begin;

alter table public.products
  add column if not exists average_unit_cost numeric(14, 4) not null default 0
  check (average_unit_cost >= 0);

alter table public.sale_items
  add column if not exists unit_cost numeric(14, 4),
  add column if not exists line_cost numeric(14, 2);

create table if not exists public.vendor_purchases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  vendor_name text not null check (char_length(trim(vendor_name)) between 2 and 160),
  reference text check (reference is null or char_length(trim(reference)) <= 100),
  package_quantity integer not null check (package_quantity > 0),
  units_per_package integer not null check (units_per_package > 0),
  total_units integer not null check (total_units > 0),
  rate_per_package numeric(14, 2) not null check (rate_per_package >= 0),
  invoice_total numeric(14, 2) not null check (invoice_total >= 0),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.vendor_purchase_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  purchase_id uuid not null references public.vendor_purchases (id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  payment_method text not null check (payment_method in ('cash', 'card', 'transfer')),
  paid_by uuid not null references public.profiles (id) on delete restrict,
  paid_at timestamptz not null default now()
);

alter table public.central_stock_receipts
  add column if not exists purchase_id uuid references public.vendor_purchases (id) on delete set null;

create index if not exists vendor_purchases_company_created_idx
  on public.vendor_purchases (company_id, created_at desc);
create index if not exists vendor_purchases_product_created_idx
  on public.vendor_purchases (product_id, created_at desc);
create index if not exists vendor_purchase_payments_company_paid_idx
  on public.vendor_purchase_payments (company_id, paid_at desc);
create index if not exists vendor_purchase_payments_purchase_idx
  on public.vendor_purchase_payments (purchase_id);

alter table public.vendor_purchases enable row level security;
alter table public.vendor_purchase_payments enable row level security;
revoke all on public.vendor_purchases, public.vendor_purchase_payments from anon, authenticated;

create or replace function public.record_vendor_purchase(
  p_product_id uuid,
  p_vendor_name text,
  p_package_quantity integer,
  p_units_per_package integer,
  p_rate_per_package numeric,
  p_amount_paid numeric,
  p_payment_method text,
  p_reference text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  product_row public.products%rowtype;
  purchase_id uuid;
  total_units integer;
  invoice_total numeric(14, 2);
  new_average_cost numeric(14, 4);
  existing_units bigint;
begin
  if p_package_quantity < 1 or p_units_per_package < 1
    or p_package_quantity::bigint * p_units_per_package::bigint > 1000000
    or p_rate_per_package < 0 or p_amount_paid < 0
    or p_payment_method not in ('cash', 'card', 'transfer')
    or char_length(trim(p_vendor_name)) not between 2 and 160
    or (p_reference is not null and char_length(trim(p_reference)) > 100) then
    raise exception 'Enter valid vendor, purchase quantity, package size, rate, and payment details';
  end if;
  total_units := p_package_quantity * p_units_per_package;
  invoice_total := round(p_package_quantity * p_rate_per_package, 2);
  if p_amount_paid > invoice_total then
    raise exception 'Amount paid cannot exceed the purchase invoice total';
  end if;

  select * into product_row from public.products
  where id = p_product_id for update;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and company_id = product_row.company_id
      and is_active and not is_archived
      and role in ('super_admin', 'management_admin', 'inventory_officer')
  ) then
    raise exception 'You do not have permission to record vendor purchases';
  end if;

  select product_row.stock_quantity::bigint + product_row.central_stock_quantity::bigint
    + coalesce(sum(quantity), 0)
  into existing_units
  from public.stock_deliveries
  where product_id = p_product_id and received_at is null;

  if product_row.average_unit_cost > 0 and existing_units > 0 then
    new_average_cost := round(
      (product_row.average_unit_cost * existing_units
        + (invoice_total / total_units) * total_units)
      / (existing_units + total_units), 4
    );
  else
    new_average_cost := round(invoice_total / total_units, 4);
  end if;

  insert into public.vendor_purchases (
    company_id, product_id, vendor_name, reference, package_quantity,
    units_per_package, total_units, rate_per_package, invoice_total, created_by
  ) values (
    product_row.company_id, p_product_id, trim(p_vendor_name),
    nullif(trim(coalesce(p_reference, '')), ''), p_package_quantity,
    p_units_per_package, total_units, p_rate_per_package, invoice_total, p_user_id
  ) returning id into purchase_id;

  update public.products
  set central_stock_quantity = central_stock_quantity + total_units,
      average_unit_cost = new_average_cost,
      updated_at = now()
  where id = p_product_id;

  insert into public.central_stock_receipts (company_id, product_id, quantity, received_by, purchase_id)
  values (product_row.company_id, p_product_id, total_units, p_user_id, purchase_id);

  if p_amount_paid > 0 then
    insert into public.vendor_purchase_payments (
      company_id, purchase_id, amount, payment_method, paid_by
    ) values (product_row.company_id, purchase_id, p_amount_paid, p_payment_method, p_user_id);
  end if;

  return jsonb_build_object(
    'purchaseId', purchase_id,
    'centralStock', product_row.central_stock_quantity + total_units,
    'averageUnitCost', new_average_cost,
    'invoiceTotal', invoice_total
  );
end;
$$;

revoke all on function public.record_vendor_purchase(uuid, text, integer, integer, numeric, numeric, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_vendor_purchase(uuid, text, integer, integer, numeric, numeric, text, text, uuid) to service_role;

create or replace function public.record_vendor_purchase_payment(
  p_purchase_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_user_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  purchase_row public.vendor_purchases%rowtype;
  total_paid numeric(14, 2);
begin
  if p_amount <= 0 or p_payment_method not in ('cash', 'card', 'transfer') then
    raise exception 'Enter a valid payment amount and payment method';
  end if;
  select * into purchase_row from public.vendor_purchases
  where id = p_purchase_id for update;
  if not found then
    raise exception 'Purchase not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and company_id = purchase_row.company_id
      and is_active and not is_archived
      and role in ('super_admin', 'management_admin', 'inventory_officer')
  ) then
    raise exception 'You do not have permission to record vendor payments';
  end if;
  select coalesce(sum(amount), 0) into total_paid
  from public.vendor_purchase_payments where purchase_id = p_purchase_id;
  if total_paid + p_amount > purchase_row.invoice_total then
    raise exception 'Payment exceeds the vendor purchase balance';
  end if;
  insert into public.vendor_purchase_payments (
    company_id, purchase_id, amount, payment_method, paid_by
  ) values (purchase_row.company_id, p_purchase_id, p_amount, p_payment_method, p_user_id);
  return total_paid + p_amount;
end;
$$;

revoke all on function public.record_vendor_purchase_payment(uuid, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.record_vendor_purchase_payment(uuid, numeric, text, uuid) to service_role;

create or replace function public.snapshot_sale_item_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cost numeric(14, 4);
begin
  select average_unit_cost into cost from public.products where id = new.product_id;
  if found and cost > 0 then
    new.unit_cost := cost;
    new.line_cost := round(cost * new.quantity, 2);
  end if;
  return new;
end;
$$;

drop trigger if exists sale_items_snapshot_cost on public.sale_items;
create trigger sale_items_snapshot_cost
before insert on public.sale_items
for each row execute function public.snapshot_sale_item_cost();

commit;
