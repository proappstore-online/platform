---
description: "Any PAS app can sell its own products through the platform's Stripe account: declare them in mcp.json, the platform creates the Stripe objects and runs app-authorized checkout."
---

# App billing

Part of epic #506. An app declares the products it sells in `mcp.json`. The platform creates the matching Stripe objects
and runs Checkout on its own Stripe account. The app holds no Stripe key and runs no webhook receiver.

!!! warning "What exists today"
    Declaring products, the Stripe sync, app-authorized checkout (#507) and entitlements from Stripe's webhooks (#508) are built. The
    SDK call, customer portal, CLI and the admin switch's API are not (#509). Checkout is **refused for every app** until an admin
    enables billing for it, and that switch is a database flag until #509. Do not enable it for an app that takes real money before a
    live test of the whole flow: it has only been exercised against signed test payloads and a mocked Stripe client.

## Declaring products

```json
{
  "tools": [
    {
      "name": "may_buy",
      "description": "May this user buy this product for these subjects",
      "operation": "query",
      "requires_auth": true,
      "callers": ["billing"],
      "params": { "product": { "type": "string" }, "subjects_json": { "type": "string" } },
      "sql": "SELECT 1 AS allowed FROM guardians WHERE user_id = :__user_id AND ..."
    }
  ],
  "billing": {
    "authorize_action": "may_buy",
    "products": [
      {
        "key": "child_term",
        "name": "Chess Academy term (per child)",
        "amount": 1000,
        "currency": "aud",
        "tax_behavior": "inclusive",
        "modes": ["one_time", "recurring"],
        "interval": { "unit": "month", "count": 3 },
        "grace_days": 5,
        "subject": "required"
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `key` | The product's id inside the app: lowercase letters, digits, underscores, starting with a letter, at most 40. Another app's key is never valid here. |
| `name` | Shown in Stripe and on Checkout (at most 100 characters). |
| `amount`, `currency` | Whole number of the currency's smallest unit (cents). `aud`, `cad`, `chf`, `eur`, `gbp`, `jpy`, `nzd`, `sgd`, `usd`. |
| `tax_behavior` | `inclusive`, `exclusive` or `unspecified` (default), passed to Stripe unchanged. |
| `modes` | `one_time` and/or `recurring` (default `["one_time"]`). A buyer chooses with `renew`. |
| `interval` | `{ unit: day / week / month / year, count }`. Required to recur. Stripe's ceiling is one year (day 365, week 52, month 12, year 1). A one-off product may name its period too. |
| `grace_days` | 0 to 30, default 0. Used by entitlements (#508). |
| `subject` | `required` (a checkout names what is being bought for) or `none` (default). |

Registration validates all of this and refuses a malformed section with a 400. Up to 20 products per app.

### The authorize action

`billing.authorize_action` is required whenever products are declared: nothing is sold without an app-side decision about who
may buy. The action is checked at registration:

- `callers` is exactly `["billing"]`: no session, worker or hook can call it, and MCP does not list it;
- a `query` that requires auth, uses `:__user_id` and selects an `allowed` column;
- its params may be only the strings `product` and `subjects_json` (a JSON array of the subject ids).

An app that lets everyone buy writes a query that says so. The app's own SQL is where rules such as "the buyer is a guardian
of every child" live.

## What happens on deploy

The platform records the products, then creates in Stripe, once:

- a **Product** per product, with `app_id` and `product_key` in its metadata;
- a **Price** per mode: recurring prices carry `interval` and `interval_count`; `tax_behavior` is passed through.

Re-deploying with nothing changed makes **no Stripe call**. A changed amount, currency, tax behaviour or interval creates a **new
Price** and archives the old one; Prices are immutable in Stripe and an old receipt must keep resolving. Nothing is deleted. A
product the manifest stops declaring is deactivated: it can no longer be bought, and its Stripe objects and purchases stay.

If Stripe is unreachable, the deploy still succeeds with a warning, the failure is kept on the product, and the next deploy retries.

## Checkout

`POST /v1/apps/:appId/billing/checkout`, signed in, JSON body:

```json
{ "product": "child_term", "subjects": ["kid-a", "kid-b"], "renew": false,
  "successUrl": "https://chess.example/thanks", "cancelUrl": "https://chess.example/" }
```

It returns `{ "url": "<Stripe Checkout>", "purchaseId": "…" }`; send the buyer to `url`. Checks run in this order, and **every one
that can refuse does so before Stripe is called**:

| # | Check | Refusal |
|---|---|---|
| 1 | signed in; the app exists and is visible to the user | 401 / 404 |
| 2 | billing is enabled for the app (an admin's switch, **off by default**) | 403 |
| 3 | `product` is one of this app's active products | 400 `unknown product` |
| 4 | `subjects`: a non-empty list for `subject: "required"` (at most 50, each at most 128 characters, no repeats), none for `subject: "none"` | 400 |
| 5 | `renew: true` needs `recurring` in `modes`, `renew` absent or false needs `one_time` | 400 |
| 6 | `successUrl` and `cancelUrl` are on the app's own origins (below) | 400 |
| 7 | the product has an active price | 503 |
| 8 | the app's authorize action returns **exactly one row with `allowed = 1`**; anything else, or a failure to run it, refuses | 403 / 502 |

Then the platform writes a `pending` purchase (app, product, buyer, subjects, quantity, mode, Stripe price), and creates one
Stripe Checkout session: `quantity` is the number of subjects (1 for a product with none), `mode` is `payment` or `subscription`
from `renew`. The session, and the payment or subscription it creates, carry `app_id`, `product_key`, `user_id` and `purchase_id`
in metadata. **Subjects are app data and stay on the platform's purchase row; they are never sent to Stripe.**

A buyer has one Stripe Customer across every app: the platform's, else the one an earlier Pro subscription made, else a new one.

### Redirect URLs

Only the app's own origins: its `<app>.proappstore.online` subdomain and any subdomain of it, its **active** custom domains and their
subdomains, and `localhost`. HTTPS only (localhost may use HTTP), no credentials in the URL. A pending custom domain, another app's
domain and look-alikes such as `club.proappstore.online.evil.example` are refused.

## Entitlements

A purchase becomes one **entitlement** per (product, subject): `active`, `grace`, `expired`, `refunded` or `canceled`, with
`period_end`, `grace_until` and `renews`. A product with no subject has a single entitlement under the empty subject `''`.

The platform receives Stripe's signed webhooks, tells an app's events apart by the `app_id` in their metadata (the Pro events keep their
own path), and records what each event says. The entitlement is **computed from all the recorded facts every time**, never edited by an
event, so replaying an event changes nothing, and events delivered in any order end in the same state.

| Stripe event | Effect |
|---|---|
| `checkout.session.completed` | a paid one-off checkout is a payment of one term, for every subject it covered. A subscription is entitled by its invoices, not by the session |
| `invoice.paid`, `invoice.payment_succeeded` | a payment of one interval, one per invoice id however many times it is reported |
| `invoice.payment_failed` | `grace` until `period_end + grace_days`, then `expired`; a later payment clears it |
| `customer.subscription.updated` | `cancel_at_period_end` switching on stops renewal but keeps the paid period; switching off restores it; an ended status is final. The newest event wins, by Stripe's own event time |
| `customer.subscription.deleted` | `canceled` |
| `charge.refunded` | `refunded` at once, when the charge is refunded **in full** |

A payment buys one interval from the **previous `period_end`** (a renewal bought early does not lose the days left), or from the payment
if the entitlement had lapsed. A purchase for three subjects makes three entitlements and a renewal extends all three. The term
(interval and grace) is the one the buyer was sold at checkout, whatever the manifest says later.

Stripe sends no event when a one-off term ends or a grace period runs out, so every platform tick (five minutes) a **sweep** moves them on:
a one-off or non-renewing term at `period_end`, a grace period at `grace_until`. A renewing subscription just past `period_end` stays
`active` for three days, waiting for Stripe's own `invoice.paid` or `invoice.payment_failed`, then expires.

Limits worth knowing: a **partial refund** names no subject, so it changes no entitlement (handle it in Stripe or by hand). A refund of a
charge made by a **subscription invoice** carries none of our metadata and is not yet resolved to its purchase. Payments made with a
method that confirms later (`async_payment_succeeded`) are not handled yet.

### Reading entitlements in your SQL

The platform keeps a read-only copy in **your app's own database**, in a table it creates and maintains:

```sql
_pas_entitlements(product, subject, status, period_end, grace_until, renews, buyer_user_id, version, updated_at)
-- primary key (product, subject); times in milliseconds
```

Your registered actions can `SELECT` and `JOIN` it, so the paywall is enforced in the same SQL as everything else:

```sql
SELECT c.* FROM children c
  JOIN _pas_entitlements e ON e.product = 'child_term' AND e.subject = c.id
 WHERE c.family_id = :family AND e.status IN ('active', 'grace')
```

Treat `grace` as still allowed, and show the buyer that payment is failing. **A forged client payload grants nothing**, because the table
is written only by the platform.

**Apps cannot write `_pas_*` tables.** Registration refuses an action whose SQL writes one, the migration lint refuses a migration that
creates, alters, writes or drops one, and your data worker refuses raw SQL from an owner session that does (reading is fine). A table whose
name starts with `_pas_` is reserved. The data worker's own check applies when that worker is next deployed (new apps now, existing apps on
the next data-worker redeploy); registration and the migration lint apply immediately.

The copy is pushed after each event and by the sweep. A push that fails (the app's database unreachable) is retried by the sweep, and a
late or repeated push never overwrites newer state (`version`), so the copy can lag Stripe by a few minutes at worst but never goes
backwards. `status` in the copy is the status when it was last written: an entitlement that has just run out is moved on by the next sweep.

The Pro subscription endpoints (`/v1/checkout`, `/v1/portal`, `/v1/pricing`) are separate and unchanged.
