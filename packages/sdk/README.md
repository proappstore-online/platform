# @proappstore/sdk

Full SDK for premium apps on **proappstore.online**. Auth, per-user KV, counters, real-time rooms, API proxy, per-app SQL database, file storage, maps & routing, subscriptions, license keys, push notifications, SMS, email, webhooks, server-side AI, and multi-tenant helpers.

## Installation

```bash
npm i @proappstore/sdk
# or
pnpm add @proappstore/sdk
```

## Usage

```ts
import { initPro } from '@proappstore/sdk'

const app = initPro({ appId: 'my-app' })
```

Then wrap the whole app in `<ProShell app={app} appName="…" nav={[…]}>`, the standard app frame with the gates, topbar, main navigation and resilience layer. See [ProShell Component](#proshell-component).

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `appId` | (required) | Your app's unique identifier |
| `authMode` | `legacy-bearer` | Use `platform-cookie` for PAS-hosted HttpOnly cookie sessions |
| `proApiBase` | `https://api.proappstore.online` | Platform API base URL |
| `dataApiBase` | `https://data-{appId}.proappstore.online`, or `/.pas/data` in `platform-cookie` mode | Per-app data worker URL |

## Types

```ts
import type { User, Subscription, QueryResult, ExecuteResult, Migration } from '@proappstore/sdk'
// Also available from hooks:
import type { User } from '@proappstore/sdk/hooks'
```

**User** — returned by `app.auth.user` and `useProAuth()`:

```ts
interface User {
  id: string
  login: string
  avatarUrl: string | null
  dateOfBirth: string | null  // YYYY-MM-DD, null until set
}
```

**Database types:**

```ts
interface QueryResult<T> {
  rows: T[]
  meta: { changes: number; duration: number }
}

interface ExecuteResult {
  meta: { changes: number; duration: number; last_row_id: number }
}

interface Migration {
  name: string   // e.g. "0001_init" — tracked, only applied once
  sql: string    // semicolon-separated statements
}

interface MigrateResult {
  applied: string[]   // migrations just applied
  already: string[]   // previously applied
}
```

## Modules

### Auth

PAS-owned auth across all ProAppStore apps. GitHub is the default OAuth
provider; Google OAuth and email magic links are also supported.

```ts
await app.auth.init()
app.auth.onChange((user) => console.log(user))
app.auth.signIn()          // GitHub (default)
app.auth.signIn('google')  // Google
app.auth.signInWithEmail('alice@example.com')
app.auth.signOut()
```

Apps should not store PAS session tokens themselves. The default
`legacy-bearer` mode keeps the signed-in session in memory and tries to cache it
under the PAS-owned `pas:session` key. If browser storage is blocked or throws,
the SDK falls back to memory-only state for the current page lifetime.

PAS-hosted apps can opt into host-only HttpOnly cookie sessions:

```ts
const app = initPro({
  appId: 'my-app',
  authMode: 'platform-cookie',
})
```

In `platform-cookie` mode, OAuth and normal SDK HTTP calls go through
same-origin `/.pas/auth/*`, `/.pas/api/*`, and `/.pas/data/*` routes. Browser
JavaScript does not receive the PAS bearer token. WebSocket rooms and usage
beacon telemetry still use the legacy token path while those transports are
migrated.

### Actions

Registered app actions are the preferred path for browser-callable app data.
Actions are declared in the app's `mcp.json`, registered on publish, and run
server-side by name:

```ts
const result = await app.actions.call('list_my_items', { limit: 20 })
```

The platform loads the registered statement, injects `:__user_id`, `:__now`,
and `:__uuid`, enforces declared platform/app roles, then forwards the prepared
statement to the app data worker. Apps should migrate user-specific and
role-specific reads/writes to actions instead of sending raw SQL from browser
code.

A refused call rejects with an `ActionError` (`status`, `code` — the server's
`error`, e.g. `requires app role` or `step_up_required` — and `body`). Its
message is the same `actions.<name> failed: <status> <body>` as before.

### KV (Per-user key-value storage)

```ts
await app.kv.set('profile', { name: 'Alice' })
const profile = await app.kv.get('profile')
const keys = await app.kv.list({ prefix: 'note:' })
await app.kv.delete('profile')
```

### Counters (Shared atomic counters)

Cross-user counters for votes, views, leaderboards.

```ts
await app.counters.increment('views')
await app.counters.increment('likes', -1)   // decrement — pass a negative amount
const all = await app.counters.list()
```

### Rooms (Real-time WebSocket)

```ts
const room = app.rooms.join('lobby')
room.send({ text: 'hello' })
room.onMessage((msg) => console.log(msg))
room.onPeers((peers) => console.log(peers))
room.close()
```

### Proxy (Secret-injecting API proxy)

Call third-party APIs without exposing keys to the client.

```ts
const response = await app.proxy.fetch('/openai/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-4', messages: [...] }),
})
```

### Database (Per-app SQL)

Each Pro app gets its own D1 SQL database accessed through a dedicated data worker at `data-{appId}.proappstore.online`.

```ts
// Schema migrations — idempotent, tracked by name
const { applied, already } = await app.db.migrate([
  {
    name: '0001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `,
  },
])

