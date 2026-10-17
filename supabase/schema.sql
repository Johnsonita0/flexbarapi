-- ============================================================
-- 0001_profiles.sql
-- ============================================================
do $$
begin
  create type public.app_role as enum (
    'super_admin',
    'management_admin',
    'department_supervisor',
    'inventory_officer',
    'cash_sales_officer',
    'staff'
  );
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role public.app_role not null default 'staff',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  head_user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.departments
  add column if not exists head_user_id uuid references public.profiles (id) on delete set null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'departments' and column_name = 'company_id'
  ) then
    create unique index if not exists departments_company_name_unique
      on public.departments (company_id, lower(name));
  else
    create unique index if not exists departments_name_unique
      on public.departments (lower(name));
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'departments'
      and column_name = 'company_id'
  ) then
    insert into public.departments (company_id, name)
    select '00000000-0000-4000-8000-000000000001'::uuid, department.name
    from (values
      ('Management'),
      ('Bar'),
      ('Kitchen'),
      ('Restaurant Floor'),
      ('Cashier'),
      ('Inventory & Store'),
      ('Cleaning & Maintenance')
    ) as department(name)
    on conflict do nothing;
  else
    insert into public.departments (name)
    values
      ('Management'),
      ('Bar'),
      ('Kitchen'),
      ('Restaurant Floor'),
      ('Cashier'),
      ('Inventory & Store'),
      ('Cleaning & Maintenance')
    on conflict do nothing;
  end if;
end;
$$;

alter table public.profiles
  add column if not exists department_id uuid references public.departments (id) on delete set null,
  add column if not exists avatar_path text,
  add column if not exists is_archived boolean not null default false,
  add column if not exists lock_pin_hash text,
  add column if not exists lock_pin_failed_attempts integer not null default 0,
  add column if not exists lock_pin_locked_until timestamptz;

create table if not exists public.business_settings (
  id smallint primary key default 1 check (id = 1),
  latitude double precision,
  longitude double precision,
  geofence_radius_m integer not null default 100 check (geofence_radius_m between 25 and 2000),
  timezone text not null default 'Africa/Lagos',
  currency text not null default 'NGN' check (currency in ('NGN', 'USD', 'GBP', 'EUR')),
  opening_time time not null default '08:00',
  closing_time time not null default '23:00',
  notify_task_assignments boolean not null default true,
  notify_low_stock boolean not null default true,
  notify_sales_updates boolean not null default true,
  notify_new_messages boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.business_settings
  add column if not exists currency text not null default 'NGN',
  add column if not exists opening_time time not null default '08:00',
  add column if not exists closing_time time not null default '23:00',
  add column if not exists notify_task_assignments boolean not null default true,
  add column if not exists notify_low_stock boolean not null default true,
  add column if not exists notify_sales_updates boolean not null default true,
  add column if not exists notify_new_messages boolean not null default true;

insert into public.business_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  work_date date not null,
  check_in_at timestamptz not null default now(),
  check_out_at timestamptz,
  check_in_latitude double precision not null,
  check_in_longitude double precision not null,
  check_out_latitude double precision,
  check_out_longitude double precision,
  created_at timestamptz not null default now(),
  unique (user_id, work_date)
);

alter table public.attendance_records
  add column if not exists staff_name_snapshot text,
  add column if not exists staff_email_snapshot text;

alter table public.attendance_records
  drop constraint if exists attendance_records_user_id_fkey;

alter table public.attendance_records
  alter column user_id drop not null,
  add constraint attendance_records_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete set null;

update public.attendance_records as attendance
set staff_name_snapshot = coalesce(profiles.display_name, auth_users.email, 'Former staff member'),
    staff_email_snapshot = auth_users.email
from public.profiles as profiles
left join auth.users as auth_users on auth_users.id = profiles.id
where attendance.user_id = profiles.id
  and attendance.staff_name_snapshot is null;

create table if not exists public.admin_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  actor_name text not null,
  actor_email text,
  action text not null,
  target_type text not null,
  target_id text,
  target_label text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_activity_logs_created_at_idx
  on public.admin_activity_logs (created_at desc);

