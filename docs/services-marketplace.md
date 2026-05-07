# Services marketplace

A Tailored template naturally creates a services market. The publisher
that maintains the template is the obvious expert; third parties can
become experts too. This is the Salesforce / Shopify Partner / WordPress
agency pattern, but with one meaningful difference: **AI lowers the
customization floor**, so the DIY path is genuinely viable. Consultants
get pulled in for higher-value work — deep integrations, ongoing ops,
domain expertise — not basic field changes.

## What the platform offers

In order of investment:

### Tier 1 — listing-page services blocks (lead gen only)

A free-text block on a Tailored template's listing page:

> **Need help customizing?**
>
> Rocket Lab maintains this template and offers customization,
> integration, and managed hosting. Contact pipeline@rocketlab.com.au.

Pure lead generation. No payments. No platform mediation. The
publisher's email + a contact form handles the rest. Test demand cheaply.

### Tier 2 — verified-publisher status

A simple signal: this publisher is the maintainer, has shipped >N
updates, has >M active forks, and (optionally) has agreed to a code of
conduct. Renders as a badge on the listing page.

### Tier 3 — partner directory per template

Multiple consultants per popular template. Each partner has a profile
(name, links, specialties, hourly rate, regions served). Customers can
filter and contact directly.

### Tier 4 — Stripe Connect for paid services

Platform-mediated payments. The platform takes a cut on services as
well as software. Contracts, dispute handling, refunds — all the
marketplace complexity. Only worth building when volume justifies it.

## Sequence

Build Tier 1 first. Only build Tier 2/3/4 when there's real signal that
publishers want to sell services and customers want to buy them. This
order is in the [strategy doc](https://github.com/proappstore-online/sdk/blob/main/STRATEGY.md);
the punchline is **don't build payments rails until lead gen proves
demand**.

## Why this fits the AI-first thesis

Salesforce's consultant ecosystem exists because Salesforce is
configurable but hard to configure. The platform creates a consulting
market by being insufficient out of the box.

ProAppStore Tailored templates start from the same insufficiency — every
customer's process is different — but offer a different first remedy:
fork it and AI-pair it yourself. That works for the long tail. Where it
doesn't (deep domain knowledge, large change, ongoing ops, regulatory
expertise), the consulting market still exists, but the pricing pressure
is downward: AI handles the basics, consultants charge for the parts AI
can't do well yet.

This is good for customers (cheaper baseline) and good for the
*right* consultants (their work is higher-leverage, less repetitive).
It's bad for consultants whose business is repetitive low-skill
customization. That's a feature, not a bug.

## Differences from Salesforce / Shopify

| | Salesforce | Shopify | ProAppStore Tailored |
|---|---|---|---|
| Customization | Click-through admin UI + Apex | Theme editor + apps | Source code + AI |
| Multi-tenancy | Yes | Yes | No (per-fork deployment) |
| Default consultant role | Configure the platform | Theme + apps | Domain integrations + ops |
| Floor for DIY | Medium-high | Low-medium | Low (AI-assisted) |
| Platform cut on services | Salesforce AppExchange takes a cut | App fees | Tier 4 only |

## What publishers commit to (eventually)

For Tier 2+ status, publishers should commit to:

- Quarterly minor template updates or an explicit "stable" pin.
- A documented support model (hours, SLAs, channels).
- A versioning policy so forkers know what breaking changes look like.
- Optional: published prices for common service tiers.

None of this exists in v0. It lands when the catalog is big enough that
trust signals matter (~10+ Tailored templates).

## Decisions still open

- Should the platform host any kind of escrow or hold for services
  payments, or is that pure Stripe Connect with publisher-as-merchant?
- How should partner directories handle conflicts (same partner listed
  under multiple templates with the same expertise)?
- Should there be a "verified by AI" path for low-scope work (the
  platform automatically verifies a fork compiles + passes the
  template's tests after the partner's customization)?

These are good problems to have. They are not v0 problems.
