# SDK overview

`@proappstore/sdk` is a browser-first ESM package that any Pro app imports
to get the full platform feature set from PAS-owned APIs.

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
// Auth
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

## Auth session storage

Apps should not store PAS session tokens themselves. Use `app.auth.signIn()`,
`app.auth.signOut()`, `app.auth.init()`, and `useProAuth(app)`.

The current SDK keeps the signed-in session in memory and, in legacy bearer
mode, tries to cache it under the PAS-owned `pas:session` key. If browser
storage is blocked or throws, the SDK falls back to memory-only state for the
current page lifetime.

PAS is moving hosted apps to a same-origin token-handler model with host-only
HttpOnly cookies so browser JavaScript does not receive persistent bearer
tokens. See [Browser auth session model](/auth-session-model).

## ProShell component

Import from `@proappstore/sdk/shell`:

```tsx
<ProShell app={app} appName="My App">
  <MyAppContent />
</ProShell>
```

Handles sign-in gate, subscription wall, provider context, topbar with avatar + menu, text size control, and footer.

For simple apps, use the default shell. For apps with their own primary navigation, do not add a second navbar below ProShell. Replace the platform topbar while keeping auth/subscription gates:

```tsx
<ProShell
  app={app}
  appName="My App"
  renderTopbar={({ appName, profileMenu, textSizeToggle }) => (
    <header className="top-nav">
      <a href="/">{appName}</a>
      <nav>{/* app navigation */}</nav>
      {textSizeToggle}
      {profileMenu}
    </header>
  )}
>
  <MyAppContent />
</ProShell>
```

Use `hideTopbar` and `hideFooter` when the app owns all chrome but still wants ProShell gates and provider context.

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