// Query rows
const { rows } = await app.db.query<User>('SELECT * FROM users WHERE active = ?', [true])

// Execute writes
const { meta } = await app.db.execute('INSERT INTO users (id, name) VALUES (?,?)', ['u1', 'Alice'])
console.log(meta.last_row_id) // auto-increment id

// Batch (transactional)
const results = await app.db.batch([
  { sql: 'INSERT INTO orders (user_id, total) VALUES (?, ?)', params: ['u1', 99.99] },
  { sql: 'UPDATE users SET order_count = order_count + 1 WHERE id = ?', params: ['u1'] },
])

// List tables
const tables = await app.db.tables()
```

**Recommended pattern:** define migrations in a `db/core.ts` file and call `ensureMigrated()` at the top of each query function. See the [kanban app](https://github.com/proappstore-online/kanban/blob/main/web/src/lib/db/core.ts) for the full pattern.

### Subscription (Stripe-powered)

```ts
// Check subscription status
const sub = await app.subscription.status()
// Returns: { status, tier, priceId, currentPeriodEnd, cancelAtPeriodEnd } | null

// Read the live platform price config
const pricing = await app.subscription.pricing()
const priceId = pricing.proMonthly?.priceId
if (!priceId) throw new Error('Subscription billing is not configured')

// Open Stripe checkout (navigates away)
await app.subscription.openCheckout({
  priceId,
  successUrl: 'https://my-app.proappstore.online/success',
  cancelUrl: 'https://my-app.proappstore.online/',
})

// Open Stripe billing portal (navigates away)
await app.subscription.openPortal('https://my-app.proappstore.online/')
```

### License

Per-app license key validation.

```ts
// Get current user's license (requires auth)
const license = await app.license.current()
// Returns: { key, appId, issuedAt, expiresAt } | null

// Validate any key (no auth required)
const valid = await app.license.validate('LIC-ABC-123')
```

### Maps (Geocoding, Routing + Embeds)

Address-to-coordinates, driving directions, and map embeds. Powered by OpenStreetMap/Nominatim/OSRM. No Google API keys needed.

```ts
// Geocode an address
const results = await app.maps.geocode('Times Square, New York')
// [{lat: 40.758, lng: -73.985, displayName: "Times Square...", address: {...}}]

// Reverse geocode
const place = await app.maps.reverseGeocode(40.758, -73.985)

// Driving route between two points
const route = await app.maps.route(
  { lat: 40.758, lng: -73.985 },  // from
  { lat: 40.748, lng: -73.986 },  // to
)
// route.geometry      — GeoJSON LineString ([lng, lat] pairs)
// route.distanceMeters
// route.durationSeconds

// Embed map in iframe
<iframe src={app.maps.embedUrl(40.758, -73.985)} />

// Static tile image
<img src={app.maps.staticUrl(40.758, -73.985)} />
```

### Storage (File Upload)

Upload images, videos, documents. Public files get URLs usable in `<img src>` without auth.

```ts
// Private upload (owner-only access)
await app.storage.upload('docs/resume.pdf', file, 'application/pdf')

