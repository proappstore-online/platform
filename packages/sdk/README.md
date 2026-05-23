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

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `appId` | (required) | Your app's unique identifier |
| `proApiBase` | `https://api.proappstore.online` | Platform API base URL |
| `dataApiBase` | `https://data-{appId}.proappstore.online` | Per-app data worker URL |

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

GitHub OAuth — shared identity across all ProAppStore apps.

```ts
await app.auth.init()
app.auth.onChange((user) => console.log(user))
app.auth.signIn()          // GitHub (default)
app.auth.signIn('google')  // Google
app.auth.signIn('apple')   // Apple
app.auth.signOut()
```

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
await app.counters.decrement('likes')
const all = await app.counters.list()
```

### Rooms (Real-time WebSocket)

```ts
const room = app.rooms.join('lobby')
room.send({ text: 'hello' })
room.onMessage((msg) => console.log(msg))
room.onPeers((peers) => console.log(peers))
room.leave()
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

// Open Stripe checkout (navigates away)
await app.subscription.openCheckout({
  priceId: 'price_pro_monthly',
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

ProAppStore is a single $9/mo subscription that unlocks every Pro app. Creators are paid monthly from the pool (minus the 10% platform fee) in proportion to their app's share of total usage. To compute that, the SDK heartbeats `POST /v1/usage/ping` every 60 seconds while the tab is visible and the user is signed in.

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

## React Hooks (recommended)

Hooks give you full control over your UI while the platform handles auth, subscriptions, and gating. Import from `@proappstore/sdk/hooks`.

### useProAuth

Auth state + actions. The primary way apps interact with platform identity.

```tsx
import { initPro } from '@proappstore/sdk'
import { useProAuth } from '@proappstore/sdk/hooks'

const app = initPro({ appId: 'my-app' })

function App() {
  const { user, loading, signIn, signOut, deleteAccount } = useProAuth(app)
  if (loading) return <p>Loading...</p>
  if (!user) return <button onClick={signIn}>Sign in with GitHub</button>
  return <p>Welcome, {user.login}! <button onClick={signOut}>Sign out</button></p>
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

Combined auth + subscription gate. Returns a single `gate` state for easy conditional rendering.

```tsx
import { initPro } from '@proappstore/sdk'
import { useProGate } from '@proappstore/sdk/hooks'

const app = initPro({ appId: 'my-app' })

function App() {
  const { gate, user, signIn, upgrade } = useProGate(app, { allowFree: true })

  if (gate === 'loading') return <p>Loading...</p>
  if (gate === 'signed-out') return <button onClick={signIn}>Sign in</button>
  if (gate === 'no-subscription') return <button onClick={() => upgrade()}>Upgrade</button>
  return <p>Welcome, {user?.login}!</p>
}
```

Gate states: `'loading'` | `'signed-out'` | `'no-subscription'` | `'ready'`

Pass `{ allowFree: true }` to skip the subscription check (lets free users through).

## ProShell Component

A React component that handles auth gates, subscription checks, and renders a platform-level shell with topbar and user menu.

```tsx
import { initPro } from '@proappstore/sdk'
import { ProShell } from '@proappstore/sdk/shell'

const app = initPro({ appId: 'meetup' })

export default function App() {
  return (
    <ProShell app={app} appName="Meetup">
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
| `allowFree` | `boolean?` | Skip subscription gate (default: `false`) |

ProShell handles:
- Auth initialization and sign-in gate
- Subscription check and upgrade wall (unless `allowFree=true`)
- Topbar with avatar, app name, text size toggle, and user menu (sign out, manage billing, delete account)

## UI Components

Import from `@proappstore/sdk/ui`:

```tsx
import { Avatar, SignInButton, ThemeToggle, TextSizeToggle, ProBadge, ProfileMenu } from '@proappstore/sdk/ui'
```

- **TextSizeToggle** -- A/A+/A- button, cycles default/large/small text size. No props. Persists to localStorage.
- **ThemeToggle** -- Sun/moon button, cycles system/light/dark. No props.

See the [UI Component Library](https://proappstore.online/docs/ui) for the full list.

## Per-app SQL Database

Each Pro app is provisioned with a dedicated Cloudflare D1 database fronted by a data worker (`data-{appId}.proappstore.online`). The SDK's `db` module provides a typed client for this worker.

The database is per-user isolated at the auth layer — all requests require a valid Bearer token. The data worker validates the token against the platform auth API before executing queries.

Tables are user-defined (create them via `db.execute('CREATE TABLE IF NOT EXISTS ...')`). The schema is entirely up to the app developer.

## License

MIT.
