# ADR-002: Tailored vs Ready as the platform's two app categories

## Status

Superseded in part by the PAS-owned provisioning cleanup. The two-category
decision still stands, but provisioning now happens through
`api.proappstore.online` `POST /v1/provision`, not
`fas/admin/POST /api/provision`. See [Tailored vs Ready](/tailored-vs-ready)
and [Publishing flow](/publishing-flow).

## Date

2026-05-08

## Context

Early conversations about ProAppStore framed it as a single platform
shape: a Stripe-enabled fork-and-customize model akin to FreeAppStore.
That framing fits B2B back-office products (CRM, PSA, helpdesk, ATS,
LMS) where each customer's process is their competitive moat and source-
code customization is the value.

But many products people want to build don't fit that shape. Marketplaces
(events, listings), coordination tools (scheduling, light social), and
narrow-canvas creation tools depend on **everyone being on the same
shared deployment** — network effects, content libraries, cross-org
features only work that way. Trying to fork them breaks the product.

The platform needs to decide whether to:

1. Reject those products (only host fork-and-customize apps).
2. Build them as a different platform.
3. Host both shapes under one storefront, with clearly different
   architectural rails per shape.

## Decision

Adopt **two named categories** with first-class support across the
storefront, SDK, CLI, and provisioning:

- **Tailored** — one forked, deployed instance per customer.
  Customization in source code with AI pairing. The publisher ships a
  starting point; variation is the value.
- **Ready** — one shared deployment per publisher, multi-tenant.
  Customers sign up to the same product. Standardization is the
  feature.

Storefront, identity, billing, registry, and SDK packages are shared.
The split shows up in:

- A `category` flag on each registry entry.
- Two code paths in `fas/admin/POST /api/provision` (Tailored
  provisions a per-fork D1; Ready does not).
- Two `pas init` template starting points.
- Two listing-page templates on the storefront.

Class A products at scale (Uber, Slack, Figma, Notion, Miro) are
**out of scope on purpose**. Hosting those well requires generic SaaS
infrastructure that isn't this platform's bet.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Tailored only (reject Ready) | Useful Ready-shaped products exist (events, scheduling, light social) and benefit from the same identity + Stripe rails. Refusing them shrinks the addressable catalog with no architectural payoff. |
| Ready only (reject Tailored) | The AI-first, fork-and-customize bet is the platform's distinctive thesis. Removing it makes the platform a generic Stripe-enabled SaaS host competing with Vercel, Render, Lovable, etc., on infrastructure rather than philosophy. |
| Both shapes with no labels | Customers and publishers would have to infer the model from each app's listing page. The mismatch ("I thought I could fork this") creates support load and erodes trust. Naming the shape up front is the cheapest fix. |
| Two separate platforms (proappstore.online for Ready, fork.proappstore.online for Tailored) | Doubles operational complexity (two storefronts, two registry repos, two publisher dashboards) for marginal architectural benefit — the underlying control plane is shared anyway. |

## Consequences

**Positive:**
- Clear contract per category. Publishers and customers know what they
  get. Fewer surprises.
- Catalog grows in two directions without architectural coupling.
- The CRM-style philosophy (file-size discipline, no admin UI for
  structural config, six-test config rule) becomes the canonical shape
  for **every** Tailored template, not just the CRM.
- Lets the Salesforce-like services market form around Tailored
  templates (consultants per template).

**Negative:**
- Two listing-page templates and two provisioning code paths to maintain.
- Storefront search needs to handle "I want a CRM" matching both a
  Tailored CRM template and a Ready CRM app — a UX choice (filter,
  default-to-one, show-both).
- Marketing has to communicate the two shapes clearly, twice.

**Neutral:**
- The naming pair (Tailored / Ready) is a label on a registry entry and
  can be revisited cheaply if usage data points to a better pair.