// Public upload (anyone can view)
await app.storage.uploadPublic('avatar.jpg', file, 'image/jpeg')
const url = app.storage.publicUrl('avatar.jpg')  // works in <img src>

// List, download, delete
const files = await app.storage.list()
const response = await app.storage.download('docs/resume.pdf')
await app.storage.delete('docs/resume.pdf')
```

### Usage tracking (auto-on; drives creator payouts)

ProAppStore is a single $5/mo subscription that unlocks every Pro app. Creators are paid monthly from the pool (minus the 10% platform fee) in proportion to their app's share of total usage. To compute that, the SDK heartbeats `POST /v1/usage/ping` every 60 seconds while the tab is visible and the user is signed in.

**Auto-started by `initPro()`** — you don't need to do anything for your app's usage to count toward your payout. Hidden tabs don't accrue time; closed tabs flush a final ping via `navigator.sendBeacon`.

```ts
// Default behavior — telemetry on
const app = initPro({ appId: 'my-app' })

// Opt out (your app won't count toward payouts; you also won't see analytics)
const app = initPro({ appId: 'my-app', usage: { auto: false } })

// Manual controls (rarely needed)
app.usage.start()              // idempotent
app.usage.stop()               // halt heartbeats
app.usage.recordApiCall(1)     // piggybacks on next heartbeat
app.usage.flush()              // final ping (called automatically on pagehide)
```

What we record (also documented at <https://proappstore.online/privacy#usage-analytics>): per `(app, user, day)` rollups of session-seconds and API calls. No event-by-event logs, no IP, nothing while the tab is hidden or the user is signed out.

### Error monitoring (`app.logs`)

**Auto-started by `initPro()`** — uncaught errors and unhandled promise rejections
are captured and uploaded, so a user-visible failure leaves a platform record you
can read afterwards instead of relying on "it said something about permissions".

```ts
// Default — monitoring on, no code required
const app = initPro({ appId: 'my-app' })

// Attach build metadata so a report names the deploy it came from
const app = initPro({
  appId: 'my-app',
  monitoring: { build: { sha: __COMMIT_SHA__, version: '1.4.2' } },
})

// Opt out
const app = initPro({ appId: 'my-app', monitoring: { auto: false } })

// Log deliberately
app.logs.error('checkout failed', { step: 'confirm' })
app.logs.warn('slow board render')
app.logs.info('tournament joined')
app.logs.capture('warn', 'checkout', 'card declined')  // your own category

// Manual controls (rarely needed)
app.logs.flush()            // fire-and-forget; also runs on pagehide
await app.logs.flushAsync() // await the upload
app.logs.stop()
```

Read them back as the app owner — the console's per-app view, or directly:

```
GET /v1/apps/:appId/logs          # rows: level, category, fingerprint, source
GET /v1/apps/:appId/logs/groups   # occurrences, affected clients, first/last seen
```

**Works signed out.** A crash before sign-in is the report most worth having, so
entries upload anonymously, tagged with a rotating per-install `clientId` (browser
storage only, clears with site data, never correlated across apps).

**Never log secrets.** Messages and payloads are scrubbed on both sides for
password/token/bearer/JWT/email-shaped content, but that is a backstop:

> Do not put passwords, tokens, student identifiers, or raw request bodies into a
> log message or its `data`.

Limits: `debug` is dropped unless you set `monitoring: { level: 'debug' }`; 100
entries per upload, 4 KB per entry; each app has a daily budget, and past it
entries are still *counted* (so spikes stay visible) while detail stops and the
SDK goes quiet for a minute rather than retrying. Detail rows are pruned after 30
days. Stack traces are not symbolicated yet — grouping still works, and `build`
identifies the deploy.

`app.logs` is independent of `app.usage`: usage measures engagement, logs record
faults.

### Notifications (Web Push)

Push notifications to your users. Subscribe from the browser, send targeted or broadcast pushes from your app (creator-only).

```ts
// User side — subscribe to push notifications
await app.notifications.subscribe()        // requests permission + registers SW
await app.notifications.unsubscribe()
const subscribed = await app.notifications.isSubscribed()
const permission = app.notifications.getPermission()  // 'granted' | 'denied' | 'default'

