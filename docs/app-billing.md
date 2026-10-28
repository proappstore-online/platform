---
description: "Any PAS app can sell its own products through the platform's Stripe account: declare them in mcp.json, the platform creates the Stripe objects and runs app-authorized checkout."
---

# App billing

Part of epic #506. An app declares the products it sells in `mcp.json`. The platform creates the matching Stripe objects
and runs Checkout on its own Stripe account. The app holds no Stripe key and runs no webhook receiver.

!!! warning "What exists today"
    This page covers the first of three parts (#507): declaring products, the Stripe sync, and **app-authorized checkout**.
    Nothing yet receives Stripe's webhooks, so a completed payment does not yet create an entitlement (#508), and there is no
    SDK call, customer portal, CLI or admin switch (#509). Checkout is therefore **refused for every app** until an admin
    enables billing for it, and a purchase stays `pending`. Do not enable it for an app that takes real money.

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

The Pro subscription endpoints (`/v1/checkout`, `/v1/portal`, `/v1/pricing`) are separate and unchanged.
