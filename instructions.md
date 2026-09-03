# Agent dashboard — how to apply these changes

Two kinds of files below:
- **New files** — copy these into your project at the exact same relative path. Nothing to merge.
- **Patches** (`*.diff`) — these are unified diffs against your existing files. Open each one, find the matching lines in your file, and apply the `+`/`-` changes by hand (or `git apply patches/<name>.diff` from your project root if the file hasn't drifted from what you gave me).

## 1. New files — copy as-is

```
src/lib/agentJwt.js
src/middleware/agentAuth.js
src/routes/agentAuth.js
src/routes/agentOrders.js
src/routes/agentCustomers.js
scripts/create-agent.js
supabase/migrations/002_agent_dashboard.sql
README.md   ← yours was empty; this documents both the existing API and the new agent endpoints. Merge in whatever you'd already written, if anything.
```

## 2. Patch existing files

- `server.js.diff` — imports the three new agent modules, adds the `AGENT_JWT_SECRET` startup warning, and mounts `/api/v1/agent/auth`, `/api/v1/agent/orders`, `/api/v1/agent/customers`.
- `src_routes_payments.js.diff` — applies to `src/routes/payments.js`. Seeds `subtotal` on order creation and inserts one system "Payment confirmed" timeline event the first time a reference is paid (both in `/verify` and the webhook handler). Adds a small `isNewReference()` helper.
- `scripts_migrate.js.diff` — applies to `scripts/migrate.js`. After applying `supabase/schema.sql`, it now also applies every `*.sql` file in `supabase/migrations/`, in filename order. Idempotent, safe to re-run.
- `package.json.diff` — adds the `bcryptjs` dependency and `migrate` / `create-agent` npm scripts.
- `env.example.diff` — documents the new `AGENT_JWT_SECRET` var.
- `render.yaml.diff` — adds `AGENT_JWT_SECRET` to the Render env var list (still `sync: false` — set the real value in the Render dashboard).

## 3. Run the migration

Pick whichever you already use:

- **Supabase SQL editor**: paste `supabase/schema.sql` (if not already applied), then `supabase/migrations/002_agent_dashboard.sql`.
- **Direct Postgres** (`DATABASE_URL` set): `npm run migrate` — now applies schema.sql + everything under `supabase/migrations/` automatically.

## 4. Set the new env var

```
AGENT_JWT_SECRET=<openssl rand -hex 32>
```

Must be **different** from `APP_JWT_SECRET` — that's what keeps a customer's session token from ever being usable on an agent route, or vice versa. Until this is set, every `/api/v1/agent/*` route returns `501`.

## 5. Provision your first agent

No self-signup route exists on purpose — this is an internal tool.

```
npm install          # picks up bcryptjs
node scripts/create-agent.js --email agent@company.com --name "Ada Agent" --password "correct-horse-battery-staple"
```

Then log in as that agent:

```
POST /api/v1/agent/auth/login
{ "email": "agent@company.com", "password": "correct-horse-battery-staple" }
→ { "token": "...", "agent": { "id", "email", "fullName", "role" } }
```

Use that token as `Authorization: Bearer <token>` on every `/api/v1/agent/*` request.

## 6. Sanity check

```
node -c server.js
node -c src/routes/payments.js
npm start
curl http://localhost:4000/health
curl http://localhost:4000/api/v1/agent/orders          # → 401, missing auth header — expected
```

## Full new endpoint list

- `POST /api/v1/agent/auth/login`
- `GET  /api/v1/agent/auth/me`
- `GET  /api/v1/agent/orders?status=&search=&page=&limit=`
- `GET  /api/v1/agent/orders/:id`
- `PATCH /api/v1/agent/orders/:id`
- `POST /api/v1/agent/orders/:id/timeline`
- `POST /api/v1/agent/orders/:id/items`
- `DELETE /api/v1/agent/orders/:id/items/:itemId`
- `GET  /api/v1/agent/customers?search=`
- `GET  /api/v1/agent/customers/:id`

Valid `status` values: `AGENT_REVIEWING`, `SOURCING`, `ORDERED`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED`, `REFUNDED`.