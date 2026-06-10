# Stripe & entitlements

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

For one-time payments, offline use, or non-subscription paid features:

```ts
const key = await pas.licenseKey.mint({
  appId: 'pipeline',
  email: 'customer@example.com',
  metadata: { tier: 'lifetime' },
});

const valid = await pas.licenseKey.validate(key);
// { ok: true, appId, email, metadata, mintedAt, revokedAt? }
```

License keys are signed JWTs with a server-side revocation list in D1.
Validation works offline (signature check) but the most authoritative
answer comes from the Worker (which checks revocation).

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

Migrations land in `packages/backend/migrations/000N_*.sql`.

## Webhook events handled

| Event | Action |
|---|---|
| `checkout.session.completed` | upsert subscription, set tier, current_period_end |
| `customer.subscription.updated` | update tier / period / cancel flag |
| `customer.subscription.deleted` | mark inactive |
| `invoice.paid` | extend current_period_end |
| `invoice.payment_failed` | flag past_due, optionally email customer |
| `customer.subscription.trial_will_end` | optional notification |

Webhook signature verification uses `STRIPE_WEBHOOK_SECRET`. Idempotency
keys prevent duplicate processing.

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
