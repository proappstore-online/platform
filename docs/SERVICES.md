# PAS Services Marketplace

App-building services through the ProAppStore platform. Developers build apps for clients, charged per prompt.

## Roles

| Role | Who | What they do |
|---|---|---|
| **Developer** | Existing PAS creator with Stripe Connect | Builds apps for clients. Sets their own per-prompt rate. Has a public profile. |
| **Client** | Anyone with a PAS account | Tops up a prepaid balance, hires a dev or posts a request, watches the app get built. |

A user can be both (dev for some projects, client for others). The platform role (`user` / `creator` / `admin`) stays unchanged — this is a new `services` capability layered on top.

## How it works

### Finding a developer

**Browse & hire:** Client visits the developer directory (`proappstore.online/developers`), sees profiles with rate, quality score, avg prompt length, portfolio, and hires directly.

**Post & match:** Client posts a "build request" describing what they want. Developers see the request board and can accept/bid. Client picks a dev.

Both paths create a **service engagement** (the unit of work + billing).

### The engagement

1. Client creates or accepts an engagement with a specific developer
2. Platform verifies client has sufficient balance (≥ dev's per-prompt rate)
3. A project is created in agent-teams (the dev gets a full workspace: Research/Build/Test/Control)
4. Dev and client communicate through a **service chat** (distinct from agent threads)
5. Each **developer message** in the service chat = 1 prompt = 1 charge:
   - Client pays: `prompt_rate_cents` (set by dev)
   - Platform takes: 10% of that
   - Dev receives: 90% of that
6. Client can watch progress (read-only view of the workspace)
7. When the app is done, dev marks the engagement "delivered"
8. Client can rate the dev (quality, communication, speed)

### Per-prompt billing

The billing unit is one developer message (prompt) in the service chat. This is NOT the agent-teams chat — it's a separate channel between the dev and client.

Why per-prompt:
- Transparent: client sees exactly what they're paying for
- Aligned: dev is incentivized to write useful, substantive messages
- Simple: no time tracking, no hourly disputes

**Not** charged: client messages, system messages, agent activity. Only human dev messages.

### Pricing

- Dev sets their rate in cents per prompt (e.g., $0.50 = 50 cents, $2.00 = 200 cents)
- Minimum rate: $0.10 (10 cents)
- Maximum rate: $50.00 (5000 cents) — safety cap
- Platform fee: 10% (deducted from the prompt rate, not added on top)
- Client minimum top-up: $10.00
- Client balance is prepaid — work pauses when balance hits $0

### Developer profile

Visible on the storefront and developer directory:

| Field | Source |
|---|---|
| Name, avatar, bio | PAS user profile (synced from connected GitHub account when available) |
| Per-prompt rate | Set by dev in console |
| Avg prompt length | Computed: mean character count of dev messages across engagements |
| Quality score (0-10) | Computed: LLM-judged quality of dev's prompts (clarity, completeness, helpfulness) |
| Response time | Computed: median time from client message to dev reply |
| Completed engagements | Count of engagements marked "delivered" |
| Portfolio | Apps the dev has built (from registry) |
| Rating | Average client rating (1-5 stars) |
| Badges | `verified-developer`, `top-rated`, `founding-developer` |
| Stripe Connect status | Whether payouts are enabled (hidden if not) |
| Available | Toggle: accepting new clients or not |

### Quality score

Computed periodically (daily cron or on-demand). For each dev:

1. Sample the last N dev messages across engagements
2. Send to an LLM judge with a rubric:
   - **Clarity** (0-10): Is the message easy to understand?
   - **Completeness** (0-10): Does it address what the client asked?
   - **Helpfulness** (0-10): Does it move the project forward?
   - **Professionalism** (0-10): Tone, formatting, no filler
3. Average the dimensions → composite quality score
4. Store on the developer profile

Cost: ~$0.01 per message judged (Haiku). Budget: judge 20 messages per dev per day = $0.20/dev/day.

## Data model

### New D1 tables (on the PAS backend database)

```sql
-- Developer service profiles (extends the existing creator/developer identity)
CREATE TABLE dev_profiles (
  creator_id TEXT PRIMARY KEY,           -- FK to PAS users
  prompt_rate_cents INTEGER NOT NULL DEFAULT 100,  -- cents per prompt
  bio_services TEXT,                     -- services-specific bio (optional, supplements main bio)
  available INTEGER NOT NULL DEFAULT 1,  -- 1 = accepting clients
  quality_score REAL,                    -- 0.0-10.0, LLM-computed
  avg_prompt_length INTEGER,             -- chars, computed
  median_response_time_ms INTEGER,       -- computed
  completed_engagements INTEGER NOT NULL DEFAULT 0,
  avg_rating REAL,                       -- 1.0-5.0, client-submitted
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Client prepaid balances
CREATE TABLE client_balances (
  user_id TEXT PRIMARY KEY,              -- FK to PAS users
  balance_cents INTEGER NOT NULL DEFAULT 0,
  total_deposited_cents INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Balance transactions (deposits + charges, immutable ledger)
CREATE TABLE balance_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                    -- 'deposit' | 'charge' | 'refund'
  amount_cents INTEGER NOT NULL,         -- positive for deposit, negative for charge
  engagement_id TEXT,                    -- NULL for deposits
  stripe_payment_intent_id TEXT,         -- for deposits
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_balance_tx_user ON balance_transactions(user_id, created_at);

-- Build requests (client posts what they want built)
CREATE TABLE build_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  budget_cents INTEGER,                  -- optional budget hint
  status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'accepted' | 'closed' | 'cancelled'
  accepted_by TEXT,                      -- creator_id of the dev who accepted
  engagement_id TEXT,                    -- FK once engagement starts
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_build_requests_status ON build_requests(status);

-- Service engagements (the billable unit of work)
CREATE TABLE engagements (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,            -- creator_id
  project_slug TEXT,                     -- agent-teams project, if created
  build_request_id TEXT,                 -- NULL if direct hire
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'delivered' | 'disputed' | 'cancelled' | 'refunded'
  prompt_rate_cents INTEGER NOT NULL,    -- snapshot of dev's rate at engagement start
  prompts_count INTEGER NOT NULL DEFAULT 0,
  total_charged_cents INTEGER NOT NULL DEFAULT 0,
  total_dev_earned_cents INTEGER NOT NULL DEFAULT 0,
  total_platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_engagements_client ON engagements(client_id);
CREATE INDEX idx_engagements_dev ON engagements(developer_id);

-- Service chat messages (dev ↔ client, separate from agent-teams chat)
CREATE TABLE service_messages (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL,
  sender_role TEXT NOT NULL,             -- 'developer' | 'client' | 'system'
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  charged INTEGER NOT NULL DEFAULT 0,    -- 1 if this message was billed (only dev messages)
  charge_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_service_msgs ON service_messages(engagement_id, created_at);

-- Client ratings of developers
CREATE TABLE engagement_ratings (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  score INTEGER NOT NULL,                -- 1-5
  comment TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ratings_dev ON engagement_ratings(developer_id);
```

## API routes

All under `api.proappstore.online/v1/`:

### Developer profiles
```
GET    /services/developers              -- list available devs (public, with profiles)
GET    /services/developers/:id          -- single dev profile (public)
PUT    /services/profile                 -- create/update own dev profile (auth)
PATCH  /services/profile/availability    -- toggle available/unavailable
```

### Client balance
```
GET    /services/balance                 -- current balance (auth)
POST   /services/balance/deposit         -- create Stripe checkout for top-up (min $10)
GET    /services/balance/transactions    -- ledger (auth)
```

### Build requests
```
POST   /services/requests               -- client posts a request
GET    /services/requests               -- list open requests (dev sees these)
GET    /services/requests/:id           -- single request
POST   /services/requests/:id/accept    -- dev accepts a request → creates engagement
DELETE /services/requests/:id           -- client cancels
```

### Engagements
```
POST   /services/engagements            -- direct hire (client picks a dev)
GET    /services/engagements            -- list own engagements (client or dev)
GET    /services/engagements/:id        -- single engagement
PATCH  /services/engagements/:id        -- update status (deliver, cancel)
POST   /services/engagements/:id/rate   -- client rates the dev
```

### Service chat
```
GET    /services/engagements/:id/messages       -- message history
POST   /services/engagements/:id/messages       -- send message (charges if dev)
```

## Charging flow (per dev message)

```
Client sends message → stored, no charge
Developer sends message →
  1. Check client balance ≥ prompt_rate_cents
     - If insufficient: reject with "insufficient balance" error
  2. Deduct prompt_rate_cents from client_balances
  3. Record in balance_transactions (type='charge')
  4. Increment engagement.prompts_count + total_charged_cents
  5. Credit dev: 90% → engagement.total_dev_earned_cents
  6. Platform fee: 10% → engagement.total_platform_fee_cents
  7. Store the message with charged=1, charge_cents=prompt_rate_cents
  8. At month end: transfer total_dev_earned_cents to dev's Stripe Connect
```

## Console UI

### Client view (new tab or section)
- **Balance:** current balance, top-up button, transaction history
- **My requests:** posted build requests + their status
- **My engagements:** active/past engagements, chat, progress
- **Developer directory:** browse, filter, hire

### Developer view (in existing console)
- **Services profile:** set rate, toggle availability, see stats
- **Open requests:** browse client requests, accept
- **My engagements:** active clients, chat, workspace link
- **Earnings:** per-engagement breakdown, pending payouts

## Build sequence — status

### Phase 1: Profiles + Balance — DONE
1. [x] D1 migrations: `dev_profiles`, `client_balances`, `balance_transactions`
2. [x] API: dev profile CRUD, balance deposit (Stripe checkout), balance read
3. [x] Console: dev profile editor, client balance + top-up
4. [x] Storefront: developer directory with rates + quality scores (`/services`)
5. [x] Auto-seed dev profiles on app publish

### Phase 2: Engagements + Chat — DONE
6. [x] D1 migrations: `build_requests`, `engagements`, `service_messages`, `engagement_ratings`
7. [x] API: build requests CRUD, engagements CRUD, service chat with per-prompt billing
8. [x] Console: engagement view with chat, build requests board, direct hire
9. [x] Balance enforcement: conditional UPDATE prevents overdraft, rate limit (10/min)
10. [x] Security: UNIQUE index prevents deposit double-credit, XSS escaped on storefront

### Phase 3: Quality + Trust — DONE
11. [x] Client ratings: star rating UI + backend, avg_rating computed on dev profile
12. [x] Trust badges: verified-developer (5+ jobs), top-rated (4.5+, 3+ reviews), expert (20+)
13. [x] Stats recomputation endpoint (POST /services/recompute-stats)
14. [ ] Quality score cron (LLM judge on dev messages) — endpoint ready, cron not wired
15. [ ] Avg prompt length + response time — endpoint ready, cron not wired

### Phase 4: Discovery — DONE
16. [x] Build request board (public browse)
17. [x] Developer search + filters (q, minRate, maxRate, minRating, sort)
18. [x] Email notifications (new engagement, new message, request accepted)
19. [x] Earnings dashboard (per-engagement breakdown, Stripe Connect status)
20. [x] My Requests view (client sees own requests with status)

### Remaining
- [ ] Quality score cron job (scheduled Worker that calls /services/recompute-stats + LLM judge)
- [ ] Dev payout cron (transfer total_dev_earned_cents to Stripe Connect at month end)
- [ ] Wire engagement to agent-teams project (needs service binding or API call)
- [ ] Push notifications for new messages (WebPush via existing infrastructure)

## What this doesn't change

- The existing $9/mo subscription model for app users is untouched
- App usage-based creator payouts continue as-is
- Agent-teams (AI agents) remain separate — a dev can use them as tools
- A developer can be both an app creator (subscription revenue) AND a service provider (prompt revenue)
