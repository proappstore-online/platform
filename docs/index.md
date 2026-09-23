---
layout: home
hero:
  name: ProAppStore
  tagline: Distribution and monetization for AI-first apps. Two categories — Tailored apps customers fork and shape with AI, and Ready apps everyone shares.
  actions:
    - theme: brand
      text: Getting Started
      link: /getting-started
    - theme: alt
      text: Architecture
      link: /architecture
features:
  - title: Tailored Apps
    details: One forked, deployed instance per customer. Customization in source code with AI pairing. The publisher ships a starting point; variation is the value. CRM, PSA, helpdesk, ATS, LMS — all the B2B back-office shapes.
    link: /tailored-vs-ready
  - title: Ready Apps
    details: One shared deployment per publisher, multi-tenant. Customers sign up to the same product. Standardization is the feature — network effects, shared content, cross-org integrations.
    link: /tailored-vs-ready
  - title: Stripe-Backed Pro
    details: Subscriptions, license keys, premium primitives via @proappstore/sdk. Same Cloudflare Workers + D1 stack as the free side. No vendor lock-in, no Firebase.
    link: /stripe-entitlements
  - title: AI-First Customization
    details: Forking + Claude/Codex pairing is the customization story. No admin UI for structural config. Source code is the configuration layer.
    link: /tailored-vs-ready
  - title: Services Marketplace
    details: Publishers offer support, customization, and managed hosting on their own templates. The Salesforce-partner pattern, but with AI lowering the customization floor.
    link: /services-marketplace
  - title: One Control Plane
    details: PAS-owned Workers for platform APIs, app data workers, MCP, and Agent Teams. Identity, roles, registry, billing, provisioning, entitlements — shared. Category is a flag, not a separate stack.
    link: /architecture
  - title: Agent Teams
    details: A PO/BA/Dev/QA AI team builds and maintains an app from a founder's chat. One Durable Object per project; GitHub is the source of truth; agents run on the user's BYO key. Personas + project memory give each team real context.
    link: /agent-teams-runtime-and-billing
---

# ProAppStore Platform Docs

ProAppStore is the paid counterpart to FreeAppStore: the same Cloudflare
Workers and D1 foundation, plus subscriptions, license keys, per-app SQL,
storage, AI, maps, notifications, email, webhooks, agent teams, and MCP app
tools.

## Start here

- [Getting Started](./getting-started.md)
- [Application Standard and Audit Guide](./standard/index.md) — how an app
  should use the platform, clause by clause, and how a human or an AI copilot
  audits a repository against it
- [SDK overview](./sdk-overview.md)
- [UI components](./ui.md)
- [Recipes](./recipes.md)
- [CLI overview](./cli-overview.md)
- [Publishing flow](./publishing-flow.md)
- [Browser auth session model](./auth-session-model.md)
- [MCP app tools and auth](./mcp-app-tools.md)
- [Agent Skills](https://github.com/proappstore-online/platform/blob/main/skills/README.md) — seven portable workflows for AI clients, installable as a plugin with the MCP server; [what they are evaluated for](./skills/evaluations.md)
- [App actions and data access security](./app-actions-security.md)
- [Migration repair runbook](./migration-repair-runbook.md)
- [Agent customization](./agent-customization.md)
- [Project docs sharing](./project-docs-sharing.md)
- [Architecture](./architecture.md)

## Building an app to the standard

The capability pages above say what the platform provides. The
[Recommended Application Standard](./standard/index.md) says when an app should
use each capability, what the recommended pattern is, which substitutes are
unsafe, and what evidence shows correct use. Give it to your AI copilot and ask
for an audit: it produces pass/fail/not-applicable results per clause and one
bounded issue per genuine failure, each citing the public clause URL.