// Creator side — send notifications
await app.notifications.send('user-123', {
  title: 'Event starting!',
  body: 'The meetup begins in 10 minutes.',
  url: '/events/evt-1',                   // opens on click
})

// Broadcast to all subscribers
await app.notifications.broadcast({
  title: 'New feature!',
  body: 'Check out the new map view.',
})

// Peer-to-peer: notify another user in the same app (no creator check)
await app.notifications.notifyUser('gh:123', {
  title: '@serge mentioned you',
  body: 'In "Wire the broadcast"',
  url: 'https://kanban.proappstore.online/#/...',
  tag: 'mention:card-1',
})
// Rate-limited: 30/min per user per app
```

Your app needs a service worker for push. Save `Notifications.getServiceWorkerScript()` as `/sw.js`, or append it to an existing one:

```ts
import { Notifications } from '@proappstore/sdk'

// Generate sw.js content
const swCode = Notifications.getServiceWorkerScript()
```

### SMS

Send text messages via the platform (Twilio-backed server-side). The platform owns the Twilio credentials — your app never sees them. Creator-only. Numbers must be E.164 format (`+15551234567`).

```ts
// Send to one recipient
await app.sms.send('+15551234567', 'Your reservation is confirmed!')

// Broadcast to many
await app.sms.broadcast(
  ['+15551234567', '+15559876543'],
  'Meetup starts in 30 minutes!',
)
```

### AI (Server-side LLM + Embeddings)

Workers AI — text generation, chat, and embeddings included in the platform subscription. No per-app key management; the platform handles billing.

```ts
// Text generation
const { text } = await app.ai.generate('Write a haiku about coding')

// With model selection: 'fast' (Llama-3.1-8B) or 'smart' (Llama-3.3-70B)
const { text } = await app.ai.generate('Summarize this article...', {
  model: 'smart',
  maxTokens: 512,
  temperature: 0.7,
})

// Multi-turn chat
const { text } = await app.ai.chat([
  { role: 'system', content: 'You are a helpful event planner.' },
  { role: 'user', content: 'Suggest a venue for 50 people in SF.' },
])

// Embeddings — for search, recommendations, clustering
const { vectors } = await app.ai.embed('vinyasa flow')
// vectors[0] is a 1024-dim float array

// Batch embeddings with model selection: 'm3' (multilingual, 1024-dim) or 'base' (English, 768-dim)
const { vectors, dimensions } = await app.ai.embed(
  ['yoga', 'pilates', 'meditation'],
  { model: 'base' },
)
```

### Tenant Scope (Multi-tenant helpers)

Safe-by-default CRUD helpers for multi-tenant tables. Auto-injects `tenant_id` on inserts and auto-scopes all reads/writes — prevents accidental cross-tenant data leaks.

```ts
// Create a scoped handle for a specific tenant
const tx = app.db.tenant('studio-123')

// All operations are automatically scoped to tenant_id = 'studio-123'
await tx.insert('clients', { id: 'c-1', name: 'Alice' })
const alice = await tx.find('clients', { id: 'c-1' })
const all = await tx.findMany('clients')
const count = await tx.count('clients')
await tx.update('clients', { id: 'c-1' }, { name: 'Alicia' })
await tx.delete('clients', { id: 'c-1' })

// Escape hatch — raw SQL with tenant_id available
const { rows } = await tx.db.query(
  'SELECT * FROM clients WHERE name LIKE ? AND tenant_id = ?',
  ['A%', tx.tenantId],
)
```

Your multi-tenant tables must have a `tenant_id TEXT` column. TenantScope doesn't replace `app.db.query` / `app.db.execute` — use those for joins, aggregates, or cross-tenant admin queries.

### Roles (App-level RBAC)

Per-app role management. Every app gets a set of default roles out of the box:

| Role | How assigned | Description |
|------|-------------|-------------|
| `owner` | Automatic (app creator) | Full control — cannot be revoked |
| `member` | Default for new users | Basic access |
| `moderator` | Assigned by owner | Content moderation privileges |
| `editor` | Assigned by owner | Can create and edit content |
| `viewer` | Assigned by owner | Read-only access |

Custom roles are supported — pass any string as a role name.

```ts
// Assign a role
await app.roles.assign('user-456', 'moderator')

