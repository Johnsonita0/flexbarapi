begin;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  business_type text not null check (business_type in ('pharmacy', 'bar', 'restaurant', 'bar_restaurant')),
  created_at timestamptz not null default now()
);

insert into public.companies (id, name, business_type)
values ('00000000-0000-4000-8000-000000000001', 'Flex Bar', 'bar_restaurant')
on conflict (id) do nothing;

alter table public.companies enable row level security;
revoke all on public.companies from anon, authenticated;
grant select on public.companies to authenticated;
drop policy if exists companies_read_own_workspace on public.companies;
create policy companies_read_own_workspace
  on public.companies
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles profile
      where profile.id = (select auth.uid())
        and profile.company_id = companies.id
        and profile.is_active
        and not profile.is_archived
    )
  );

alter table public.profiles add column if not exists company_id uuid;
alter table public.departments add column if not exists company_id uuid;
alter table public.business_settings add column if not exists company_id uuid;
alter table public.attendance_records add column if not exists company_id uuid;
alter table public.admin_activity_logs add column if not exists company_id uuid;
alter table public.products add column if not exists company_id uuid;
alter table public.sales add column if not exists company_id uuid;
alter table public.sale_items add column if not exists company_id uuid;
alter table public.stock_handovers add column if not exists company_id uuid;
alter table public.stock_handover_items add column if not exists company_id uuid;
alter table public.stock_deliveries add column if not exists company_id uuid;
alter table public.notifications add column if not exists company_id uuid;
alter table public.shift_closings add column if not exists company_id uuid;
alter table public.department_meetings add column if not exists company_id uuid;
alter table public.department_meetings add column if not exists is_company_wide boolean not null default false;
alter table public.department_meetings alter column department_id drop not null;
alter table public.chat_conversations add column if not exists company_id uuid;
alter table public.chat_conversation_participants add column if not exists company_id uuid;
alter table public.chat_messages add column if not exists company_id uuid;

update public.profiles set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.departments set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.business_settings set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.attendance_records set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.admin_activity_logs set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.products set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.sales set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.sale_items set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.stock_handovers set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.stock_handover_items set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.stock_deliveries set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.notifications set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.shift_closings set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.department_meetings set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.chat_conversations set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.chat_conversation_participants set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;
update public.chat_messages set company_id = '00000000-0000-4000-8000-000000000001' where company_id is null;

alter table public.profiles alter column company_id set not null;
alter table public.departments alter column company_id set not null;
alter table public.business_settings alter column company_id set not null;
alter table public.attendance_records alter column company_id set not null;
alter table public.admin_activity_logs alter column company_id set not null;
alter table public.products alter column company_id set not null;
alter table public.sales alter column company_id set not null;
alter table public.sale_items alter column company_id set not null;
alter table public.stock_handovers alter column company_id set not null;
alter table public.stock_handover_items alter column company_id set not null;
alter table public.stock_deliveries alter column company_id set not null;
alter table public.notifications alter column company_id set not null;
alter table public.shift_closings alter column company_id set not null;
alter table public.department_meetings alter column company_id set not null;
alter table public.chat_conversations alter column company_id set not null;
alter table public.chat_conversation_participants alter column company_id set not null;
alter table public.chat_messages alter column company_id set not null;

