# Tailored vs Ready

ProAppStore lists two categories of apps. Same storefront, same control
plane, same SDK packages — but a meaningfully different shape per
category. This page is the canonical reference for which is which and why.

## The axis

The dividing line is **who benefits from process variation**:

- **Tailored — variation is the value.** Each customer's process is the
  competitive moat. Standardizing it would erase the differentiation.
- **Ready — variation is the cost.** Customers want everyone on the same
  product so network effects, content libraries, and cross-org features
  work. Standardization is a feature.

Most B2B back-office is Tailored. Most marketplaces and creation tools
are Ready.

## Side-by-side

| | Tailored | Ready |
|---|---|---|
| Customer | Forks the template, AI-pairs it (or hires the publisher) | Buys a finished product, signs in, uses it |
| Deployment | One per customer (forked repo, own subdomain, own D1) | One shared per publisher, multi-tenant |
| Customization | Source code + AI | Settings UI |
| Provisioned by `pas publish` | Repo + Pages + DNS + **D1** + registry | Repo + Pages + DNS + registry |
| SDK emphasis | `@proappstore/sdk` (PAS auth, app data, roles, Stripe, platform services) | `@proappstore/sdk` (PAS auth, Stripe Checkout for end users, multi-tenant entitlements) |
| Publisher revenue | License fee, hosting, customization, support | Subscription, usage, seat-based |
| Platform cut | % on PAS-mediated Stripe transactions | Same |
| Data tenancy | Per fork (each customer has their own DB) | Platform-provided (per-user KV, shared counters, rooms) |
| Scales by | More customers forking | More tenants on one deployment |

## Tailored: domains that fit

B2B back-office where each org's process is the moat:

- Sales pipeline / CRM
- PSA / agency operations
- Quoting & proposals
- Invoicing / AR
- HR / onboarding / leave
- ATS / recruiting
- Helpdesk / support tickets
- LMS / training
- Inventory / WMS
- Field service / dispatch
- Practice management (legal, dental, vet, accounting)
- Property management
- Compliance / audit
- Marketing automation
- Order management
- Subscription billing internals

Plus personal-scale tools where each user wants their own deployed
instance: journals, habit trackers, quiz apps, personal dashboards.

## Ready: domains that fit

Network/marketplace shapes, lightweight coordination, narrow-canvas
creation tools:

- Events / RSVPs (Meetup-shaped)
- Scheduling / booking
- Light social / community
- Lightweight collaborative tools where the canvas is narrow

Out of scope on purpose: full Class A products (Uber, Slack, Figma,
Notion, ClickUp, Miro). Hosting these well requires becoming a generic
SaaS platform, which isn't the bet — see
[ADR-002](/adr/002-tailored-vs-ready-split).

## Why the same SDK packages cover both

`@proappstore/sdk` provides auth, per-user KV, counters, rooms, roles, app data,
Stripe entitlements, license keys, and platform services from PAS-owned APIs.
The difference is *who the customer is*:

- **Tailored:** the customer = the developer who forks. The publisher's
  Pro features sell to that developer (or to whomever the developer
  resells to in their fork).
- **Ready:** the customer = an end user signing up to the publisher's
  shared deployment. Stripe runs against many end users on one app.

Same primitives, different bind site.

## Choosing a category as a publisher

Walk these tests in order; stop at the first yes:

1. Is the customer's competitive moat their process / business logic? → **Tailored**
2. Does the product depend on network effects, shared content, or
   cross-org coordination to be useful? → **Ready**
3. Will customers want to read or modify the source code (with AI help)? → **Tailored**
4. Do you want one deployment that scales to many tenants? → **Ready**
5. Default → **Tailored** (smaller commitment, fewer architectural
   demands, AI-first thesis).

## What's promised in either category

- Same identity model (GitHub OAuth via `fas`, HMAC sessions shared with
  `pas`).
- Same Stripe rails (`pas` Worker, webhook receiver, entitlements).
- Same Cloudflare runtime (Workers + D1 + Pages).
- Same storefront listing.
- Same publisher dashboard.

## What's *not* promised

- A workflow / rules engine for Tailored apps. Code your own.
- A configuration UI for structural changes. Fork + edit + AI is the path.

## Naming alternatives considered

| Pair | Note |
|---|---|
| Tailored / Ready *(chosen)* | Clothing metaphor; ready-made vs tailored |
| Tailored / Stock | "Stock" reads as inventory in some contexts |
| Bespoke / Standard | Slightly fancier register |
| Forge / Live | Cute, less obvious |
| Custom / Cloud | Loses the symmetry |

Naming is a label on a registry entry — easy to revisit if usage data
suggests another pair lands better.