// Revoke a role
await app.roles.revoke('user-456', 'moderator')

// Check if the current user has a role
const isMod = await app.roles.check('moderator')

// List all roles for the current user
const myRoles = await app.roles.myRoles()
// ['member', 'moderator']

// List all role assignments for the app (owner-only)
const all = await app.roles.listAll()
// [{ userId: 'user-456', role: 'moderator' }, ...]
```

## React Hooks

Every app is wrapped in [`ProShell`](#proshell-component), which already runs the sign-in and subscription gates. Use these hooks inside its screens to read identity and subscription state, or to gate a single screen. Import from `@proappstore/sdk` or `@proappstore/sdk/hooks`.

### useProAuth

Auth state + actions. The primary way apps interact with platform identity.

```tsx
import { initPro } from '@proappstore/sdk'
import { useProAuth } from '@proappstore/sdk/hooks'

const app = initPro({ appId: 'my-app' })

// A screen inside <ProShell>: the shell has already signed the user in.
function Welcome() {
  const { user, signOut } = useProAuth(app)
  return <p>Welcome, {user?.login}! <button onClick={signOut}>Sign out</button></p>
}
```

### useProSubscription

Subscription state + actions. Check if user is subscribed, upgrade, manage billing.

```tsx
import { useProSubscription } from '@proappstore/sdk/hooks'

function Billing() {
  const { subscription, isPro, loading, upgrade, manageBilling } = useProSubscription(app)
  if (loading) return <p>Loading...</p>
  if (!isPro) return <button onClick={() => upgrade()}>Upgrade to Pro</button>
  return <button onClick={manageBilling}>Manage billing</button>
}
```

### useProGate

Combined auth + subscription gate. Returns a single `gate` state for easy conditional rendering. ProShell gates the whole app; use this for one Pro-only screen in an app that otherwise allows free users.

```tsx
import { initPro } from '@proappstore/sdk'
import { useProGate } from '@proappstore/sdk/hooks'

const app = initPro({ appId: 'my-app' })

// A screen inside <ProShell allowFree>: only this screen needs a subscription.
function ReportsScreen() {
  const { gate, upgrade } = useProGate(app, { allowFree: false })

  if (gate === 'loading') return <p>Loading...</p>
  if (gate === 'no-subscription') return <button onClick={() => upgrade()}>Upgrade</button>
  return <Reports />
}
```

Gate states: `'loading'` | `'signed-out'` | `'no-subscription'` | `'ready'`

`allowFree` defaults to `true` (free users pass); pass `{ allowFree: false }` to require an active subscription.

### Custom admin panels: `AdminConsole`, `useAdminContext`, `useAction`

A custom admin panel is app code on the app's own origin; nothing runs inside the
PAS console. It reaches data only through the app's declared actions, and the
platform enforces auth, roles, step-up and audit on every call (#299).

```tsx
import { AdminConsole, useAdminContext, useAction, ActionError } from '@proappstore/sdk/hooks'

function Moderation() {
  const { app, user, roles, session } = useAdminContext()
  const deleteGroup = useAction('admin_delete_group', {
    // The action declares step_up: run a passkey check on this origin
    // (e.needsPasskey is true for app actions), then resolve true to retry
    // once or false to give up. Signing in again alone is refused again.
    onStepUp: (e: ActionError) => showReauth(e),
  })
  // Signed-out visitors have no roles to load: check the session first (#344).
  if (session.status === 'pending') return <p>Loading…</p>
  if (session.status === 'signed-out') return <p>Sign in to moderate.</p>
  if (session.rolesError) return <p>Couldn't load your roles. <button onClick={() => session.refreshRoles()}>Retry</button></p>
  if (!session.rolesLoaded) return <p>Loading…</p>
  if (!roles.includes('admin')) return <p>You don't hold the admin role.</p>
  return <button disabled={deleteGroup.pending} onClick={() => deleteGroup({ group_id: 'g1' })}>Delete</button>
}

