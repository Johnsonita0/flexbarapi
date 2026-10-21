begin;

alter table public.products
  add column if not exists barcode text;

update public.products
set barcode = nullif(trim(barcode), '')
where barcode is not null;

create unique index if not exists products_company_barcode_unique_idx
  on public.products (company_id, barcode)
  where barcode is not null;

commit;
