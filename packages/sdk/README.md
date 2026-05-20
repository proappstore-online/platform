# @proappstore/sdk

Unified SDK for paid apps on **proappstore.online**. Includes everything from `@freeappstore/sdk` (auth, kv, counters, rooms, proxy) plus subscription management, license keys, and a per-app SQL database.

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
| `fasApiBase` | `https://api.freeappstore.online` | Free-tier backend URL |
| `proApiBase` | `https://api.proappstore.online` | Pro-tier backend URL |
| `dataApiBase` | `https://data-{appId}.proappstore.online` | Per-app data worker URL |

## Modules

### Auth

GitHub OAuth — shared identity across all FreeAppStore and ProAppStore apps.

```ts
await app.auth.init()
app.auth.onChange((user) => console.log(user))
app.auth.signIn()
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
// Query rows
const { rows } = await app.db.query('SELECT * FROM users WHERE active = ?', [true])

// Execute writes
const { meta } = await app.db.execute('INSERT INTO users (name) VALUES (?)', ['Alice'])
console.log(meta.last_row_id) // auto-increment id

// Batch (transactional)
const results = await app.db.batch([
  { sql: 'INSERT INTO orders (user_id, total) VALUES (?, ?)', params: [1, 99.99] },
  { sql: 'UPDATE users SET order_count = order_count + 1 WHERE id = ?', params: [1] },
])

// List tables
const tables = await app.db.tables()
```

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

### Maps (Geocoding + Embeds)

Address-to-coordinates and map embeds. Powered by OpenStreetMap/Nominatim. No Google API keys needed.

```ts
// Geocode an address
const results = await app.maps.geocode('Times Square, New York')
// [{lat: 40.758, lng: -73.985, displayName: "Times Square...", address: {...}}]

// Reverse geocode
const place = await app.maps.reverseGeocode(40.758, -73.985)

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
- Topbar with avatar, app name, and user menu (sign out, manage billing, delete account)

## Per-app SQL Database

Each Pro app is provisioned with a dedicated Cloudflare D1 database fronted by a data worker (`data-{appId}.proappstore.online`). The SDK's `db` module provides a typed client for this worker.

The database is per-user isolated at the auth layer — all requests require a valid Bearer token. The data worker validates the token against the FAS auth API before executing queries.

Tables are user-defined (create them via `db.execute('CREATE TABLE IF NOT EXISTS ...')`). The schema is entirely up to the app developer.

## License

MIT.
