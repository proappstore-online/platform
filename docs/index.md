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
    details: Three Workers (fas, pas, fas/admin) collaborating via service bindings. Identity, registry, billing, provisioning, entitlements — shared. Category is a flag, not a separate stack.
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
- [SDK overview](./sdk-overview.md)
- [UI components](./ui.md)
- [Recipes](./recipes.md)
- [CLI overview](./cli-overview.md)
- [Publishing flow](./publishing-flow.md)
- [MCP app tools and auth](./mcp-app-tools.md)
- [Agent customization](./agent-customization.md)
- [Architecture](./architecture.md)
