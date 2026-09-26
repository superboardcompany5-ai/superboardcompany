-- Migration: adds the Job Card workflow to an already-provisioned
-- SuperBoardCompany Supabase project (schema.sql already applied).
-- Paste this whole file into the Supabase SQL editor and run it.
-- Safe to re-run from scratch even if a previous attempt got partway
-- through (every statement is guarded with if-exists/or-replace, and
-- policies are dropped-and-recreated since Postgres has no
-- "create policy if not exists").

-- ============================================================
-- Job Card numbering — financial-year based (Apr–Mar), e.g.
-- JC-2026-27-0001, resetting to 0001 at the start of each financial
-- year. Assigned automatically on insert; never changes afterward.
-- ============================================================
create table if not exists public.reel_job_card_number_counters (
  fy_label text primary key,
  last_seq integer not null default 0
);
alter table public.reel_job_card_number_counters enable row level security;

create or replace function public.fy_label(d date)
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

create or replace function public.next_job_card_number(for_date date)
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
create or replace function public.peek_next_job_card_number(for_date date)
returns text
language sql
security definer
as $$
  select 'JC-' || public.fy_label(for_date) || '-' ||
    lpad((coalesce((select last_seq from public.reel_job_card_number_counters where fy_label = public.fy_label(for_date)), 0) + 1)::text, 4, '0')
$$;

create or replace function public.set_job_card_number()
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
create table if not exists public.reel_job_cards (
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

drop trigger if exists trg_set_job_card_number on public.reel_job_cards;
create trigger trg_set_job_card_number
  before insert on public.reel_job_cards
  for each row execute procedure public.set_job_card_number();

create unique index if not exists reel_job_cards_one_pending_per_reel
  on public.reel_job_cards (reel_number)
  where status = 'pending';

-- one row per cut size/client planned on a cutting-sale job card —
-- weight_kg is deliberately absent, it's only known once the cut is
-- actually weighed at fulfillment (reel_dispatch_cuts.weight_kg)
create table if not exists public.reel_job_card_cuts (
  job_card_cut_id bigint generated always as identity primary key,
  job_card_id bigint not null references public.reel_job_cards (job_card_id),
  cut_size_cm text not null,
  sold_to text not null,
  remarks text,
  edited_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- in case a previous run of this migration already created the table
-- with these columns, before bundle/sheet details were moved to
-- fulfillment time
alter table public.reel_job_card_cuts drop column if exists bundle_count;
alter table public.reel_job_card_cuts drop column if exists sheets_per_bundle;
alter table public.reel_job_card_cuts drop column if exists extra_sheets;

-- ============================================================
-- reel_dispatches: every dispatch now fulfills a job card. Replace the
-- old free-text job_card_number with a proper FK to reel_job_cards.
--
-- reel_stock has to be dropped first: its lateral subquery does
-- `select *` from reel_dispatches, so Postgres records it as depending
-- on every column of that table — including the one being dropped.
-- ============================================================
drop view if exists public.reel_stock;

alter table public.reel_dispatches drop column if exists job_card_number;
alter table public.reel_dispatches add column if not exists job_card_id bigint references public.reel_job_cards (job_card_id);

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

grant select on public.reel_stock to authenticated;

-- ============================================================
-- Row Level Security + Grants for the new tables (same simple model
-- as every other reel table: any signed-in user can read/write)
-- ============================================================
alter table public.reel_job_cards enable row level security;
alter table public.reel_job_card_cuts enable row level security;

drop policy if exists "reel_job_cards: read" on public.reel_job_cards;
create policy "reel_job_cards: read" on public.reel_job_cards
  for select using (auth.role() = 'authenticated');
drop policy if exists "reel_job_cards: write" on public.reel_job_cards;
create policy "reel_job_cards: write" on public.reel_job_cards
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "reel_job_card_cuts: read" on public.reel_job_card_cuts;
create policy "reel_job_card_cuts: read" on public.reel_job_card_cuts
  for select using (auth.role() = 'authenticated');
drop policy if exists "reel_job_card_cuts: write" on public.reel_job_card_cuts;
create policy "reel_job_card_cuts: write" on public.reel_job_card_cuts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

grant select, insert, update, delete on public.reel_job_cards to authenticated;
grant select, insert, update, delete on public.reel_job_card_cuts to authenticated;
grant execute on function public.peek_next_job_card_number(date) to authenticated;
