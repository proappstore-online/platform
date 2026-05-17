# @proappstore/sdk

Unified SDK for paid apps on **proappstore.online**. Includes everything from `@freeappstore/sdk` (auth, kv, counters, rooms, proxy) plus subscription management and license keys.

## Installation

```bash
npm i @proappstore/sdk
```

## Usage

```ts
import { initPro } from '@proappstore/sdk'

const app = initPro({ appId: 'my-app' })

// Auth (GitHub OAuth — same identity as FreeAppStore)
await app.auth.init()
app.auth.onChange((user) => console.log(user))
app.auth.signIn()

// Per-user KV storage
await app.kv.set('profile', { name: 'Alice' })
const keys = await app.kv.list({ prefix: 'note:' })

// Shared counters (cross-user)
await app.counters.increment('views')
const all = await app.counters.list()

// Real-time rooms
const room = app.rooms.join('lobby')
room.send({ text: 'hello' })
room.onMessage((msg) => console.log(msg))

// Subscriptions (Stripe-powered)
const sub = await app.subscription.status()
if (!sub || sub.status !== 'active') {
  await app.subscription.openCheckout({
    priceId: 'price_xxx',
    successUrl: 'https://my-app.proappstore.online/success',
    cancelUrl: 'https://my-app.proappstore.online/',
  })
}
await app.subscription.openPortal('https://my-app.proappstore.online/')

// License keys
const license = await app.license.current()
const valid = await app.license.validate('KEY-123')
```

## Modules

| Module | Source | Description |
|--------|--------|-------------|
| `auth` | FAS | GitHub OAuth, SSO across all apps |
| `kv` | FAS | Per-user key-value store (list, get, set, delete, getMany) |
| `counters` | FAS | Shared atomic counters (votes, views, leaderboards) |
| `rooms` | FAS | Real-time WebSocket rooms (presence, chat, collab) |
| `proxy` | FAS | Secret-injecting API proxy for third-party services |
| `subscription` | Pro | Stripe checkout, portal, status |
| `license` | Pro | Per-app license key validation |

## License

MIT.