<AdminConsole app={app}><Moderation /></AdminConsole>
```

- `useAdminContext()` → `{ app: { id }, user, roles, session: { status, rolesLoaded, rolesError, refreshRoles } }`. `roles` come from the server and are for rendering only; never a session token. `rolesLoaded` is false while signed out and while loading; a failed fetch sets `rolesError` (an empty `roles` without it means the caller holds none) and `refreshRoles()` retries.
- `useAction(name, { onStepUp })` returns a function that calls the action, plus `pending`, `error` (the latest call's failure; an older call settling later never overwrites it) and `reset()`. A refusal rejects with an `ActionError`: `forbidden` only when the caller's roles do not allow it (`requires app role` / `requires platform role`; other 403s such as a private app or a worker-only action keep their own `code`), `stepUpRequired` and `needsPasskey` when it needs a passkey check. An app's `step_up` action is bound to the app's own relying party (#331), so only a passkey step-up there passes: run `/.pas/auth/passkey/step-up/options` then `/.pas/auth/passkey/step-up` (on 404 `no_passkey`, register one first through `/.pas/auth/passkey/register/options` and `/register` within 10 minutes of signing in), then retry (#337). Every outcome is recorded in `app.logs` under `admin.action` (action, outcome, status — never params).
- `AdminConsole` catches a render error in the panel and records it; `AdminErrorBoundary` does the same for one part of a panel.

A full sample is `templates/template-membership/web/src/pages/Moderation.tsx`.

## ProShell Component

The app frame. It handles the auth gates, subscription checks, provider context, the topbar (app name, text size control, user menu), the footer, and the **main navigation**.

```tsx
import { initPro, ProShell } from '@proappstore/sdk'

const app = initPro({ appId: 'meetup' })

export default function App() {
  return (
    <ProShell
      app={app}
      appName="Meetup"
      nav={[
        { label: 'Events', href: '/' },
        { label: 'Groups', href: '/groups' },
      ]}
    >
      <MeetupApp />
    </ProShell>
  )
}
```

Props:

| Prop | Type | Description |
|------|------|-------------|
| `app` | `ProAppStore` | SDK instance from `initPro()` |
| `children` | `ReactNode` | App content (rendered only when gates pass) |
| `appName` | `string?` | Name shown in the topbar |
| `nav` | `{ label: string; href: string; icon?: ReactNode; title?: string }[]` | **The app's screens**, rendered as the main navigation in the topbar |
| `onNavigate` | `(href: string) => void` | Client-side navigation for nav clicks (e.g. a router's `navigate`); without it items are links |
| `renderNav` | `(ctx) => ReactNode` | Replace the built-in NavBar (`ctx`: `items`, `currentPath`, `onNavigate`) |
| `allowFree` | `boolean?` | Skip subscription gate (default: `true` until platform billing is live) |
| `showThemeToggle` | `boolean?` | Show theme toggle in the profile menu |
| `menuItems` | `{ label: string; onClick: () => void }[]` | Extra profile dropdown items |
| `hideTopbar` | `boolean?` | Omit the default topbar (and the navigation) |
| `hideFooter` | `boolean?` | Omit the default footer |
| `renderTopbar` | `(ctx) => ReactNode` | Replace the default topbar; place `ctx.nav` in it |
| `renderFooter` | `(ctx) => ReactNode` | Replace the default footer |
| `renderError` | `({ error, reset }) => ReactNode` | Replace the error-boundary fallback (errors are recorded via `app.logs`) |
| `renderLoading` | `() => ReactNode` | Replace the spinner shown while a lazy screen loads |

ProShell handles:
- Auth initialization and the sign-in gate
- The subscription check and upgrade wall (unless `allowFree=true`)
- The topbar with app name, text size toggle and user menu (sign out, manage billing, delete account)
- The main navigation from `nav`:
  - a `<nav aria-label="Main">` landmark;
  - `aria-current="page"` on the current route, following `location.pathname` and back/forward;
  - a menu button below 640 px (`aria-expanded`, Escape to close);
  - 44 px targets and visible focus.

  Its styles are injected when the navbar renders, so no setup is needed. They are also available as `@proappstore/sdk/shell.css`.
- Resilience and feedback:
  - an error boundary (with a Try again fallback, errors recorded via `app.logs`) and a Suspense spinner around the content;
  - `useToast()` for messages in one polite live region;
  - an offline banner, plus `useOnline()`;
  - tab titles from a nav item's `title` or `useDocumentTitle`;
  - `PageHeader` for each screen's one `h1`;
  - a skip link to `<main id="main">`;
  - with `onNavigate`, scroll to top or restore on back/forward, and focus moved to the new screen's heading.

Do not build navigation into a page, and do not stack a second navbar under the shell. A custom topbar keeps the gates and places the rendered `nav`:

```tsx
<ProShell
  app={app}
  appName="Chess Academy"
  nav={[{ label: 'Students', href: '/students' }, { label: 'Tournaments', href: '/tournaments' }]}
  renderTopbar={({ appName, nav, profileMenu, textSizeToggle }) => (
    <header className="top-nav">
      <a href="/">{appName}</a>
      {nav}
      {textSizeToggle}
      {profileMenu}
    </header>
  )}