create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_staff_lock_pin(p_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN must contain exactly four digits';
  end if;

  select * into profile_row
  from public.profiles
  where id = p_user_id
  for update;

  if not found or profile_row.role = 'super_admin'::public.app_role then
    raise exception 'Staff account not found';
  end if;

  update public.profiles
  set lock_pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')),
      lock_pin_failed_attempts = 0,
      lock_pin_locked_until = null,
      updated_at = now()
  where id = p_user_id;
end;
$$;

create or replace function public.verify_staff_lock_pin(p_user_id uuid, p_pin text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  failed_attempts integer;
begin
  if p_pin !~ '^[0-9]{4}$' then
    return 'invalid';
  end if;

  select * into profile_row
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    return 'missing';
  end if;
  if profile_row.lock_pin_hash is null then
    return 'unconfigured';
  end if;
  if profile_row.lock_pin_locked_until is not null and profile_row.lock_pin_locked_until > now() then
    return 'locked';
  end if;
  if extensions.crypt(p_pin, profile_row.lock_pin_hash) = profile_row.lock_pin_hash then
    update public.profiles
    set lock_pin_failed_attempts = 0,
        lock_pin_locked_until = null
    where id = p_user_id;
    return 'verified';
  end if;

  failed_attempts := profile_row.lock_pin_failed_attempts + 1;
  update public.profiles
  set lock_pin_failed_attempts = failed_attempts,
      lock_pin_locked_until = case
        when failed_attempts >= 5 then now() + interval '15 minutes'
        else null
      end
  where id = p_user_id;

  if failed_attempts >= 5 then
    return 'locked';
  end if;
  return 'invalid';
end;
$$;

revoke all on function public.set_staff_lock_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.verify_staff_lock_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.set_staff_lock_pin(uuid, text) to service_role;
grant execute on function public.verify_staff_lock_pin(uuid, text) to service_role;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_active'
      and column_default in ('true', 'true::boolean')
  ) then
    update public.profiles
    set is_active = false,
        updated_at = now()
    where id <> '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid;
  end if;
end;
$$;

alter table public.profiles
  alter column is_active set default false;

alter table public.profiles enable row level security;
alter table public.departments enable row level security;
alter table public.business_settings enable row level security;
alter table public.attendance_records enable row level security;
alter table public.admin_activity_logs enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on public.departments from anon, authenticated;
grant select on public.departments to authenticated;
revoke all on public.business_settings, public.attendance_records from anon, authenticated;
revoke all on public.admin_activity_logs from anon, authenticated;

drop policy if exists "Authenticated users can read departments" on public.departments;
create policy "Authenticated users can read departments"
  on public.departments
  for select
  to authenticated
  using (true);

drop policy if exists "Users can read their own profile" on public.profiles;

create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 8388608, array['image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own profile photo" on storage.objects;
create policy "Users can upload their own profile photo"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own profile photo" on storage.objects;
create policy "Users can update their own profile photo"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own profile photo" on storage.objects;
create policy "Users can delete their own profile photo"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  company_name text;
  business_type text;
  company_id uuid;
  requested_company_id uuid;
  owner_name text;
begin
  owner_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');
  company_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'company_name', '')), '');
  business_type := coalesce(new.raw_user_meta_data ->> 'business_type', '');

  if company_name is not null
    and char_length(company_name) between 2 and 120
    and business_type in ('pharmacy', 'bar', 'restaurant', 'bar_restaurant')
    and to_regclass('public.companies') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'company_id'
    ) then
    execute 'insert into public.companies (name, business_type) values ($1, $2) returning id'
      into company_id using company_name, business_type;
    execute 'insert into public.profiles (id, display_name, role, is_active, company_id) values ($1, $2, $3, true, $4)'
      using new.id, owner_name, 'management_admin'::public.app_role, company_id;
    execute $insert_departments$
      insert into public.departments (company_id, name, sales_enabled)
      select $1, department.name, department.sales_enabled
      from (values
        ('Management', false, array['pharmacy', 'bar', 'restaurant', 'bar_restaurant']::text[]),
        ('Pharmacy', true, array['pharmacy']::text[]),
        ('Bar', true, array['bar', 'bar_restaurant']::text[]),
        ('Kitchen', false, array['restaurant', 'bar_restaurant']::text[]),
        ('Restaurant Floor', true, array['restaurant', 'bar_restaurant']::text[]),
        ('Cashier', true, array['pharmacy', 'restaurant', 'bar_restaurant']::text[]),
        ('Inventory & Store', false, array['pharmacy', 'bar', 'restaurant', 'bar_restaurant']::text[])
      ) as department(name, sales_enabled, business_types)
      where $2 = any(department.business_types)
    $insert_departments$ using company_id, business_type;
    execute 'insert into public.business_settings (company_id) values ($1)'
      using company_id;
    return new;
  end if;

  requested_company_id := null;
  if coalesce(new.raw_user_meta_data ->> 'company_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and to_regclass('public.companies') is not null then
    execute 'select id from public.companies where id = $1::uuid'
      into requested_company_id
      using new.raw_user_meta_data ->> 'company_id';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'company_id'
  ) then
    execute 'insert into public.profiles (id, display_name, role, is_active, company_id) values ($1, $2, $3, $4, coalesce($5, $6::uuid))'
      using
        new.id,
        owner_name,
        case
          when new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid then 'super_admin'::public.app_role
          else 'staff'::public.app_role
        end,
        new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid,
        requested_company_id,
        '00000000-0000-4000-8000-000000000001';
  else
    insert into public.profiles (id, display_name, role, is_active)
    values (
      new.id,
      owner_name,
      case
        when new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid then 'super_admin'::public.app_role
        else 'staff'::public.app_role
      end,
      new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

insert into public.profiles (id, display_name, role, is_active)
select
  id,
  nullif(trim(coalesce(raw_user_meta_data ->> 'display_name', '')), ''),
  case
    when id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid then 'super_admin'::public.app_role
    else 'staff'::public.app_role
  end,
  id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid
from auth.users
on conflict (id) do update
set role = 'super_admin',
    is_active = true,
    updated_at = now()
where excluded.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid;


-- ============================================================
-- 0002_inventory_products.sql
-- ============================================================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  category text not null check (char_length(trim(category)) between 2 and 80),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  unit text not null default 'items' check (char_length(trim(unit)) between 1 and 30),
  reorder_level integer not null default 5 check (reorder_level >= 0),
  image_path text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_name_idx on public.products (lower(name));

alter table public.products enable row level security;
revoke all on public.products from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own product images" on storage.objects;
create policy "Users can upload their own product images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can update their own product images" on storage.objects;
create policy "Users can update their own product images"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own product images" on storage.objects;
create policy "Users can delete their own product images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ============================================================
-- 0003_department_sales_shift_handover.sql
-- ============================================================
alter table public.departments
  add column if not exists sales_enabled boolean not null default false;

update public.departments
set sales_enabled = true
where lower(name) in ('bar', 'restaurant floor', 'cashier');

alter table public.products
  add column if not exists department_id uuid references public.departments (id) on delete restrict,
  add column if not exists unit_price numeric(12, 2) not null default 0 check (unit_price >= 0);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete restrict,
  seller_id uuid not null references public.profiles (id) on delete restrict,
  payment_method text not null check (payment_method in ('cash', 'card', 'transfer')),
  total_amount numeric(14, 2) not null check (total_amount >= 0),
  created_at timestamptz not null default now()
);

