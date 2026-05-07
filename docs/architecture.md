# Architecture

ProAppStore runs as a **single control plane composed of three Cloudflare
Workers**. Apps published on the platform — Tailored or Ready — talk to
the control plane the same way; the only difference is what `fas/admin`
provisions on publish and which SDK helpers the publisher emphasizes.

## Components

```text
Browser / app                ┌──────────────────────────────────────┐
  ├── @freeappstore/sdk ───→ │  fas Worker (api.freeappstore.online)│
  │                          │  identity, sessions, KV, rooms       │
  │                          │  publish endpoint, registry, R2 backups
  │                          │  service binding ──→ fas/admin       │
  │                          └──────────┬───────────────────────────┘
  │                                     │ service binding
  │                                     ▼
  │                          ┌──────────────────────────────────────┐
  │                          │  fas/admin Worker                    │
  │                          │  GitHub repo + Pages + DNS provision │
  │                          │  (Tailored: also provisions D1)      │
  │                          └──────────────────────────────────────┘
  │
  └── @proappstore/sdk ────→ ┌──────────────────────────────────────┐
                             │  pas Worker (api.proappstore.online) │
                             │  Stripe checkout + portal + webhook  │
                             │  entitlements, license keys          │
                             │  premium primitives                  │
                             └──────────────────────────────────────┘
```

### 1. `fas` Worker — identity & app primitives

Lives at `api.freeappstore.online`. Source: `~/personal/fas/sdk/packages/backend`.

- **Identity:** GitHub OAuth (device flow for CLI, web flow for browser).
  HMAC-signed sessions with `SESSION_SIGNING_KEY`, 30-day TTL.
- **Per-user KV:** namespaced storage every app can use.
- **Rooms:** Durable Objects with WebSocket fan-out for cursors / presence
  / lightweight multiplayer.
- **Publish:** `POST /v1/publish` — validates the request, calls
  `fas/admin` via service binding.
- **Registry:** the storefront's source of truth; reads/writes the
  `registry.json` in the storefront repo.
- **Backups:** R2 bucket `fas-backups`, written daily by a cron at
  04:00 UTC.
- **Crons:** uptime checks every 15 min, daily backup, weekly
  compliance audit (Sun 06:00 UTC).

### 2. `pas` Worker — payments & entitlements

Lives at `api.proappstore.online` (custom domain pending). Source:
`~/personal/proapps/sdk/packages/backend`. **v0 skeleton.**

- **Stripe webhook receiver** — `subscription.created`, `updated`,
  `deleted`, `invoice.paid`, `customer.subscription.trial_will_end`.
- **Checkout & portal redirects** — open Stripe Checkout for a price,
  open the customer portal for an existing subscription.
- **Entitlements** — `subscriptions` table in PAS D1 keyed by
  `(appId, userId)`; the SDK reads `tier`, `priceId`, `currentPeriodEnd`.
- **License keys** — for offline / non-subscription paid features.
- **Session validation** — verifies the HMAC session minted by `fas`.
  Same `SESSION_SIGNING_KEY`. No second login.

D1 binding: `pas` (not yet created). Migrations directory under
`packages/backend/migrations`.

### 3. `fas/admin` Worker — provisioning

Lives at `admin.freeappstore.online`. Source: `~/personal/fas/admin`.

`POST /api/provision` is the only mutating endpoint. Given an app id,
name, category, and store, it creates:

| Step | Action | Tailored | Ready |
|---|---|---|---|
| 1 | GitHub repo | yes (per fork) | yes (one for the publisher) |
| 2 | CF Pages project + GitHub integration | yes | yes |
| 3 | Custom domain `<id>.freeappstore.online` | yes | yes |
| 4 | DNS CNAME | yes | yes |
| 5 | **D1 database** | **yes (per fork)** | no (publisher BYO) |
| 6 | Storefront registry entry | yes | yes |

Step 5 is the meaningful branch and the work item that unblocks any
non-toy Tailored template. See [publishing flow](/publishing-flow).

Auth: Cloudflare Access (Google sign-in for humans, service tokens for
the `fas` Worker's service binding — service-binding calls bypass the
edge entirely so they bypass CF Access too).

## Why one control plane

Identity, registry, billing, provisioning, and entitlements are the same
problem regardless of whether an app is Tailored or Ready. What differs
is *what publishers do with their own app code* — and that lives in the
SDK + CLI scaffolds, not in a separate backend. Adding a fourth Worker
per category would be over-engineering. See
[ADR-003](/adr/003-one-control-plane).

## Service binding pattern

The `fas` Worker holds a service binding (`env.ADMIN.fetch(...)`) to
`fas/admin`. Worker-to-worker calls bypass the public edge — no CF
Access prompt, no edge loop detection, no service token to rotate. Both
Workers are trusted internal.

## Database

| DB | Worker | Purpose |
|---|---|---|
| `fas` (D1) | `fas` | users, sessions, app primitives (KV, rooms metadata), registry mirror |
| `pas` (D1) | `pas` | subscriptions, license keys, entitlement audit |
| per-fork D1 | the forked Tailored app's Pages Functions | the app's own data |

No shared database between the Workers. They communicate over service
bindings or HTTP.

## What this doesn't include

- A multi-tenant data layer for Ready apps. Ready publishers BYO storage.
  The platform offers identity + Stripe + registry; it doesn't dictate
  how a Ready app stores its own data.
- A workflow / rules engine. Per-app business logic is per-app code.
- An admin UI for structural config. Source-code customization with AI
  is the customization story (see [tailored vs ready](/tailored-vs-ready)).
