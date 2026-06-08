# SDK overview

`@proappstore/sdk` is a browser-first ESM package that any Pro app imports
to get the full platform feature set on top of `@freeappstore/sdk`'s
identity layer.

## Init

```ts
import { initPro } from '@proappstore/sdk';

const app = initPro({
  appId: 'my-app',                                    // required
  proApiBase: 'https://api.proappstore.online',       // optional, defaults shown
  dataApiBase: 'https://data-my-app.proappstore.online',
});
```

The init call is synchronous and cheap. It does not fetch anything; the
first network call happens when you read auth state or call an API.

## Surfaces

```ts
// Auth (inherited from @freeappstore/sdk)
app.auth.init() / .signIn() / .signOut() / .onChange(cb)
// Provisioned credential accounts (no email/OAuth — for kids/students):
app.auth.provisionChild({ displayName }) // adult-only → { login, password } once
app.auth.signInWithCredentials(login, password) // child sign-in

// Per-user KV storage
app.kv.set(key, value) / .get(key) / .list() / .delete(key)

// Shared atomic counters
app.counters.increment(name) / .get(name) / .list()

// Real-time WebSocket rooms
app.rooms.join(roomId) → room.send() / .onMessage() / .onPeers() / .leave()

// Secret-injecting API proxy
app.proxy.fetch(url, opts)

// Per-app SQL database (D1)
app.db.query(sql, params) / .execute(sql, params) / .batch([...]) / .tables()

// Multi-tenant helpers
app.db.tenant(tenantId) → tx.find() / .findMany() / .insert() / .update() / .delete() / .count()

// Roles (app-level RBAC)
app.roles.assign(userId, role) / .revoke(userId, role) / .check(role) / .myRoles() / .listAll()

// File storage (R2)
app.storage.upload() / .uploadPublic() / .publicUrl() / .download() / .list() / .delete()

// Maps + geocoding + routing (OpenStreetMap, no Google keys)
app.maps.geocode(query) / .reverseGeocode(lat, lng) / .route(from, to) / .embedUrl() / .staticUrl()

// Push notifications (Web Push + VAPID)
app.notifications.subscribe() / .unsubscribe() / .isSubscribed() / .send(userId, payload) / .broadcast(payload) / .notifyUser(userId, payload)

// SMS (Twilio-backed, creator-only)
app.sms.send(to, message) / .broadcast(numbers, message)

// AI (Workers AI — text, chat, embeddings)
app.ai.generate(prompt, opts) / .chat(messages, opts) / .embed(text, opts)

// Subscription (Stripe)
app.subscription.status() / .openCheckout(opts) / .openPortal(returnUrl)

// License keys
app.license.current() / .validate(key)

// Usage tracking (auto-on, drives creator payouts)
app.usage.start() / .stop() / .flush()
```

## React hooks

Import from `@proappstore/sdk/hooks`:

- `useProAuth(app)` — auth state + actions
- `useProSubscription(app)` — subscription state + upgrade/manage
- `useProGate(app, opts)` — combined auth + subscription gate

## ProShell component

Import from `@proappstore/sdk/shell`:

```tsx
<ProShell app={app} appName="My App">
  <MyAppContent />
</ProShell>
```

Handles sign-in gate, subscription wall, topbar with avatar + menu.

## Framework-agnostic on purpose

`@proappstore/sdk` does not pin React, Vue, Svelte, or any UI framework.
It's pure browser ESM with TypeScript types. The scaffolds emitted by
`pas create` use React 19 + Vite + Tailwind, but that's a template choice,
not an SDK requirement.

## Source

- Package: `packages/sdk`
- Backend: `packages/backend`
- Tests: `vitest` per package; integration tests run against
  `wrangler dev --local` for the backend.