create index if not exists sales_department_created_at_idx
  on public.sales (department_id, created_at desc);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(14, 2) not null check (line_total >= 0)
);

create table if not exists public.stock_handovers (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete restrict,
  sender_id uuid not null references public.profiles (id) on delete restrict,
  receiver_id uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  check (sender_id <> receiver_id),
  check ((status = 'pending' and accepted_at is null) or (status = 'accepted' and accepted_at is not null))
);

create index if not exists stock_handovers_receiver_status_idx
  on public.stock_handovers (receiver_id, status, created_at desc);

create table if not exists public.stock_handover_items (
  id uuid primary key default gen_random_uuid(),
  handover_id uuid not null references public.stock_handovers (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  product_name text not null,
  sent_quantity integer not null check (sent_quantity >= 0),
  received_quantity integer check (received_quantity >= 0),
  unique (handover_id, product_id)
);

create table if not exists public.stock_deliveries (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  received_by uuid references public.profiles (id) on delete restrict,
  received_at timestamptz,
  check ((received_by is null and received_at is null) or (received_by is not null and received_at is not null))
);

create index if not exists stock_deliveries_department_created_idx
  on public.stock_deliveries (department_id, created_at desc);

alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.stock_handovers enable row level security;
alter table public.stock_handover_items enable row level security;
alter table public.stock_deliveries enable row level security;
revoke all on public.sales, public.sale_items, public.stock_handovers, public.stock_handover_items from anon, authenticated;
revoke all on public.stock_deliveries from anon, authenticated;

drop function if exists public.record_department_sale(uuid, uuid, text, jsonb);
create function public.record_department_sale(
  p_seller_id uuid,
  p_department_id uuid,
  p_payment_method text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  sale_id uuid;
  item jsonb;
  product_row public.products%rowtype;
  item_product_id uuid;
  item_quantity integer;
  total numeric(14, 2) := 0;
  item_count integer;
begin
  if p_payment_method not in ('cash', 'card', 'transfer') or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Invalid sale details';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_seller_id and is_active and not is_archived
      and department_id = p_department_id and role <> 'super_admin'::public.app_role
  ) or not exists (
    select 1 from public.departments where id = p_department_id and sales_enabled
  ) then
    raise exception 'Sales are not enabled for this department';
  end if;

  select count(*), count(distinct (value ->> 'productId'))
  into item_count, item_quantity
  from jsonb_array_elements(p_items);
  if item_count <> item_quantity then
    raise exception 'A product may only appear once in a sale';
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    item_product_id := (item ->> 'productId')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    if item_quantity < 1 then
      raise exception 'Sale quantities must be positive';
    end if;
    select * into product_row
    from public.products
    where id = item_product_id and department_id = p_department_id
    for update;
    if not found then
      raise exception 'A selected product is not assigned to this department';
    end if;
    if product_row.unit_price <= 0 then
      raise exception 'A selected product needs a sale price before it can be sold';
    end if;
    if product_row.stock_quantity < item_quantity then
      raise exception 'Insufficient stock for %', product_row.name;
    end if;
    total := total + (product_row.unit_price * item_quantity);
  end loop;

  insert into public.sales (department_id, seller_id, payment_method, total_amount)
  values (p_department_id, p_seller_id, p_payment_method, total)
  returning id into sale_id;

  for item in select value from jsonb_array_elements(p_items) loop
    item_product_id := (item ->> 'productId')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    select * into product_row from public.products where id = item_product_id for update;
    update public.products
    set stock_quantity = stock_quantity - item_quantity,
        updated_at = now()
    where id = item_product_id;
    insert into public.sale_items (sale_id, product_id, product_name, quantity, unit_price, line_total)
    values (sale_id, item_product_id, product_row.name, item_quantity, product_row.unit_price, product_row.unit_price * item_quantity);
  end loop;

  return sale_id;
end;
$$;

revoke all on function public.record_department_sale(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_department_sale(uuid, uuid, text, jsonb) to service_role;

drop function if exists public.create_stock_handover(uuid, uuid, uuid, jsonb);
create function public.create_stock_handover(
  p_sender_id uuid,
  p_receiver_id uuid,
  p_department_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  handover_id uuid;
  item jsonb;
  product_row public.products%rowtype;
  item_product_id uuid;
  item_quantity integer;
  item_count integer;
  distinct_count integer;
begin
  if p_sender_id = p_receiver_id or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Invalid handover details';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_sender_id and is_active and not is_archived and department_id = p_department_id
  ) or not exists (
    select 1 from public.profiles
    where id = p_receiver_id and is_active and not is_archived and department_id = p_department_id
  ) then
    raise exception 'Both staff must be active members of the same department';
  end if;
  if exists (select 1 from public.stock_handovers where department_id = p_department_id and status = 'pending') then
    raise exception 'This department already has a pending stock handover';
  end if;
  select count(*), count(distinct (value ->> 'productId'))
  into item_count, distinct_count
  from jsonb_array_elements(p_items);
  if item_count <> distinct_count or item_count <> (
    select count(*) from public.products where department_id = p_department_id
  ) then
    raise exception 'Enter a count for every product in the department';
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    item_product_id := (item ->> 'productId')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    if item_quantity < 0 then
      raise exception 'Handover quantities cannot be negative';
    end if;
    select * into product_row
    from public.products
    where id = item_product_id and department_id = p_department_id
    for update;
    if not found then
      raise exception 'A counted product is not assigned to this department';
    end if;
  end loop;

  insert into public.stock_handovers (department_id, sender_id, receiver_id)
  values (p_department_id, p_sender_id, p_receiver_id)
  returning id into handover_id;

  for item in select value from jsonb_array_elements(p_items) loop
    item_product_id := (item ->> 'productId')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    select * into product_row from public.products where id = item_product_id;
    insert into public.stock_handover_items (handover_id, product_id, product_name, sent_quantity)
    values (handover_id, item_product_id, product_row.name, item_quantity);
  end loop;

  return handover_id;
end;
$$;

revoke all on function public.create_stock_handover(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_stock_handover(uuid, uuid, uuid, jsonb) to service_role;

drop function if exists public.accept_stock_handover(uuid, uuid, jsonb);
create function public.accept_stock_handover(
  p_handover_id uuid,
  p_receiver_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  handover_row public.stock_handovers%rowtype;
  item jsonb;
  item_product_id uuid;
  item_quantity integer;
  item_count integer;
  distinct_count integer;
begin
  select * into handover_row
  from public.stock_handovers
  where id = p_handover_id
  for update;
  if not found or handover_row.status <> 'pending' or handover_row.receiver_id <> p_receiver_id then
    raise exception 'This handover is not available to this receiver';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Enter received counts for every product';
  end if;
  select count(*), count(distinct (value ->> 'productId'))
  into item_count, distinct_count
  from jsonb_array_elements(p_items);
  if item_count <> distinct_count or item_count <> (
    select count(*) from public.stock_handover_items where handover_id = p_handover_id
  ) then
    raise exception 'Enter a received count for every handed-over product';
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    item_product_id := (item ->> 'productId')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    if item_quantity < 0 or not exists (
      select 1 from public.stock_handover_items
      where handover_id = p_handover_id and product_id = item_product_id
    ) then
      raise exception 'Invalid received count';
    end if;
  end loop;

  for item in select value from jsonb_array_elements(p_items) loop
    item_product_id := (item ->> 'productId')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    update public.stock_handover_items
    set received_quantity = item_quantity
    where handover_id = p_handover_id and product_id = item_product_id;
    update public.products
    set stock_quantity = item_quantity,
        updated_at = now()
    where id = item_product_id;
  end loop;

  update public.stock_handovers
  set status = 'accepted', accepted_at = now()
  where id = p_handover_id;
end;
$$;

revoke all on function public.accept_stock_handover(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.accept_stock_handover(uuid, uuid, jsonb) to service_role;

create or replace function public.receive_department_stock(
  p_delivery_id uuid,
  p_receiver_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery_row public.stock_deliveries%rowtype;
  department_head_id uuid;
  updated_quantity integer;
begin
  select * into delivery_row
  from public.stock_deliveries
  where id = p_delivery_id
  for update;
  if not found or delivery_row.received_at is not null then
    raise exception 'This stock delivery is not awaiting receipt';
  end if;

  select head_user_id into department_head_id
  from public.departments
  where id = delivery_row.department_id;
  if department_head_id is distinct from p_receiver_id or not exists (
    select 1 from public.profiles
    where id = p_receiver_id
      and is_active
      and not is_archived
      and department_id = delivery_row.department_id
  ) then
    raise exception 'Only the active head of this department can receive its stock';
  end if;

  update public.products
  set stock_quantity = stock_quantity + delivery_row.quantity,
      updated_at = now()
  where id = delivery_row.product_id
    and department_id = delivery_row.department_id
  returning stock_quantity into updated_quantity;
  if not found then
    raise exception 'The delivered product is no longer assigned to this department';
  end if;

  update public.stock_deliveries
  set received_by = p_receiver_id,
      received_at = now()
  where id = delivery_row.id;

  return updated_quantity;
end;
$$;

revoke all on function public.receive_department_stock(uuid, uuid) from public, anon, authenticated;
grant execute on function public.receive_department_stock(uuid, uuid) to service_role;


-- ============================================================
-- 0004_sales_notifications.sql
-- ============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('sale')),
  title text not null,
  detail text not null,
  sale_id uuid not null references public.sales (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_user_created_at_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

drop policy if exists "Users can read their own notifications" on public.notifications;
create policy "Users can read their own notifications"
  on public.notifications
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.notify_admin_of_completed_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seller_name text;
  department_name text;
  sale_detail text;
begin
  select coalesce(profiles.display_name, 'A staff member'), departments.name
  into seller_name, department_name
  from public.profiles
  join public.departments on departments.id = new.department_id
  where profiles.id = new.seller_id;

  sale_detail := '₦' || to_char(new.total_amount, 'FM999,999,999,990.00')
    || ' sale completed by ' || coalesce(seller_name, 'a staff member')
    || ' in ' || coalesce(department_name, 'a department') || '.';

  insert into public.notifications (user_id, type, title, detail, sale_id)
  select profiles.id, 'sale', 'Sale completed', sale_detail, new.id
  from public.profiles
  where profiles.role in ('super_admin'::public.app_role, 'management_admin'::public.app_role)
    and profiles.is_active
    and not profiles.is_archived
    and profiles.company_id = new.company_id;

  return new;
end;
$$;

drop trigger if exists sales_notify_admins on public.sales;
create trigger sales_notify_admins
  after insert on public.sales
  for each row
  execute function public.notify_admin_of_completed_sale();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;


-- ============================================================
-- 0005_demo_departments_and_products.sql
-- ============================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'departments'
      and column_name = 'company_id'
  ) then
    insert into public.departments (company_id, name)
    select '00000000-0000-4000-8000-000000000001'::uuid, department.name
    from (values
      ('Bar'),
      ('Kitchen'),
      ('Restaurant Floor'),
      ('Cashier'),
      ('Inventory & Store'),
      ('Cleaning & Maintenance'),
      ('Management')
    ) as department(name)
    on conflict do nothing;
  else
    insert into public.departments (name)
    values
      ('Bar'),
      ('Kitchen'),
      ('Restaurant Floor'),
      ('Cashier'),
      ('Inventory & Store'),
      ('Cleaning & Maintenance'),
      ('Management')
    on conflict do nothing;
  end if;
end;
$$;

delete from public.products
where name in (
  'Sample - Jollof Rice',
  'Sample - Grilled Chicken',
  'Sample - Fries'
)
and not exists (
  select 1 from public.sale_items where sale_items.product_id = products.id
)
and not exists (
  select 1 from public.stock_handover_items where stock_handover_items.product_id = products.id
);

update public.products
set name = case name
      when 'Sample - Bottled Water' then 'Bottled Water'
      when 'Sample - Cola' then 'Coca-Cola'
      when 'Sample - Malt Drink' then 'Maltina'
      when 'Sample - Orange Juice' then 'Chivita'
      when 'Sample - Lager' then 'Star Lager'
      when 'Sample - Table Water' then 'Table Water'
      when 'Sample - Fruit Juice' then 'Hollandia'
      when 'Sample - Jollof Rice' then 'Archived demo food item'
      when 'Sample - Grilled Chicken' then 'Archived demo grilled chicken'
      when 'Sample - Fries' then 'Archived demo fries'
    end,
    category = case
      when category = 'Demo beverages' then 'Beverage'
      when category = 'Demo meals' then 'Other'
      else category
    end,
    stock_quantity = 0,
    reorder_level = 0,
    department_id = null,
    unit_price = 0,
    updated_at = now()
where name in (
  'Sample - Bottled Water',
  'Sample - Cola',
  'Sample - Malt Drink',
  'Sample - Orange Juice',
  'Sample - Lager',
  'Sample - Jollof Rice',
  'Sample - Grilled Chicken',
  'Sample - Fries',
  'Sample - Table Water',
  'Sample - Fruit Juice'
);

insert into public.products (
  name,
  category,
  stock_quantity,
  unit,
  reorder_level,
  department_id,
  unit_price
)
select
  catalog.name,
  catalog.category,
  0,
  'units',
  0,
  null,
  0
from (values
  ('Bottled Water', 'Water'),
  ('Table Water', 'Water'),
  ('Coca-Cola', 'Soft drinks'),
  ('Fanta', 'Soft drinks'),
  ('Sprite', 'Soft drinks'),
  ('Nescafe', 'Coffee'),
  ('Chivita', 'Juice'),
  ('Hollandia', 'Dairy drinks'),
  ('Maltina', 'Malt drinks'),
  ('Amstel Malta', 'Malt drinks'),
  ('Fayrouz', 'Malt drinks'),
  ('Zagg', 'Energy drinks'),
  ('Malta Guinness', 'Malt drinks'),
  ('Star Lager', 'Beer'),
  ('Gulder', 'Beer'),
  ('Heineken', 'Beer'),
  ('Guinness Foreign Extra Stout', 'Stout'),
  ('Legend Extra Stout', 'Stout'),
  ('Carlo Rossi', 'Wine'),
  ('4th Street', 'Wine'),
  ('Jameson', 'Whisky'),
  ('Johnnie Walker', 'Whisky'),
  ('Hennessy', 'Cognac'),
  ('Martell', 'Cognac'),
  ('Remy Martin', 'Cognac'),
  ('Gordons Gin', 'Gin'),
  ('Tanqueray', 'Gin'),
  ('Smirnoff Vodka', 'Vodka'),
  ('Absolut Vodka', 'Vodka'),
  ('Bacardi Rum', 'Rum'),
  ('Moet & Chandon', 'Champagne'),
  ('Martini Asti', 'Sparkling wine'),
  ('Orijin Bitters', 'Bitters'),
  ('Alomo Bitters', 'Bitters'),
  ('Campari', 'Aperitif'),
  ('Aromatic Bitters', 'Bitters'),
  ('Baileys Irish Cream', 'Liqueur')
) as catalog(name, category)
where not exists (
  select 1
  from public.products
  where lower(products.name) = lower(catalog.name)
);


-- ============================================================
-- 0006_sales_department_defaults.sql
-- ============================================================
update public.departments
set sales_enabled = true
where lower(trim(name)) in ('bar', 'restaurant floor', 'cashier');

-- Department head dashboards, accountable shift cash closes and department meetings.
create table if not exists public.shift_closings (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  business_date date not null,
  opening_cash numeric(14, 2) not null check (opening_cash >= 0),
  cash_sales numeric(14, 2) not null check (cash_sales >= 0),
  cash_received numeric(14, 2) not null check (cash_received >= 0),
  cash_paid_out numeric(14, 2) not null check (cash_paid_out >= 0),
  expected_cash numeric(14, 2) not null check (expected_cash >= 0),
  actual_cash numeric(14, 2) not null check (actual_cash >= 0),
  variance numeric(14, 2) not null,
  handover_notes text,
  handed_to uuid references public.profiles (id) on delete set null,
  closed_at timestamptz not null default now(),
  unique (user_id, business_date)
);

create index if not exists shift_closings_department_date_idx
  on public.shift_closings (department_id, business_date desc, closed_at desc);

alter table public.shift_closings enable row level security;
revoke all on public.shift_closings from anon, authenticated;

create table if not exists public.department_meetings (
  id uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments (id) on delete cascade,
  is_company_wide boolean not null default false,
  created_by uuid not null references public.profiles (id) on delete restrict,
  title text not null check (char_length(title) between 3 and 120),
  agenda text not null check (char_length(agenda) between 3 and 2000),
  starts_at timestamptz not null,
  is_instant boolean not null default false,
  location text check (location is null or char_length(location) <= 160),
  call_mode text not null default 'video' check (call_mode in ('voice', 'video')),
  created_at timestamptz not null default now()
);

alter table public.department_meetings
  add column if not exists call_mode text not null default 'video'
  check (call_mode in ('voice', 'video'));

alter table public.department_meetings
  add column if not exists is_instant boolean not null default false;

alter table public.department_meetings
  add column if not exists is_company_wide boolean not null default false,
  alter column department_id drop not null;

create index if not exists department_meetings_department_starts_idx
  on public.department_meetings (department_id, starts_at);

alter table public.department_meetings enable row level security;
revoke all on public.department_meetings from anon, authenticated;

update public.departments
set sales_enabled = false
where lower(name) ~ '\m(management|admin|administration|kitchen|inventory|store|cleaning|maintenance|security|finance|human resources|operations|laundry)\M';

-- Authenticated one-to-one staff messaging. Writes are performed by the API;
-- authenticated clients can only read rows belonging to their conversations.
create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  direct_key text not null unique,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_conversation_participants (
  conversation_id uuid not null references public.chat_conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists chat_conversation_participants_user_idx
  on public.chat_conversation_participants (user_id, conversation_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  sender_name text not null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists chat_messages_conversation_created_idx
  on public.chat_messages (conversation_id, created_at desc);

alter table public.chat_conversation_participants enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_conversations enable row level security;
revoke all on public.chat_conversations, public.chat_conversation_participants, public.chat_messages from anon, authenticated;
grant select on public.chat_conversation_participants, public.chat_messages to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_conversation_participants'
      and policyname = 'chat_participants_read_own'
  ) then
    create policy chat_participants_read_own
      on public.chat_conversation_participants
      for select
      to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_messages'
      and policyname = 'chat_messages_read_conversation'
  ) then
    create policy chat_messages_read_conversation
      on public.chat_messages
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.chat_conversation_participants participant
          where participant.conversation_id = chat_messages.conversation_id
            and participant.user_id = (select auth.uid())
        )
      );
  end if;
end
$$;

alter table public.department_meetings
  add column if not exists call_mode text not null default 'video'
  check (call_mode in ('voice', 'video'));

-- Only active members of a meeting's department and active administrators can
-- exchange ephemeral WebRTC signaling on that meeting's private Realtime topic.
create or replace function public.can_access_department_meeting_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  meeting_id uuid;
begin
  if p_topic !~ '^department-meeting:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  meeting_id := substring(p_topic from char_length('department-meeting:') + 1)::uuid;
  return exists (
    select 1
    from public.department_meetings meeting
    join public.profiles profile on profile.id = (select auth.uid())
    where meeting.id = meeting_id
      and profile.is_active
      and not profile.is_archived
      and (
        profile.role::text in ('super_admin', 'management_admin')
        or (meeting.is_company_wide and profile.company_id = meeting.company_id)
        or profile.department_id = meeting.department_id
      )
  );
end;
$$;

revoke all on function public.can_access_department_meeting_topic(text) from public, anon;
grant execute on function public.can_access_department_meeting_topic(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'department_meeting_signaling_read'
  ) then
    execute $policy$
      create policy department_meeting_signaling_read
        on realtime.messages
        for select
        to authenticated
        using (public.can_access_department_meeting_topic(realtime.topic()))
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'department_meeting_signaling_write'
  ) then
    execute $policy$
      create policy department_meeting_signaling_write
        on realtime.messages
        for insert
        to authenticated
        with check (public.can_access_department_meeting_topic(realtime.topic()))
    $policy$;
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'chat_conversation_participants'
    ) then
      execute 'alter publication supabase_realtime add table public.chat_conversation_participants';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'chat_messages'
    ) then
      execute 'alter publication supabase_realtime add table public.chat_messages';
    end if;
  end if;
end
$$;