>
  <ChessAcademy />
</ProShell>
```

For a fully custom layout, use `<ProShell app={app} hideTopbar hideFooter>` and compose `NavBar`, `ProfileMenu`, `SignInButton`, `GateScreen`, and hooks from `@proappstore/sdk/ui` and `@proappstore/sdk/hooks`.

The children render only after the gates pass: signed-out visitors see the sign-in screen with no topbar or navigation, and `platform-cookie` apps show it briefly to returning users while the session hydrates. Routing caveats (routers, hash routing) and a step-by-step guide to replacing a hand-rolled header or navbar are in the [SDK overview](https://docs.proappstore.online/sdk-overview/#proshell-component).

## UI Components

Import from `@proappstore/sdk/ui`:

```tsx
import { Avatar, SignInButton, ThemeToggle, TextSizeToggle, ProBadge, ProfileMenu } from '@proappstore/sdk/ui'
```

- **TextSizeToggle** -- A/A+/A- button, cycles default/large/small text size. No props. Persists to localStorage.
- **ThemeToggle** -- Sun/moon button, cycles system/light/dark. No props.

See the [UI Component Library](https://docs.proappstore.online/ui/) for the full list.

## Per-app SQL Database

Each Pro app is provisioned with a dedicated Cloudflare D1 database fronted by a data worker (`data-{appId}.proappstore.online`). The SDK's `db` module provides a low-level client for this worker.

The data worker verifies the PAS session locally before executing queries, but
raw SQL is not a row-level authorization boundary. Browser-facing app data
should use registered actions (`app.actions.call`) so user ids and role checks
are enforced by the platform before SQL reaches the data worker.

Tables are user-defined (create them via `db.execute('CREATE TABLE IF NOT EXISTS ...')`). The schema is entirely up to the app developer.

## Monitoring (`app.logs`)

Runtime monitoring is **on by default**. `initPro()` captures uncaught `error` /
`unhandledrejection` events and records failed `app.actions.call()` (action name +
HTTP status only), batching them to `POST /v1/apps/:appId/logs`. Owners read them
back (owner-only) via `GET /v1/apps/:appId/logs` / the dashboard.

```ts
app.logs.error('billing', 'checkout failed', { code });  // your own entries
app.logs.capture(err, 'payments');                       // a caught exception
```

Entries include route, auth mode, and any `monitoring.build` metadata. The SDK
**never** logs tokens, credentials, SQL params, or request bodies. Works in both
`legacy-bearer` and `platform-cookie` modes; flushes on an interval and on
`pagehide`. Opt out with `initPro({ monitoring: { auto: false } })`.

Ingestion is hardened (issue #108): the app must exist and each (app, user) has a
daily ingest quota, so logs can't be spoofed onto other apps or flooded.

## License

MIT.
