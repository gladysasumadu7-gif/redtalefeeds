# ShopBot backend

Node.js/Express backend for the Redtail AI shopping app — AI chat (Gemini),
price comparison, Paystack payments, Google sign-in, Supabase-backed
persistence, and an internal **agent dashboard API**.

## Run it

```
npm install
cp env.example .env    # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_JWT_SECRET, AGENT_JWT_SECRET, ...
npm start
```

Apply the database schema first — either paste `supabase/schema.sql` (then
each file in `supabase/migrations/`, in order) into the Supabase SQL editor,
or, if you have `DATABASE_URL` set to a direct Postgres connection string:

```
npm run migrate
```

`scripts/migrate.js` applies `supabase/schema.sql` and every migration in
`supabase/migrations/` in filename order. Every statement is idempotent
(`create table if not exists`, `add column if not exists`), so re-running it
is always safe.

## Customer-facing API

- `GET  /health`
- `GET/POST /api/v1/auth/*` — Google sign-in (see `src/routes/auth.js`)
- `POST /api/v1/chat/threads/:id/messages`, `GET /api/v1/chat/threads/:id/messages`
- `GET  /api/v1/products/search?query=...`
- `POST /api/v1/payments/init`, `POST /api/v1/payments/verify`, `POST /api/v1/payments/webhook`
- `GET  /api/v1/payments/orders/:reference` — a customer's own order only

## Agent dashboard API (internal tool, separate from the customer app)

Agents are a completely separate identity from customers — no self-signup,
no Google OAuth, and a different JWT secret (`AGENT_JWT_SECRET`) so a
customer's session token and an agent's can never be used interchangeably.

Provision the first agent from the command line (there is no signup route
on purpose):

```
node scripts/create-agent.js --email agent@company.com --name "Ada Agent" --password "correct-horse-battery-staple"
```

Then, once `AGENT_JWT_SECRET` is set and the migration has run:

- `POST /api/v1/agent/auth/login` — `{ email, password }` → `{ token, agent }`
- `GET  /api/v1/agent/auth/me`
- `GET  /api/v1/agent/orders?status=&search=&page=&limit=` — list across *all* customers, filter by status or search reference/email
- `GET  /api/v1/agent/orders/:id` — full detail: customer profile, items, timeline, tracking, fee breakdown
- `PATCH /api/v1/agent/orders/:id` — update status, carrier, `trackingNumber`, `estimatedDelivery`, `windowClosesAt`, `agentNote`, `assignedAgentId` (`"me"` to self-assign), `subtotal`/`shippingFee`/`serviceFee`, `shippingAddress`. A status change auto-logs a timeline event.
- `POST /api/v1/agent/orders/:id/timeline` — `{ label, note?, status? }`, for anything that isn't a plain status change
- `POST /api/v1/agent/orders/:id/items` / `DELETE /api/v1/agent/orders/:id/items/:itemId` — checkout only ever stores one `offerId` (see `src/routes/payments.js`), so agents reconcile the real sourced items list here
- `GET  /api/v1/agent/customers?search=`
- `GET  /api/v1/agent/customers/:id` — profile + full order history

Valid `status` values: `AGENT_REVIEWING`, `SOURCING`, `ORDERED`, `SHIPPED`,
`OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED`, `REFUNDED`.

**Known gap, needs a product decision:** at checkout, `subtotal` is seeded
equal to the full paid `amount` since no itemized breakdown exists yet — an
agent fills in real items/fees via the dashboard once sourcing starts.
Whether that itemization should happen *before* the customer is charged is
outside what this backend change alone can decide.

## Deployment

`Dockerfile` + `render.yaml` build and deploy this as a Docker web service
on Render. Required env vars are listed in `render.yaml`'s `envVars` (set
their values in the Render dashboard, not in git) and in `env.example`.
