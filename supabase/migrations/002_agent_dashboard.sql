-- Agent dashboard support.
-- Run this AFTER supabase/schema.sql, in the Supabase SQL editor or via
-- `supabase db push`. Additive only — safe to run on a DB that already has
-- data from schema.sql.

-- Agents are a separate identity from `public.users` (customers). They are
-- provisioned out-of-band with scripts/create-agent.js (there is no public
-- self-signup endpoint — this is an internal tool), and authenticate with
-- their own email/password against POST /api/v1/agent/auth/login, which
-- mints a token signed with AGENT_JWT_SECRET (a different secret than the
-- customer APP_JWT_SECRET, so a customer session token can never be replayed
-- against an agent-only route, and vice versa).
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  full_name text not null,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per line item an agent actually sourced for an order. Checkout
-- today only stores a single offerId in orders.metadata (see payments.js),
-- so this table is populated/edited by agents from the dashboard as they
-- work the order, not automatically at checkout time.
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  title text not null,
  retailer text,
  price numeric not null default 0,
  quantity integer not null default 1,
  image_url text,
  offer_url text,
  created_at timestamptz not null default now()
);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

-- Append-only audit trail of what happened to an order and when. Rows with
-- created_by_agent_id = null are system-generated (e.g. "Payment confirmed"
-- inserted automatically when /payments/verify succeeds); rows with an
-- agent id were added manually from the dashboard.
create table if not exists public.order_timeline_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status text,
  label text not null,
  note text,
  created_by_agent_id uuid references public.agents(id) on delete set null,
  occurred_at timestamptz not null default now()
);
create index if not exists order_timeline_events_order_id_idx on public.order_timeline_events(order_id);

-- Everything the [id].tsx order detail screen needs that a bare
-- amount/status/metadata row can't express: fee breakdown, shipping
-- address, carrier/tracking, delivery estimates, and agent assignment.
-- Kept as columns (rather than yet more tables) since each order has
-- exactly one of each — shipping_address stays jsonb to match the
-- metadata jsonb pattern already used elsewhere in this schema.
alter table public.orders
  add column if not exists subtotal numeric,
  add column if not exists shipping_fee numeric not null default 0,
  add column if not exists service_fee numeric not null default 0,
  add column if not exists shipping_address jsonb,
  add column if not exists carrier text,
  add column if not exists tracking_number text,
  add column if not exists estimated_delivery timestamptz,
  add column if not exists window_closes_at timestamptz,
  add column if not exists assigned_agent_id uuid references public.agents(id) on delete set null,
  add column if not exists agent_note text;

create index if not exists orders_status_idx on public.orders(status);
create index if not exists orders_assigned_agent_id_idx on public.orders(assigned_agent_id);

-- Backfill subtotal for existing rows so it's never null going forward;
-- new rows should set subtotal = amount - shipping_fee - service_fee at
-- write time (see agentOrders.js / payments.js).
update public.orders set subtotal = amount where subtotal is null;

alter table public.agents enable row level security;
alter table public.order_items enable row level security;
alter table public.order_timeline_events enable row level security;
-- No policies defined on purpose — see the note at the top of schema.sql.
-- The service role key (used by the backend) bypasses RLS entirely; these
-- tables are unreachable by anon/authenticated roles until you add policies.
