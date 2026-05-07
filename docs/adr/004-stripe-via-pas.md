# ADR-004: Stripe (not Paddle / Lemon Squeezy / Polar) via the pas Worker

## Status

Accepted

## Date

2026-05-08

## Context

The pro side's defining feature is **paid app behavior**: subscriptions,
license keys, entitlements. The platform needs a single payments
provider so the pro SDK can offer a coherent API across all paid apps,
regardless of category.

Several alternatives exist (Paddle, Lemon Squeezy, Polar, native CF
Workers payment integrations, BYO per publisher). The choice has
implications for tax handling, developer ergonomics, payout speed,
international coverage, and the shape of the SDK API.

## Decision

ProAppStore uses **Stripe** as the sole platform-mediated payments
provider:

- Stripe Checkout for subscription start.
- Stripe Customer Portal for self-serve subscription management.
- Stripe webhook receiver in the `pas` Worker for state updates.
- Stripe Connect (deferred — only when the [services
  marketplace](/services-marketplace) reaches Tier 4).

The pro SDK's `pas.subscription` surface assumes Stripe semantics
(prices, customers, subscriptions, invoices). Apps that need a
different provider can BYO at the app level — the platform doesn't
prevent that — but they don't get the platform's billing helpers.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Paddle / Lemon Squeezy (merchant of record) | Tax handling is appealing but the API surface is more constrained for custom pricing logic. Webhook + Customer Portal patterns less rich than Stripe. |
| Polar | Promising for indie/dev tooling but smaller ecosystem; less battle-tested for Tailored shapes. Worth revisiting if Polar matures. |
| BYO per publisher (no platform-mediated payments) | Eliminates the cross-cutting `pas.entitlements` story. Each publisher reinvents the same primitives badly. |
| Multi-provider abstraction (Stripe + others behind one SDK) | Premature. The abstraction would be designed against Stripe-shaped concepts anyway, and adding a second provider is a real cost. Defer to the day a customer credibly asks for it. |

## Consequences

**Positive:**
- One coherent SDK surface. Apps that call `pas.subscription.openCheckout`
  get the same behavior on the platform.
- Stripe's developer ergonomics, webhook reliability, and ecosystem
  (Tax, Radar, Connect, Atlas) are best-in-class.
- Existing CRM uses Stripe in adjacent flows — knowledge transfer is
  free.

**Negative:**
- Vendor lock-in. Migrating off Stripe later is non-trivial.
- Stripe's merchant-of-record story is weak compared to Paddle / LS.
  International tax handling falls on individual publishers (or on
  Stripe Tax, which is opt-in).
- Stripe Connect is required for the platform-mediated services market
  (Tier 4); that's complexity deferred but not avoided.

**Neutral:**
- The `pas` Worker hosts the webhook receiver and the entitlement
  cache. Both are independently testable; both have tight blast radius.
- This decision constrains the SDK shape. If Stripe ever loses its
  position as the obvious default, revisit.
