# ADR-001: Cloudflare Workers + D1 only, no Firebase

## Status

Accepted

## Date

2026-05-08

## Context

ProAppStore needs an identity layer, payments layer, registry, and per-app
data plane. Earlier infrastructure documentation in
`~/personal/fas/ops/INFRASTRUCTURE.md` described a path where "connected
apps" would share a Firebase backend (Firestore + Auth + Cloud Functions).
That path was never implemented; the actual SDKs in
`~/personal/fas/sdk/packages/backend` and
`~/personal/proapps/sdk/packages/backend` shipped on **Cloudflare Workers
+ D1 + Durable Objects + R2**, with Stripe added on the pro side.

The choice needs to be recorded explicitly so future contributors don't
re-litigate it from a stale doc.

## Decision

ProAppStore is **Cloudflare-only** for backend infrastructure. No
Firebase. No alternative cloud. Specifically:

- **Compute:** Cloudflare Workers (and Pages Functions, which run on the
  same workerd runtime).
- **Database:** D1 (SQLite-on-the-edge). One DB per concern: `fas`, `pas`,
  per-fork DBs for Tailored apps.
- **Realtime / multiplayer:** Durable Objects, sized for cursors /
  presence / lightweight rooms.
- **Object storage:** R2 (daily backups).
- **Identity:** GitHub OAuth, Google OAuth, credential accounts, and
  PAS-owned HMAC-signed sessions.
- **Payments:** Stripe (Checkout + Portal + webhook).
- **Hosting for apps:** Cloudflare Pages with custom subdomain.

Adding a new third-party SaaS dependency (cloud or otherwise) requires
its own ADR.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Firebase (the older `ops/INFRASTRUCTURE.md` plan) | Would split the platform across two clouds with different runtime models. Firestore's multi-tenant rules system is good for some shapes but ill-fitted to per-fork Tailored apps where each customer has their own DB. The free SDK already shipped on D1 + DO and works well. |
| Supabase | Postgres is heavier than needed for the per-fork Tailored case. Would also reintroduce a separate auth system to reconcile with our HMAC sessions. |
| AWS Lambda + RDS / DynamoDB | Cross-cloud complexity, no equivalent of CF Pages + Worker co-deploy, no equivalent of Durable Objects without bolting Redis or similar. |
| Self-hosted Postgres + Node | Operationally heaviest; gives up the edge runtime entirely. |

## Consequences

**Positive:**
- One vendor, one runtime, one billing surface. Smaller surface area for
  bugs, security issues, and operational complexity.
- D1 is fast enough and small enough that per-fork DBs are tractable —
  the central enabler for the Tailored category.
- Stack matches the Rocket Lab CRM (`~/work/crm`), which means CRM-shaped
  templates port without a data-layer rewrite.
- Workers, Pages, D1, DO, R2, Queues, Durable Objects all share the same
  bindings model — service bindings are cheap and bypass the public edge.

**Negative:**
- Vendor concentration risk. If Cloudflare has an extended outage,
  everything is down at once.
- D1 has lower per-row write throughput than Postgres under heavy
  contention; some Ready apps may need to BYO Postgres / Postgres-flavored
  storage (allowed; the platform doesn't dictate Ready DB).
- Workers' wall-time and request limits cap some compute shapes (long
  video transcodes, heavy ML inference). Apps needing those route to
  external services or Cloud Run-style compute (publisher's BYO).

**Neutral:**
- The earlier Firebase reference in `ops/INFRASTRUCTURE.md` is stale and
  should be updated or deleted in a follow-up.
