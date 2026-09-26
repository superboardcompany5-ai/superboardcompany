-- SuperBoardCompany schema — reel stock only
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query)
-- Extracted from the InventoryManagement project's reel_* tables/views.

create extension if not exists pgcrypto;

-- ============================================================
-- Profiles (one row per staff member, auto-created on invite)
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', new.email));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- Reel Stock — each reel is a distinct physical item (not pooled
-- like sheet/packet products): it shrinks in size/weight as it gets
-- cut down over one or more dispatches, until a 'full' dispatch
-- consumes whatever remains and closes it out.
-- ============================================================
create table public.reel_receipts (
  reel_id bigint generated always as identity primary key,
  reel_number text not null unique,
  quality text not null,
  gsm numeric,
  size_cm numeric not null check (size_cm > 0),
  size_in numeric,
  gross_weight numeric not null check (gross_weight > 0),
  kanta_weight numeric not null check (kanta_weight > 0),
  -- theoretical/invoice net weight, entered separately (not derived from
  -- gross) — the baseline "no wastage" figure a dispatch's actual kanta
  -- weight gets reconciled against
  net_weight numeric check (net_weight > 0),
  cutting_name text,
  date date not null default current_date,
  remarks text,
  edited_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- one row per dispatch event against a reel. 'partial' leaves the reel
-- open with reduced remaining_* values (the new current state); 'full'
-- consumes whatever was left and closes the reel out.
create table public.reel_dispatches (
  reel_dispatch_id bigint generated always as identity primary key,
  reel_number text not null references public.reel_receipts (reel_number),
  date date not null default current_date,
  dispatch_type text not null check (dispatch_type in ('full', 'partial')),
  sold_form text not null check (sold_form in ('reel', 'cutting')),
  remaining_size_cm numeric check (remaining_size_cm >= 0),
  remaining_gross_weight numeric check (remaining_gross_weight >= 0),
  remaining_kanta_weight numeric check (remaining_kanta_weight >= 0),
  -- proportionally scaled like remaining_gross/kanta_weight, but nullable
  -- on its own since older reels received before net_weight existed have
  -- no baseline to scale from
  remaining_net_weight numeric check (remaining_net_weight >= 0),
  cutting_name text,
  -- which cutting job this was done under, when sold_form is 'cutting'
  job_card_number text,
  -- sold as a whole reel: sold_to/kanta_weight live here directly.
  -- sold as cutting: they're null here — the sale is broken out per cut
  -- size/client in reel_dispatch_cuts instead.
  sold_to text,
  kanta_weight numeric check (kanta_weight > 0),
  remarks text,
  edited_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (
    (dispatch_type = 'full' and remaining_size_cm is null and remaining_gross_weight is null and remaining_kanta_weight is null)
    or
    (dispatch_type = 'partial' and remaining_size_cm is not null and remaining_gross_weight is not null and remaining_kanta_weight is not null)
  ),
  check (
    (sold_form = 'reel' and sold_to is not null and kanta_weight is not null)
    or
    (sold_form = 'cutting' and sold_to is null and kanta_weight is null)
  )
);

-- one row per cut size/client when a dispatch's sold_form is 'cutting' —
-- a single reel (or piece of one) can be cut into several different
-- sheet sizes and sold to several different clients in one dispatch.
create table public.reel_dispatch_cuts (
  cut_id bigint generated always as identity primary key,
  reel_dispatch_id bigint not null references public.reel_dispatches (reel_dispatch_id),
  cut_size_cm text not null,
  weight_kg numeric not null check (weight_kg > 0),
  bundle_count numeric check (bundle_count > 0),
  sheets_per_bundle numeric check (sheets_per_bundle > 0),
  -- loose sheets left over that don't make up a full bundle, e.g.
  -- "10 bundles x 100 sheets + 80 sheets" — extra_sheets = 80
  extra_sheets numeric check (extra_sheets > 0),
  sold_to text not null,
  remarks text,
  edited_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- current state per reel (computed): whatever the latest dispatch left
-- behind, or the as-received values if it's never been dispatched.
-- Reels whose latest dispatch was 'full' are closed and drop out here.
create view public.reel_stock
with (security_invoker = true) as
select
  rr.reel_id,
  rr.reel_number,
  rr.quality,
  rr.gsm,
  coalesce(ld.remaining_size_cm, rr.size_cm) as size_cm,
  case
    when ld.remaining_size_cm is not null and rr.size_cm > 0
      then round(rr.size_in * ld.remaining_size_cm / rr.size_cm, 3)
    else rr.size_in
  end as size_in,
  coalesce(ld.remaining_gross_weight, rr.gross_weight) as gross_weight,
  coalesce(ld.remaining_kanta_weight, rr.kanta_weight) as kanta_weight,
  coalesce(ld.cutting_name, rr.cutting_name) as cutting_name,
  rr.date as received_date,
  ld.date as last_dispatch_date,
  coalesce(ld.remaining_net_weight, rr.net_weight) as net_weight
from public.reel_receipts rr
left join lateral (
  select *
  from public.reel_dispatches d
  where d.reel_number = rr.reel_number
  order by d.reel_dispatch_id desc
  limit 1
) ld on true
where ld.reel_dispatch_id is null or ld.dispatch_type = 'partial';

-- per-dispatch wastage check: the reel's net weight baseline just before
-- this dispatch (previous dispatch's remaining, or the receipt if none),
-- vs what was actually weighed out (kanta_weight, or the sum across cut
-- sizes/clients when sold as cutting). material_diff < 0 = shortage
-- (wastage); > 0 = came out heavier than expected (material over).
create view public.reel_dispatch_status
with (security_invoker = true) as
select
  d.reel_dispatch_id,
  d.reel_number,
  d.date,
  d.dispatch_type,
  d.sold_form,
  coalesce(prior.net_weight, rr.net_weight) as baseline_net_weight,
  coalesce(prior.net_weight, rr.net_weight) - coalesce(d.remaining_net_weight, 0) as expected_net_weight_dispatched,
  coalesce(d.kanta_weight, cuts.total_kanta) as actual_kanta_sold,
  coalesce(d.kanta_weight, cuts.total_kanta)
    - (coalesce(prior.net_weight, rr.net_weight) - coalesce(d.remaining_net_weight, 0)) as material_diff
from public.reel_dispatches d
join public.reel_receipts rr on rr.reel_number = d.reel_number
left join lateral (
  select pd.remaining_net_weight as net_weight
  from public.reel_dispatches pd
  where pd.reel_number = d.reel_number and pd.reel_dispatch_id < d.reel_dispatch_id
  order by pd.reel_dispatch_id desc
  limit 1
) prior on true
left join (
  select reel_dispatch_id, sum(weight_kg) as total_kanta
  from public.reel_dispatch_cuts
  group by reel_dispatch_id
) cuts on cuts.reel_dispatch_id = d.reel_dispatch_id;

-- ============================================================
-- Row Level Security
-- Simple model for a small trusted internal team:
-- any signed-in user can read/write. Tighten later per-role if needed.
-- ============================================================
alter table public.profiles enable row level security;
alter table public.reel_receipts enable row level security;
alter table public.reel_dispatches enable row level security;
alter table public.reel_dispatch_cuts enable row level security;

create policy "profiles: read all" on public.profiles
  for select using (auth.role() = 'authenticated');
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

create policy "reel_receipts: read" on public.reel_receipts
  for select using (auth.role() = 'authenticated');
create policy "reel_receipts: write" on public.reel_receipts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "reel_dispatches: read" on public.reel_dispatches
  for select using (auth.role() = 'authenticated');
create policy "reel_dispatches: write" on public.reel_dispatches
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "reel_dispatch_cuts: read" on public.reel_dispatch_cuts
  for select using (auth.role() = 'authenticated');
create policy "reel_dispatch_cuts: write" on public.reel_dispatch_cuts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ============================================================
-- Grants
-- RLS policies above control *which rows* are visible; Postgres also
-- requires a plain GRANT before a role can query the object at all.
-- ============================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.reel_receipts to authenticated;
grant select, insert, update, delete on public.reel_dispatches to authenticated;
grant select, insert, update, delete on public.reel_dispatch_cuts to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.reel_stock to authenticated;
grant select on public.reel_dispatch_status to authenticated;
