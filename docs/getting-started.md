# Getting Started

ProAppStore is the paid counterpart to FreeAppStore. Same Cloudflare
Workers + D1 stack, plus Stripe subscriptions, license keys, server-side
AI, file storage, maps, push notifications, and more.

## Quick start

```bash
# Install the CLI
npm i -g @proappstore/cli

# Sign in with GitHub
pas login

# Create a new app
pas create my-app --repo my-org/my-app

# Develop
cd my-app
pnpm dev

# Publish to the platform
pas publish --name "My App" --category productivity

# Deploy (push triggers GitHub Actions)
git add -A && git commit -m "first feature" && git push
```

Your app is live at `https://my-app.proappstore.online` in under 2 minutes.

## Tech stack

- **TypeScript**, Node 22, pnpm workspaces
- **Frontend:** React 19 + Vite 8 + Tailwind CSS 4 (template choice, not required)
- **Backend:** Cloudflare Workers + D1 + Durable Objects
- **Auth:** PAS-owned GitHub OAuth, Google OAuth, email magic links, and signed PAS sessions
- **Payments:** Stripe (Checkout + Portal + webhooks)
- **Publishing:** OIDC trusted publishing (no stored npm tokens)

## SDK — one import, all features

```ts
import { initPro } from '@proappstore/sdk'

const app = initPro({ appId: 'my-app' })

// Auth
app.auth.signIn()

// Database
await app.db.query('SELECT * FROM items')

// File storage
await app.storage.upload(file, 'photos/pic.jpg')

// AI
const result = await app.ai.generate('Summarize this text...')

// Subscriptions
const sub = await app.subscription.status()
```

See the full [SDK reference](/sdk-overview) for all modules.

## Monorepo layout

```
platform/
├── packages/
│   ├── cli/          # @proappstore/cli
│   ├── sdk/          # @proappstore/sdk (browser ESM)
│   ├── backend/      # CF Worker — API, Stripe, provisioning
│   ├── compliance/   # build-time compliance checks
│   └── data-worker/  # per-app D1 proxy worker
├── migrations/       # D1 schema migrations
├── docs/             # this documentation
└── pnpm-workspace.yaml
```

## Relationship to FreeAppStore

ProAppStore is the paid counterpart to FreeAppStore, but Pro apps do not import
or call the FreeAppStore SDK at runtime. `@proappstore/sdk` vendors the common
browser primitives and points them at PAS-owned APIs. One import gives you
everything:

```ts
import { initPro } from '@proappstore/sdk'
const app = initPro({ appId: 'my-app' })

// All free features work:
app.auth, app.kv, app.counters, app.rooms, app.proxy, app.roles

// Plus pro features:
app.db, app.storage, app.ai, app.subscription, app.license,
app.maps, app.notifications, app.sms, app.email, app.webhooks
```

No need to import both SDKs. `initPro()` initializes everything.

## What to read next

- [SDK overview](/sdk-overview) — all modules and their APIs
- [CLI overview](/cli-overview) — every command explained
- [Publishing flow](/publishing-flow) — what `pas publish` does under the hood
- [Stripe & entitlements](/stripe-entitlements) — billing primitives
