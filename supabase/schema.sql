-- Run this in the Supabase SQL editor (or via `supabase db push`) once,
-- against your project's Postgres database.
--
-- The backend talks to Supabase using the SERVICE ROLE key, which bypasses
-- Row Level Security entirely — so RLS below is defense-in-depth for the
-- day you also expose the anon/public key to some other client, not what
-- actually protects these routes today. The real authorization boundary is
-- the `requireAuth` Express middleware (see src/middleware/auth.js), which
-- verifies the app's JWT and scopes every query to `req.user.id`.

create extension if not exists "pgcrypto";

-- One row per person who has ever signed in with Google.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique not null,
  email text unique not null,
  full_name text,
  photo_url text,
  kyc_status text not null default 'unverified' check (kyc_status in ('unverified', 'pending', 'verified')),
  created_at timestamptz not null default now()
);

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- The Redtail app generates its own thread ids client-side (see
  -- src/utils/id.ts, e.g. "id_abc123xyz1") rather than using our uuid pk.
  -- We keep our own uuid as the real primary/foreign key and store the
  -- app's id alongside it so /threads/:id in the route matches what the
  -- app already sent.
  client_thread_id text not null,
  title text,
  last_message_preview text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, client_thread_id)
);
create index if not exists chat_threads_user_id_idx on public.chat_threads(user_id);


create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text,
  offers jsonb,
  search_query text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_thread_id_idx on public.chat_messages(thread_id);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  reference text unique not null,
  amount numeric not null,
  currency text not null default 'NGN',
  customer_email text,
  metadata jsonb,
  status text not null default 'AGENT_REVIEWING',
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_reference_idx on public.orders(reference);

-- Row Level Security — belt-and-suspenders, see note above.
alter table public.users enable row level security;
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.orders enable row level security;

-- No policies are defined for the anon/authenticated roles on purpose:
-- with RLS enabled and zero policies, every table is fully inaccessible to
-- anything other than the service role key the backend uses. If you later
-- want to query Supabase directly from the app with the anon key, add
-- scoped policies here instead of relying on the backend alone.