alter table public.profiles alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.departments alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.business_settings alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.attendance_records alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.admin_activity_logs alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.products alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.sales alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.sale_items alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.stock_handovers alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.stock_handover_items alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.stock_deliveries alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.notifications alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.shift_closings alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.department_meetings alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.chat_conversations alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.chat_conversation_participants alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;
alter table public.chat_messages alter column company_id set default '00000000-0000-4000-8000-000000000001'::uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_company_id_fkey' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'departments_company_id_fkey' and conrelid = 'public.departments'::regclass) then
    alter table public.departments add constraint departments_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_settings_company_id_fkey' and conrelid = 'public.business_settings'::regclass) then
    alter table public.business_settings add constraint business_settings_company_id_fkey foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attendance_records_company_id_fkey' and conrelid = 'public.attendance_records'::regclass) then
    alter table public.attendance_records add constraint attendance_records_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'admin_activity_logs_company_id_fkey' and conrelid = 'public.admin_activity_logs'::regclass) then
    alter table public.admin_activity_logs add constraint admin_activity_logs_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_company_id_fkey' and conrelid = 'public.products'::regclass) then
    alter table public.products add constraint products_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_company_id_fkey' and conrelid = 'public.sales'::regclass) then
    alter table public.sales add constraint sales_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sale_items_company_id_fkey' and conrelid = 'public.sale_items'::regclass) then
    alter table public.sale_items add constraint sale_items_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_handovers_company_id_fkey' and conrelid = 'public.stock_handovers'::regclass) then
    alter table public.stock_handovers add constraint stock_handovers_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_handover_items_company_id_fkey' and conrelid = 'public.stock_handover_items'::regclass) then
    alter table public.stock_handover_items add constraint stock_handover_items_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_deliveries_company_id_fkey' and conrelid = 'public.stock_deliveries'::regclass) then
    alter table public.stock_deliveries add constraint stock_deliveries_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notifications_company_id_fkey' and conrelid = 'public.notifications'::regclass) then
    alter table public.notifications add constraint notifications_company_id_fkey foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shift_closings_company_id_fkey' and conrelid = 'public.shift_closings'::regclass) then
    alter table public.shift_closings add constraint shift_closings_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'department_meetings_company_id_fkey' and conrelid = 'public.department_meetings'::regclass) then
    alter table public.department_meetings add constraint department_meetings_company_id_fkey foreign key (company_id) references public.companies (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_conversations_company_id_fkey' and conrelid = 'public.chat_conversations'::regclass) then
    alter table public.chat_conversations add constraint chat_conversations_company_id_fkey foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_conversation_participants_company_id_fkey' and conrelid = 'public.chat_conversation_participants'::regclass) then
    alter table public.chat_conversation_participants add constraint chat_conversation_participants_company_id_fkey foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_company_id_fkey' and conrelid = 'public.chat_messages'::regclass) then
    alter table public.chat_messages add constraint chat_messages_company_id_fkey foreign key (company_id) references public.companies (id) on delete cascade;
  end if;
end
$$;

drop index if exists public.departments_name_unique;
create unique index if not exists departments_company_name_unique on public.departments (company_id, lower(name));
create index if not exists profiles_company_id_idx on public.profiles (company_id);
create index if not exists departments_company_id_idx on public.departments (company_id);
create index if not exists products_company_id_idx on public.products (company_id);
create index if not exists sales_company_created_idx on public.sales (company_id, created_at desc);
create index if not exists department_meetings_company_starts_idx on public.department_meetings (company_id, starts_at);
create unique index if not exists business_settings_company_id_unique on public.business_settings (company_id);

alter table public.business_settings drop constraint if exists business_settings_id_check;
create sequence if not exists public.business_settings_id_seq;
select setval('public.business_settings_id_seq', greatest(coalesce((select max(id)::bigint from public.business_settings), 0), 1));
alter table public.business_settings alter column id set default nextval('public.business_settings_id_seq');

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  company_name text;
  requested_type text;
  new_company_id uuid;
  owner_name text;
  requested_company_id uuid;
begin
  company_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'company_name', '')), '');
  requested_type := coalesce(new.raw_user_meta_data ->> 'business_type', '');
  owner_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');

  if company_name is not null
    and char_length(company_name) between 2 and 120
    and requested_type in ('pharmacy', 'bar', 'restaurant', 'bar_restaurant') then
    insert into public.companies (name, business_type)
    values (company_name, requested_type)
    returning id into new_company_id;

    insert into public.profiles (id, display_name, role, is_active, company_id)
    values (new.id, owner_name, 'management_admin', true, new_company_id);

    insert into public.departments (company_id, name, sales_enabled)
    select new_company_id, department.name, department.sales_enabled
    from (values
      ('Management', false, array['pharmacy', 'bar', 'restaurant', 'bar_restaurant']::text[]),
      ('Pharmacy', true, array['pharmacy']::text[]),
      ('Bar', true, array['bar', 'bar_restaurant']::text[]),
      ('Kitchen', false, array['restaurant', 'bar_restaurant']::text[]),
      ('Restaurant Floor', true, array['restaurant', 'bar_restaurant']::text[]),
      ('Cashier', true, array['pharmacy', 'restaurant', 'bar_restaurant']::text[]),
      ('Inventory & Store', false, array['pharmacy', 'bar', 'restaurant', 'bar_restaurant']::text[])
    ) as department(name, sales_enabled, business_types)
    where requested_type = any(department.business_types);

    insert into public.business_settings (company_id) values (new_company_id);
  else
    requested_company_id := null;
    if coalesce(new.raw_user_meta_data ->> 'company_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      select id into requested_company_id
      from public.companies
      where id = (new.raw_user_meta_data ->> 'company_id')::uuid;
    end if;
    insert into public.profiles (id, display_name, role, is_active, company_id)
    values (
      new.id,
      owner_name,
      case
        when new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid then 'super_admin'::public.app_role
        else 'staff'::public.app_role
      end,
      new.id = '9668b2c5-428f-4d38-a29f-b5de8aa3d6b0'::uuid,
      coalesce(requested_company_id, '00000000-0000-4000-8000-000000000001'::uuid)
    );
  end if;

  return new;
end;
$$;

create or replace function public.set_row_company_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_company_id uuid;
begin
  case tg_table_name
    when 'attendance_records' then
      select company_id into expected_company_id from public.profiles where id = new.user_id;
    when 'admin_activity_logs' then
      select company_id into expected_company_id from public.profiles where id = new.actor_id;
    when 'products' then
      select company_id into expected_company_id from public.departments where id = new.department_id;
      if expected_company_id is null and new.created_by is not null then
        select company_id into expected_company_id from public.profiles where id = new.created_by;
      end if;
    when 'sales', 'stock_handovers', 'stock_deliveries', 'shift_closings' then
      select company_id into expected_company_id from public.departments where id = new.department_id;
    when 'sale_items' then
      select company_id into expected_company_id from public.sales where id = new.sale_id;
    when 'stock_handover_items' then
      select company_id into expected_company_id from public.stock_handovers where id = new.handover_id;
    when 'notifications' then
      select company_id into expected_company_id from public.profiles where id = new.user_id;
    when 'department_meetings' then
      select company_id into expected_company_id from public.profiles where id = new.created_by;
    when 'chat_conversations' then
      select company_id into expected_company_id from public.profiles where id = new.created_by;
    when 'chat_conversation_participants' then
      select company_id into expected_company_id from public.chat_conversations where id = new.conversation_id;
    when 'chat_messages' then
      select company_id into expected_company_id from public.chat_conversations where id = new.conversation_id;
  end case;

  if expected_company_id is not null
    and new.company_id <> '00000000-0000-4000-8000-000000000001'::uuid
    and new.company_id <> expected_company_id then
    raise exception 'Company workspace does not match the related record';
  end if;
  if new.company_id is null or expected_company_id is not null then
    new.company_id := expected_company_id;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_records_set_company on public.attendance_records;
drop trigger if exists admin_activity_logs_set_company on public.admin_activity_logs;
drop trigger if exists products_set_company on public.products;
drop trigger if exists sales_set_company on public.sales;
drop trigger if exists sale_items_set_company on public.sale_items;
drop trigger if exists stock_handovers_set_company on public.stock_handovers;
drop trigger if exists stock_handover_items_set_company on public.stock_handover_items;
drop trigger if exists stock_deliveries_set_company on public.stock_deliveries;
drop trigger if exists notifications_set_company on public.notifications;
drop trigger if exists shift_closings_set_company on public.shift_closings;
drop trigger if exists department_meetings_set_company on public.department_meetings;
drop trigger if exists chat_conversations_set_company on public.chat_conversations;
drop trigger if exists chat_conversation_participants_set_company on public.chat_conversation_participants;
drop trigger if exists chat_messages_set_company on public.chat_messages;
create trigger attendance_records_set_company before insert or update of company_id, user_id on public.attendance_records for each row execute function public.set_row_company_id();
create trigger admin_activity_logs_set_company before insert or update of company_id, actor_id on public.admin_activity_logs for each row execute function public.set_row_company_id();
create trigger products_set_company before insert or update of company_id, department_id, created_by on public.products for each row execute function public.set_row_company_id();
create trigger sales_set_company before insert or update of company_id, department_id on public.sales for each row execute function public.set_row_company_id();
create trigger sale_items_set_company before insert or update of company_id, sale_id on public.sale_items for each row execute function public.set_row_company_id();
create trigger stock_handovers_set_company before insert or update of company_id, department_id on public.stock_handovers for each row execute function public.set_row_company_id();
create trigger stock_handover_items_set_company before insert or update of company_id, handover_id on public.stock_handover_items for each row execute function public.set_row_company_id();
create trigger stock_deliveries_set_company before insert or update of company_id, department_id on public.stock_deliveries for each row execute function public.set_row_company_id();
create trigger notifications_set_company before insert or update of company_id, user_id on public.notifications for each row execute function public.set_row_company_id();
create trigger shift_closings_set_company before insert or update of company_id, department_id on public.shift_closings for each row execute function public.set_row_company_id();
create trigger department_meetings_set_company before insert or update of company_id, created_by, department_id on public.department_meetings for each row execute function public.set_row_company_id();
create trigger chat_conversations_set_company before insert or update of company_id, created_by on public.chat_conversations for each row execute function public.set_row_company_id();
create trigger chat_conversation_participants_set_company before insert or update of company_id, conversation_id on public.chat_conversation_participants for each row execute function public.set_row_company_id();
create trigger chat_messages_set_company before insert or update of company_id, conversation_id on public.chat_messages for each row execute function public.set_row_company_id();

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
  where profiles.id = new.seller_id
    and profiles.company_id = new.company_id;

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
      and profile.company_id = meeting.company_id
      and (
        profile.role::text in ('super_admin', 'management_admin')
        or meeting.is_company_wide
        or profile.department_id = meeting.department_id
      )
  );
end;
$$;

commit;
