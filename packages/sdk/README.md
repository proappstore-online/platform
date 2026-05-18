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
