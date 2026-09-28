# Getting Started

> **Building to the standard?** The [Application Standard](./standard/index.md) says which platform primitive to use for each need ([STACK chapter](./standard/stack.md)) and how an audit checks an app; hosted apps set `authMode: 'platform-cookie'` from day one ([PAS-AUTH-001](./standard/auth.md#pas-auth-001)).

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

## Build your app inside ProShell

Every PAS app is wrapped in `ProShell`, the standard app frame. Wrap the whole
app in it first, before you write any screen, and list the app's screens in its
`nav` prop. The shell provides:

- the sign-in and subscription gates;
- the topbar (app name, text size, profile menu) and the footer;
- the app's main navigation;
- an error boundary, a loading fallback, toasts, an offline banner and a skip link.

Do not hand-roll a header, navbar or profile menu, and never put navigation on a
page.

`pas create` scaffolds `web/src/App.tsx` in this shape:

```tsx
import { initPro, ProShell, PageHeader, useAuth, type NavItem } from '@proappstore/sdk'

const app = initPro({ appId: 'my-app', authMode: 'platform-cookie' })

// Every screen, once. ProShell renders these as <nav aria-label="Main"> in its
// topbar, marks the current one, collapses to a menu on small screens, and uses
// each `title` as the tab title.
const NAV: NavItem[] = [
  { label: 'Home', href: '/', title: 'My App' },
  { label: 'About', href: '/about', title: 'About — My App' },
]

export default function App() {
  return (
    <ProShell app={app} appName="My App" nav={NAV}>
      <Screens />
    </ProShell>
  )
}

// Nav items are plain links: a click loads the path and the platform serves the app for it.
function Screens() {
  switch (window.location.pathname) {
    case '/about': return <About />
    default: return <Home />
  }
}

function Home() {
  const { user } = useAuth()
  return <PageHeader title="My App" description={`Signed in as ${user?.name ?? 'you'}.`} />
}

function About() {
  return <PageHeader title="About" description="What My App is for." />
}
```

To add a screen, add it to `NAV` and to `Screens`, and start it with a
`PageHeader` (its one `h1`). If you use a router, pass
`onNavigate={navigate}`. The complete shell API, the routing rules and what
renders before sign-in are covered in
[SDK overview — ProShell](./sdk-overview.md#proshell-component). Moving an
existing app off its own header or navbar is covered in
[migrating a hand-rolled shell](./sdk-overview.md#migrating-a-hand-rolled-shell).

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

// App data actions
await app.actions.call('list_items', { limit: 20 })

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

- **Using an AI client?** Install the [ProAppStore Agent Skills plugin](./skills/) — seven workflows (create, architecture, auth and roles, data, publish and roll back, upgrade, audit) that drive this platform's MCP server. Codex: `codex plugin marketplace add proappstore-online/platform`; Claude Code: `/plugin marketplace add proappstore-online/platform`. What they are evaluated for: [evaluation summary](./skills/evaluations.md).

- [SDK overview — ProShell](/sdk-overview#proshell-component) — the app frame, navigation, and the built-in resilience layer
- [SDK overview](/sdk-overview) — all modules and their APIs
- [UI components](/ui) — the SDK components to build screens from
- [App actions and data access security](/app-actions-security) — recommended app-data pattern
- [CLI overview](/cli-overview) — every command explained
- [Publishing flow](/publishing-flow) — what `pas publish` does under the hood
- [Stripe & entitlements](/stripe-entitlements) — billing primitives
