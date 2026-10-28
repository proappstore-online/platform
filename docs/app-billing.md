---
description: "Sell your app's own products through the platform's Stripe account: declare them in mcp.json, authorize purchases in SQL, and let checkout run through POST /v1/apps/:appId/billing/checkout."
---

# App billing

Any PAS app can sell its **own products** through the platform's single Stripe account. The app
declares them in `mcp.json`; the platform creates the Stripe Products and Prices when the manifest
deploys and runs Checkout. The app holds no Stripe key and runs no webhook receiver.

This is the first slice of epic #506 (#507): declaring products, the deploy-time Stripe upsert and
app-authorized checkout. Webhooks, per-subject entitlements and the `_pas_entitlements` table
(#508), and the SDK client, portal, CLI and revenue ledger (#509) follow. It extends
[ADR-004](./adr/004-stripe-via-pas.md) to app-defined products without Stripe Connect. The $5 Pro
subscription (`/v1/checkout`, `/v1/portal`) is a separate flow and is unchanged.

## Declare products

```json
{
  "tools": [
    {
      "name": "billing_can_buy",
      "description": "May this buyer buy this product for these subjects",
      "operation": "query",
      "requires_auth": true,
      "callers": ["billing"],
      "params": { "product": { "type": "string" }, "subjects_json": { "type": "string" } },
      "sql": "SELECT EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = :__user_id AND NOT EXISTS (SELECT 1 FROM json_each(:subjects_json) s WHERE s.value NOT IN (SELECT child_id FROM guardians WHERE user_id = :__user_id))) AS allowed"
    }
  ],
  "billing": {
    "authorize_action": "billing_can_buy",
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

| Product field | Meaning |
|---|---|
| `key` | `[a-z][a-z0-9_]{0,39}`, unique in the app. Stored as Stripe metadata `product_key`. |
| `name` | Shown on the Stripe Checkout page. |
| `amount` | Integer, smallest currency unit (cents), 1 to 99,999,999. No free products. |
| `currency` | Three-letter ISO 4217 code. |
| `tax_behavior` | `inclusive`, `exclusive` or `unspecified` (default). Passed to Stripe on the Price. |
| `modes` | `one_time`, `recurring`, or both (default `["one_time"]`). `recurring` is what a buyer's `renew: true` selects. |
| `interval` | `{ unit: day\|week\|month\|year, count }`. Required with `recurring`: it is the Stripe billing interval. For a one-off purchase it is the term a payment covers (used by #508). |
| `grace_days` | 0 to 30, default 0. How long after a failed renewal the entitlement stays usable (applied by #508). |
| `subject` | `required` (the buyer names what they buy for, one unit each) or `none` (default). |

Registration (`PUT /v1/apps/:appId/tools`, so `pas publish` and the deploy workflow) refuses an
invalid `billing` section with a 400 and writes nothing. `pas check` runs the same validation as the
`Billing products` check.

### The authorize action

`billing.authorize_action` names a registered **query** action that lists `"billing"` in its
`callers`. Only the platform's checkout runs it: users and MCP cannot call it, and it must not also
list `worker` or `hook`. It must require auth, cannot be scheduled or role-gated (a buyer holds no
role yet), and must declare the string params `product` and `subjects_json`.

It runs with `:__user_id` set to the buyer, `:product` and `:subjects_json` (a JSON array of the
subject ids). Checkout proceeds only if it returns **exactly one row whose `allowed` is `1`**. Any
other result is a 403; a failure to run it is a 502. That is where the app enforces its own rules
("the buyer is a guardian of every child and the family is in paid mode"). Nothing the browser sends
grants a purchase.

## What deploy does in Stripe

After the manifest registers, the platform upserts, per active product:

- one Stripe **Product** with metadata `app_id` and `product_key`;
- one **Price** per mode: a one-time Price, and a recurring Price with `interval` and
  `interval_count`, both carrying `tax_behavior` and the same metadata.

It is idempotent. A redeploy with the same definition makes no Stripe write. Stripe Prices are
immutable, so a changed amount, currency, tax behaviour or interval creates a **new Price** (the next
version), makes it current and **archives** the old one; existing subscribers keep their old Price. A
renamed product is renamed in Stripe. **Nothing is ever deleted**, and a product removed from the
manifest is only marked inactive (checkout refuses it) without any Stripe call.

A Stripe problem never fails the deploy. It is reported as a `billing:` entry in the response
`warnings[]`, and the next deploy retries. Without `STRIPE_SECRET_KEY` the products register but
nothing is created, with a warning.

## Checkout

`POST /v1/apps/:appId/billing/checkout`, signed in, body:

```json
{ "product": "child_term", "subjects": ["child-1", "child-2"], "renew": true,
  "successUrl": "https://chessclubs.online/paid", "cancelUrl": "https://chessclubs.online/cart" }
```

Returns `{ "url": "<Stripe Checkout URL>", "purchaseId": "…" }`; send the browser there.

- `quantity` is `subjects.length` (1 for a `subject: "none"` product). Subjects are opaque ids from
  the app; the platform never interprets them and **never sends them to Stripe**. They are stored on
  the `purchases` row.
- `renew: true` buys the recurring Price in Stripe `subscription` mode; `false` (default) buys the
  one-time Price in `payment` mode. A mode the product does not list is a 400.
- The Stripe session and the subscription or payment intent carry metadata `app_id`, `product_key`,
  `user_id` and `purchase_id`. A `purchases` row with status `pending` is written first; #508
  advances it from the webhooks.
- One Stripe Customer per platform user (the Pro customer is reused when there is one).

| Status | When |
|---|---|
| 400 | unknown product (including another app's key), empty or repeated subjects on a `subject: "required"` product, subjects on a subject-less one, a mode the product lacks, malformed body, a redirect URL outside the app's origins |
| 401 | not signed in |
| 403 | the authorize action did not return exactly one row with `allowed = 1` |
| 502 | the authorize action or Stripe failed (nothing is granted) |
| 503 | billing not configured, or the product has no Stripe Price yet (redeploy) |

The order is fixed: validation, then the authorize action, then Stripe. **No Stripe call happens
before authorization allows it.**

### Redirect URLs

`successUrl` and `cancelUrl` must be https on one of **that app's** origins: its
`<app>.proappstore.online` subdomain, an **active** (verified) custom domain or any subdomain of one,
or `http(s)://localhost` / `127.0.0.1` for development. Another app's subdomain is refused, as are
credentials in the URL. (The Pro flow keeps its own, wider allow-list.)

## Data model

Migration `0118_app_billing.sql`, all additive: `app_billing` and `app_products` (the declaration,
replaced with the manifest), `app_product_prices` (Stripe Price ids, versioned, with active and
archived flags), `purchases` (app, product, buyer, `subjects` JSON, quantity, mode, status,
Stripe session / customer / subscription ids) and `billing_customers`.

## Testing

All tests use a mocked Stripe client and signed test payloads. No live keys are needed. Live
enablement per app (`billing_enabled`) arrives with #509.
