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

-- ============================================================
-- Job Card numbering — financial-year based (Apr–Mar), e.g.
-- JC-2026-27-0001, resetting to 0001 at the start of each financial
-- year. Assigned automatically on insert; never changes afterward.
-- ============================================================
create table public.reel_job_card_number_counters (
  fy_label text primary key,
  last_seq integer not null default 0
);
alter table public.reel_job_card_number_counters enable row level security;

create function public.fy_label(d date)
returns text
language sql
immutable
as $$
  select (case when extract(month from d) >= 4
            then extract(year from d)::int
            else extract(year from d)::int - 1
          end)::text
    || '-' ||
    lpad((((case when extract(month from d) >= 4
            then extract(year from d)::int
            else extract(year from d)::int - 1
          end) + 1) % 100)::text, 2, '0')
$$;

create function public.next_job_card_number(for_date date)
returns text
language plpgsql
security definer
as $$
declare
  v_fy text := public.fy_label(for_date);
  v_seq int;
begin
  insert into public.reel_job_card_number_counters (fy_label, last_seq)
  values (v_fy, 1)
  on conflict (fy_label) do update set last_seq = public.reel_job_card_number_counters.last_seq + 1
  returning last_seq into v_seq;

  return 'JC-' || v_fy || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

-- read-only preview of what the next job_card_number would be — does NOT
-- reserve/consume it, so it's safe to call just for display while
-- someone is filling in the Create Job Card form
create function public.peek_next_job_card_number(for_date date)
returns text
language sql
security definer
as $$
  select 'JC-' || public.fy_label(for_date) || '-' ||
    lpad((coalesce((select last_seq from public.reel_job_card_number_counters where fy_label = public.fy_label(for_date)), 0) + 1)::text, 4, '0')
$$;

create function public.set_job_card_number()
returns trigger as $$
begin
  if new.job_card_number is null then
    new.job_card_number := public.next_job_card_number(coalesce(new.date, current_date));
  end if;
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- Job Cards — created when an order comes in, before the reel is
-- physically weighed/cut. Holds every dispatch detail except the
-- actual kanta weight(s), which are only known at fulfillment time
-- (see reel_dispatches.job_card_id below). A reel can have at most
-- one pending job card at a time (reel_job_cards_one_pending_per_reel),
-- so it's effectively reserved until the job card is fulfilled or
-- cancelled.
-- ============================================================
create table public.reel_job_cards (
  job_card_id bigint generated always as identity primary key,
  job_card_number text not null unique,
  reel_number text not null references public.reel_receipts (reel_number),
  date date not null default current_date,
  dispatch_type text not null check (dispatch_type in ('full', 'partial')),
  sold_form text not null check (sold_form in ('reel', 'cutting')),
  remaining_size_cm numeric check (remaining_size_cm >= 0),
  cutting_name text,
  -- sold as a whole reel: sold_to lives here directly.
  -- sold as cutting: null here — broken out per cut size/client in
  -- reel_job_card_cuts instead.
  sold_to text,
  remarks text,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'cancelled')),
  edited_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  check (
    (dispatch_type = 'full' and remaining_size_cm is null)
    or
    (dispatch_type = 'partial' and remaining_size_cm is not null)
  ),
  check (
    (sold_form = 'reel' and sold_to is not null)
    or
    (sold_form = 'cutting' and sold_to is null)
  )
);

create trigger trg_set_job_card_number
  before insert on public.reel_job_cards
  for each row execute procedure public.set_job_card_number();

create unique index reel_job_cards_one_pending_per_reel
  on public.reel_job_cards (reel_number)
  where status = 'pending';

-- one row per cut size/client planned on a cutting-sale job card —
-- weight_kg, bundle_count, sheets_per_bundle and extra_sheets are all
-- deliberately absent: they're only known once the cut is actually
-- made and weighed at fulfillment (reel_dispatch_cuts)
create table public.reel_job_card_cuts (
  job_card_cut_id bigint generated always as identity primary key,
  job_card_id bigint not null references public.reel_job_cards (job_card_id),
  cut_size_cm text not null,
  sold_to text not null,
  remarks text,
  edited_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- one row per dispatch event against a reel — always fulfills a job
-- card (see reel_job_cards above), which supplies every field here
-- except the actual weighed amount(s). 'partial' leaves the reel open
-- with reduced remaining_* values (the new current state); 'full'
-- consumes whatever was left and closes the reel out.
create table public.reel_dispatches (
  reel_dispatch_id bigint generated always as identity primary key,
  reel_number text not null references public.reel_receipts (reel_number),
  job_card_id bigint references public.reel_job_cards (job_card_id),
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
alter table public.reel_job_cards enable row level security;
alter table public.reel_job_card_cuts enable row level security;
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

create policy "reel_job_cards: read" on public.reel_job_cards
  for select using (auth.role() = 'authenticated');
create policy "reel_job_cards: write" on public.reel_job_cards
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "reel_job_card_cuts: read" on public.reel_job_card_cuts
  for select using (auth.role() = 'authenticated');
create policy "reel_job_card_cuts: write" on public.reel_job_card_cuts
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
grant select, insert, update, delete on public.reel_job_cards to authenticated;
grant select, insert, update, delete on public.reel_job_card_cuts to authenticated;
grant select, insert, update, delete on public.reel_dispatches to authenticated;
grant select, insert, update, delete on public.reel_dispatch_cuts to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.reel_stock to authenticated;
grant select on public.reel_dispatch_status to authenticated;
grant execute on function public.peek_next_job_card_number(date) to authenticated;
