# ProAppStore Strategy

Working strategy doc. Written 2026-05-08 from a conversation about whether
to port the Rocket Lab CRM into ProAppStore. The doc that came out of it.

## The bet

ProAppStore is the distribution + monetization layer for **AI-first apps**:
apps a developer ships once and a customer (or another developer) shapes to
their needs with an LLM at the keyboard. Forking + AI pairing is the
customization story.

The free side (`fas`) already exists. Pro adds Stripe-backed subscriptions,
license keys, premium primitives. Same Cloudflare Workers + D1 stack.

## Two categories of apps

Not every product is a good fit for the AI-first fork model. Naming the
classes up front lets the storefront, the SDK, and the publisher tooling
treat them as first-class.

### Tailored

Each customer (or each developer-as-customer) gets their own forked,
deployed instance. Customization happens in source code with AI pairing.
The publisher's product is a *starting point*; the variation is the value.

Best-fit domains (B2B back-office, where process is the moat):

- Sales pipeline / CRM
- PSA / agency ops
- Quoting & proposals
- Invoicing / AR
- HR / onboarding / leave
- ATS / recruiting
- Helpdesk / support
- LMS / training
- Inventory / WMS
- Field service / dispatch
- Practice management (legal, dental, vet, accounting)
- Property management
- Compliance / audit
- Marketing automation
- Order management
- Personal-scale tools (journals, habit trackers, quiz apps)

### Ready

One shared deployment per publisher. Many customers sign up to the same
running product. Customization is via settings, not source. Standardization
is a feature: network effects, shared content, cross-org integrations.

Best-fit domains:

- Network/marketplace shapes (events, listings, dispatch)
- Coordination tools (scheduling, lightweight comms)
- Canvas/creation tools when scope is narrow

Out of scope on purpose: full Class A products (Uber, Slack, Figma, Notion).
Hosting those well requires becoming a generic SaaS platform, which isn't
the bet.

## Why one storefront, not two platforms

The categories share storefront, identity, billing, registry, and SDK
primitives. They diverge only in:

- What `pas init` scaffolds (fork-template vs multi-tenant skeleton)
- What `fas/admin` provisions on publish (per-fork repo+Pages+D1 vs
  single Pages for the publisher)
- Which SDK helpers the publisher emphasizes

That's a `category` flag on the registry entry plus two code paths in the
admin provisioner. Not a second platform.

## Architecture: one control plane

| Concern | Component | Differs by category? |
|---|---|---|
| Identity, sessions | `fas` Worker (api.freeappstore.online) | No |
| Registry / catalog | `fas` Worker + storefront registry repo | No (category flag only) |
| Publish / provision | `fas/admin` Worker | **Yes** (two code paths) |
| Stripe / entitlements | `pas` Worker (api.proappstore.online) | No |
| App primitives (KV, rooms) | `fas` Worker | No (apps opt in either way) |
| Tenant data | App's own DB | **Yes** (own D1 per fork vs publisher BYO) |

No fourth backend. The branch point is one provisioning function in
`fas/admin`.

## Naming

**Tailored / Ready.** Clothing metaphor (tailored vs ready-made), short,
symmetric, telegraphs the difference without jargon. Storefront filters,
listing-page templates, and CLI flags all use these labels.

Considered: Tailored/Stock (good but "stock" reads as inventory),
Bespoke/Standard (fancier register), Forge/Live (cuter, less obvious).

## The Salesforce-like services angle

A Tailored template naturally creates a services market. The publisher
that maintains the template is the obvious expert; third parties can
become experts too. This is the Salesforce / Shopify Partner / WordPress
agency pattern, but with a meaningful differentiator: AI lowers the
customization floor, so the DIY path is genuinely viable. Consultants
get pulled in for higher-value work (deep integrations, ongoing ops),
not basic field changes.

The platform can host:

1. **Listing-page services blocks.** Free-text first ("we offer
   customization, contact us"). Pure lead gen, no payments.
2. **Verified-publisher status.** Signal trust on Tailored templates.
3. **Stripe Connect for paid services**, later. Platform takes a cut on
   services as well as software.
4. **Partner directory** per template. Multiple consultants per popular
   template = ecosystem.

Don't build #2/#3/#4 until #1 shows demand.

## Sequence (what to build first)

The thinnest version that exercises the two-category model end-to-end:

1. **D1 provisioning in `fas/admin`.** Extend `POST /api/provision` to
   accept `category: 'tailored' | 'ready'` and provision a fresh D1 per
   fork in the Tailored path. Unblocks any non-toy template.
2. **Strip Rocket Lab specifics from CRM** to produce a generic
   `pipeline` Tailored template. Rate card, currency, legal entity,
   Harvest/ClickUp integrations all become opt-in or removed. Rocket Lab
   becomes the *publisher* of the public template; the internal CRM
   continues as a private fork.
3. **PAS slice 1: Stripe webhook + entitlements.** Already on the
   roadmap, never started. Unblocks paid Tailored variants and paid Ready
   apps both.
4. **Storefront filtering & listing-page differentiation** for
   Tailored vs Ready. Listing-page templates differ: Tailored shows fork
   button, AI customization examples, services block; Ready shows
   pricing tiers, sign-up CTA.
5. **Free-text services block** on publisher profiles. Test demand for
   the consulting motion before investing in payments rails.

Steps 1, 2, 3 can run in parallel. Step 4 needs 1+3. Step 5 needs 4.

## Open decisions

- **Category-neutral vs publisher-branded template names.** `pipeline`
  (generic) vs `rl-crm` (publisher-branded). Probably both: publisher
  forks can rename freely.
- **Whether Ready apps get any platform-provided multi-tenant primitives**
  (tenant-aware D1 wrapper, RLS helpers) or stay strictly BYO. Default to
  BYO until a Ready publisher actually asks for help.
- **Services contract shape.** Marketplace (platform takes cut, holds
  contracts) vs directory (platform lists, hands off). Default to
  directory; revisit when volume justifies marketplace complexity.
- **Trust signals for Tailored templates.** Update cadence, security
  audits, publisher verification. Defer until catalog has >5 templates.
- **What happens to the existing CRM repo.** Private Rocket Lab fork
  (status quo), or the public template's first reference deployment.
  Probably stays private; the public template is a clean derivation.

## What this doesn't change

The free side keeps shipping on its current trajectory. The CRM
philosophy (`~/work/crm/CONSTRAINTS.md`, `CUSTOMIZING.md`) becomes the
philosophy of *every Tailored template*, not just the CRM — file-size
discipline, no admin UI for structural config, six-test config rule, AI
as the customization motion.

The CRM was the prototype. The platform makes it repeatable.
