-- ============================================================
-- MCL WMS — Supabase Schema
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ============================================================
-- CONSIGNEES
-- ============================================================
create table if not exists consignees (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  full_address text,
  created_at  timestamptz default now()
);

-- Pre-load consignees
insert into consignees (name, full_address) values
  ('MINCURL LOGISTICS', '3050 NW 107 AVE, SUITE 440, DORAL, FL 33172'),
  ('AEROPOST', '1630 NW 82ND AVE, DORAL, FL 33126'),
  ('JETBOX', '8400 NW 25TH ST, SUITE 100, MIAMI, FL 33122'),
  ('MAILBOXES PANAMA', '500 NW 68TH AVE, MIAMI, FL 33126'),
  ('GENERAL CARGO', '3250 NW 87TH AVE, DORAL, FL 33172')
on conflict do nothing;

-- ============================================================
-- WR SEQUENCE
-- ============================================================
create table if not exists wr_sequence (
  id      int primary key default 1,
  last_num bigint not null default 0,
  check (id = 1)   -- single-row table
);

insert into wr_sequence (id, last_num) values (1, 0)
on conflict (id) do nothing;

-- RPC: get next WR number atomically
create or replace function get_next_wr_number()
returns text
language plpgsql
security definer
as $$
declare
  next_num bigint;
begin
  update wr_sequence
    set last_num = last_num + 1
  where id = 1
  returning last_num into next_num;

  return 'LI' || lpad(next_num::text, 10, '0');
end;
$$;

-- ============================================================
-- WAREHOUSE RECEIPTS
-- ============================================================
create table if not exists warehouse_receipts (
  id                      uuid primary key default gen_random_uuid(),
  wr_number               text unique,

  -- Shipment info
  agent_code              text,
  company_name            text,
  po_number               text,
  from_port               text default 'MIA',
  to_port                 text,
  status                  text default 'LOCAL',

  -- Declared (counter)
  declared_pieces         int,
  declared_weight_kg      numeric(10,2),

  -- Received (physical)
  total_qty               int default 0,
  total_cbm               numeric(10,4) default 0,
  total_weight_kg         numeric(10,2) default 0,

  -- Driver
  driver_name             text,
  driver_license          text,
  driver_license_photo_url text,

  -- Consignee
  consignee_id            uuid references consignees(id),

  -- Status flags
  counter_status          text not null default 'pending',  -- pending | complete
  physical_status         text not null default 'pending',  -- pending | complete

  -- Observations
  observations            text,

  -- Audit
  counter_by              uuid references auth.users(id),
  physical_by             uuid references auth.users(id),
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- Index for common queries
create index if not exists idx_wr_counter_status  on warehouse_receipts(counter_status);
create index if not exists idx_wr_physical_status on warehouse_receipts(physical_status);
create index if not exists idx_wr_created_at      on warehouse_receipts(created_at desc);

-- ============================================================
-- WR LINES
-- ============================================================
create table if not exists wr_lines (
  id           uuid primary key default gen_random_uuid(),
  wr_id        uuid not null references warehouse_receipts(id) on delete cascade,
  order_num    int not null default 0,

  qty          int,
  packing_type text,
  has_lb       boolean default false,
  is_dg        boolean default false,
  length_cm    numeric(8,1),
  width_cm     numeric(8,1),
  height_cm    numeric(8,1),
  cbm          numeric(10,4),
  weight_kg    numeric(10,2),
  location     text,
  remarks      text,

  created_at   timestamptz default now()
);

create index if not exists idx_wr_lines_wr_id on wr_lines(wr_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Consignees: any authenticated user can read
alter table consignees enable row level security;
create policy "consignees_select" on consignees
  for select to authenticated using (true);

-- Warehouse receipts: any authenticated user can CRUD
alter table warehouse_receipts enable row level security;
create policy "wr_select" on warehouse_receipts
  for select to authenticated using (true);
create policy "wr_insert" on warehouse_receipts
  for insert to authenticated with check (true);
create policy "wr_update" on warehouse_receipts
  for update to authenticated using (true);
create policy "wr_delete" on warehouse_receipts
  for delete to authenticated using (true);

-- WR Lines: any authenticated user can CRUD
alter table wr_lines enable row level security;
create policy "wr_lines_select" on wr_lines
  for select to authenticated using (true);
create policy "wr_lines_insert" on wr_lines
  for insert to authenticated with check (true);
create policy "wr_lines_update" on wr_lines
  for update to authenticated using (true);
create policy "wr_lines_delete" on wr_lines
  for delete to authenticated using (true);

-- WR sequence: only the function (security definer) needs access
alter table wr_sequence enable row level security;
-- No direct user access needed; accessed via RPC only

-- ============================================================
-- STORAGE BUCKET: dl-photos
-- ============================================================
-- Run this in Supabase Dashboard > Storage, or via the API:
--
--   insert into storage.buckets (id, name, public)
--   values ('dl-photos', 'dl-photos', true)
--   on conflict do nothing;
--
-- Then add storage policies:
--
--   create policy "dl_photos_insert" on storage.objects
--     for insert to authenticated with check (bucket_id = 'dl-photos');
--
--   create policy "dl_photos_select" on storage.objects
--     for select to authenticated using (bucket_id = 'dl-photos');
--
-- (Public bucket means the URLs are publicly readable without auth.)
