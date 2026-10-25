# ProAppStore Strategy

Product direction, originally written 2026-05-08 and reconciled with the PAS
control plane on 2026-10-25. The product models below describe intent; the
delivery priorities distinguish shipped capabilities from remaining acceptance
work. The [architecture](docs/architecture.md), binding ADRs (including
[app workers](docs/adr/009-app-workers.md))
and linked issues govern implementation.

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

## Revenue model: one flat subscription, split by usage

ProAppStore is **one subscription tier**. Users pay a single monthly fee to
the platform and get full access to every app. No per-app purchases, no
upgrade prompts, no freemium gates inside apps.

Apps never ask users to pay separately. The platform owns subscription
entitlements; signing in alone is not a promise of an active subscription.

The intended revenue model pays app developers through **usage-based splits**: the platform
tracks which apps each subscriber actually uses (time spent, sessions, API
calls) and distributes the subscription pool proportionally. A subscriber
who spends 80% of their time in one app sends 80% of their subscription
fee to that app's developer (minus the platform's 10% commission).

This is the product policy, not a statement that payouts are currently enabled.
The retired payout implementation has been removed (#450); billing,
entitlements, usage measurement and payout availability must be assessed
separately. See [payout metering](docs/payout-metering.md).

This means:
- **Apps must not gate features behind payments.** All features are included.
- **Apps must not show upgrade prompts.** There is nothing to upgrade to.
- **The `@proappstore/sdk` subscription API exists for the platform to verify
  the user has an active platform subscription**, not for per-app billing.
- **No per-app Stripe checkout.** The platform handles all billing centrally.

## Why one storefront, not two platforms

The categories share storefront, identity, billing, registry, and SDK
primitives. They diverge only in:

- Which approved template and tenancy model the creator selects
- Whether a customer needs an independently owned app deployment or access to
  the publisher's existing deployment
- Which SDK helpers the publisher emphasizes

These are product models within PAS. Do not assume that every category-specific
fork or storefront flow is shipped: the approved template catalogue and live
platform tools define the available creation paths.

## Architecture: one control plane

| Concern | Component | Differs by category? |
|---|---|---|
| Identity, sessions | PAS backend (`api.proappstore.online`) | No |
| Registry / catalog | PAS registry and storefront | Shared infrastructure |
| Publish / provision | PAS backend/admin and build-core | Template and ownership determine the app |
| Stripe / entitlements | PAS backend | No per-app checkout |
| App primitives (KV, rooms, storage, actions) | PAS backend, host and SDK | Shared contracts |
| Tenant data | Per-app D1 and data worker; registered actions enforce app tenancy | A fork has its own app data; a shared deployment must scope tenants |
| AI client operations | General PAS MCP (`mcp.proappstore.online/mcp`) | Shared tools; app actions discovered on demand |

PAS runs its own control plane. FAS is a separate product, not PAS's runtime
identity, registry or provisioning dependency. Apps are hosted from R2 through
the PAS host Worker; this is not a Cloudflare Pages provisioning roadmap.

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

## Delivery priorities (25 October 2026)

App creation, repositories, R2 hosting, per-app D1, action registration, billing
and entitlements already have implementations. Do not recreate them from the
original May build sequence. General MCP provisioning has also been exercised
with a deployed test app; individual capabilities still need their own evidence.

1. **Close production acceptance gaps.** Finish the safe action-rejection rollout
   ([#473](https://github.com/proappstore-online/platform/issues/473)) and the
   deployed HR history regression
   ([HR #107](https://github.com/proappstore-online/hr/issues/107)). Keep the
   broader role/tenant release acceptance separate
   ([HR #28](https://github.com/proappstore-online/hr/issues/28)); owner-only
   testing does not prove employee, manager or revoked access.
2. **Make authenticated tests part of every new app's lifecycle.** Grant
   management is available through MCP
   ([#475](https://github.com/proappstore-online/platform/issues/475)). Complete
   managed principal and CI integration acceptance
   ([#432](https://github.com/proappstore-online/platform/issues/432)) and default
   keyless test login during provisioning
   ([#462](https://github.com/proappstore-online/platform/issues/462)). Missing
   configuration must fail visibly; do not use a personal account as a silent
   fallback. Keep grants scoped and synthetic fixtures isolated.
3. **Complete background-worker rollout before opening it to all apps.** Meet
   ADR-009's runtime, egress, isolation and rotation gates
   ([#267](https://github.com/proappstore-online/platform/issues/267)). Calibrate
   quotas from the required measured usage window
   ([#306](https://github.com/proappstore-online/platform/issues/306)); a code
   change cannot replace fourteen days of evidence. Scheduled email/push and
   GrassKarma reminders have their own permission, opt-out, idempotency and
   delivery acceptance
   ([#466](https://github.com/proappstore-online/platform/issues/466)).
4. **Keep operations, discovery and published guidance consistent.** Resolve
   orphan-worker ownership/registration decisions
   ([#446](https://github.com/proappstore-online/platform/issues/446)), classify
   intended-public apps
   ([#474](https://github.com/proappstore-online/platform/issues/474)) and improve
   developer-documentation descriptions
   ([#483](https://github.com/proappstore-online/platform/issues/483)). A listed
   capability must state whether it is generally available, limited or pending.

Use a reference app to prove the complete path: create through MCP, deploy,
apply schema/register actions, run authenticated tests, inspect failures and
recover without changing identity or handling credentials manually. Publish a
storefront listing only when the owner requests publication and the app meets
the release standard. Ready listings explain access and sign-up under the single
platform subscription; they must not advertise per-app pricing tiers.

## Open decisions

- **Category-neutral vs publisher-branded template names.** `pipeline`
  (generic) vs `rl-crm` (publisher-branded). Probably both: publisher
  forks can rename freely.
- **How much tenancy scaffolding approved templates should provide.** The SDK
  already has tenant helpers; registered actions must enforce membership and
  row scope regardless of browser helpers. Further scaffolding should follow
  verified app requirements.
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
