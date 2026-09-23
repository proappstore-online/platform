# Stripe & entitlements

> **App requirement:** monetisation is the platform subscription and the SDK gates — no per-app checkout or pricing ([PAS-STACK-020](./standard/stack.md#pas-stack-020) in the [Application Standard](./standard/index.md)). This page describes the platform mechanism.

The pro SDK's job is to make a paid app a paid app. Three primitives:
**subscriptions**, **license keys**, and **entitlements**. All backed by
the `pas` Worker and a small D1 schema. **v0 status: skeleton.**

## Subscriptions

Standard Stripe-backed subscriptions. The pro SDK exposes:

```ts
await pas.subscription.openCheckout({
  priceId: 'price_xxx',
  successUrl: '/billing/success',
  cancelUrl: '/billing/cancel',
});

const status = await pas.subscription.status();
// { tier: 'pro' | 'free', priceId, currentPeriodEnd, cancelAtPeriodEnd }

await pas.subscription.openPortal();
// redirects to Stripe Customer Portal
```

Behind these calls:

1. The browser calls `pas` Worker (`POST /v1/checkout`).
2. `pas` validates the PAS session locally with its own `SESSION_SIGNING_KEY`.
3. `pas` calls Stripe to create a Checkout session, returns the URL.
4. After payment, Stripe fires `checkout.session.completed` →
   `pas` webhook → upserts `subscriptions` row.

## License keys

A per-app key the user can present outside the browser session (a CLI, a
desktop companion, a server-side check). It is **not** a separate product:
entitlement follows the platform subscription.

```ts
const license = await pas.license.issue();
// { key, appId, issuedAt, expiresAt } — 200 if one already exists, 201 if minted
// throws `license.issue failed: 403` when the subscription is not active

const mine = await pas.license.current();   // null when none
const ok = await pas.license.validate(key); // no auth — for the thing holding the key
await pas.license.revoke();                 // leaked key; issue() mints a replacement
```

Rules the Worker enforces (`routes/license.ts`, #86):

- **Issue** requires an active subscription and is idempotent: the live key is
  returned, never replaced. Keys are 256 random bits (base64url, 43 chars).
- **Validate** joins `subscriptions` and only answers `{valid: true}` while the
  owner's status is `active` — cancel or `past_due` and every key the user
  holds stops validating, with no webhook work needed. It is unauthenticated,
  so every failure is the same bare `{valid: false}`, and it is throttled at
  10 attempts per minute per caller + app (429, not `valid:false`).
- **Revoke** is for a key that leaked while the subscription is still active,
  which the join cannot catch. Revocation is permanent.

## Entitlements

Entitlements is the cross-cutting question: *can this user use this
feature right now?* Answer is computed from subscription state +
license keys + per-app rules:

```ts
const entitled = await pas.entitlements.check({
  feature: 'realtime-rooms',
  quota: 'rooms-per-month',
});
// { ok: true } | { ok: false, reason: 'tier-too-low' | 'quota-exceeded' | 'no-license' }
```

The pro SDK ships a small set of canonical features and quotas; apps can
register their own.

## D1 schema (planned)

```sql
CREATE TABLE subscriptions (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  price_id TEXT,
  tier TEXT,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE license_keys (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  email TEXT,
  metadata TEXT,
  minted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE entitlement_audit (
  ts INTEGER NOT NULL,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT
);
```

Migrations land in the repo-root `migrations/000N_*.sql` (wired to the backend
via `migrations_dir = "../../migrations"` in `packages/backend/wrangler.toml`).

## Webhook events handled

| Event | Action |
|---|---|
| `checkout.session.completed` | upsert subscription, set `status='active'`, `tier='pro'` |
| `customer.subscription.updated` | update status / price_id / period / cancel flag (reads `current_period_end` from `items.data[0]` first, falls back to the legacy top-level field) |
| `customer.subscription.deleted` | mark `status='canceled'`, `tier='free'` (terminal) |
| `invoice.payment_failed` | mark `status='past_due'` |

`invoice.paid` and `customer.subscription.trial_will_end` are **not** handled
yet.

Webhook signature verification uses `STRIPE_WEBHOOK_SECRET`. Every handler SETs
absolute state (never increments), so retries are idempotent; `updated` /
`payment_failed` guard on `status != 'canceled'` so an out-of-order event can't
resurrect a canceled subscription.

## Differences between Tailored and Ready

| | Tailored | Ready |
|---|---|---|
| Stripe customer | The fork's deployed app's customer (often = the publisher) | The shared deployment's end user |
| Where Checkout opens | The publisher's fork (or app deployment) | The publisher's shared deployment |
| Entitlement key | `(appId, userId)` of the fork | `(appId, tenantId, userId)` |
| Common pattern | Lifetime license, seat license, low MRR | Recurring subscription per tenant |

The pas SDK doesn't enforce a difference — both shapes use the same
primitives. The publisher chooses what fits their distribution.

## Secrets

Set via `wrangler secret put` in `packages/backend`:

| Secret | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | server-side Stripe API |
| `STRIPE_WEBHOOK_SECRET` | webhook signature verification |
| `SESSION_SIGNING_KEY` | PAS session signing key |

## What's not in v0 skeleton

The structure compiles and exports the right types. Implementations are
mostly TODOs that throw or return typed stubs. Roadmap order, per the
[strategy doc](https://github.com/proappstore-online/platform/blob/main/STRATEGY.md):

1. Stripe webhook receiver (slice 1)
2. D1 schema for `subscriptions` and `license_keys`
3. Entitlement check that gates premium modules
4. License-key mint + validate
5. SDK helpers for the above
