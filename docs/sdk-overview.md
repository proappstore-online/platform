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

In a React app, pass `app` to [`ProShell`](#proshell-component), which wraps
the whole UI and calls `app.auth.init()` for you.

## Auth status

A missing user is not the same as a signed-out user. With the platform cookie
the SDK only knows who the user is once `/.pas/auth/me` answers, and a legacy
page may still be capturing a sign-in callback. Until then `app.auth.status`
is `pending` (#241):

- **`pending`**: render a neutral loading state, never the sign-in screen.
- **`signed-in`**: there is a user.
- **`signed-out`**: auth resolved without a user, the user signed out, or an
  expired session was cleared (an API 401 signs out at once).

`ProShell`, `useAuth()` (`status`, and `loading` while pending) and
`useGate()` already wait for it, so a signed-in refresh never flashes the
sign-in screen. `ProShell`'s `renderLoading` replaces the neutral state. If
you gate on auth yourself, check `loading` (or `status`) before `user`:

```tsx
const { user, loading } = useAuth()
if (loading) return <Loading />       // pending: not signed out
if (!user) return <SignIn />          // resolved: really signed out
```

The session check runs once per page load. Later `init()` calls only act on a
new sign-in callback in the URL.

## Surfaces

```ts
// Auth
app.auth.init() / .signIn() / .signOut() / .onChange(cb)
app.auth.status  // 'pending' | 'signed-in' | 'signed-out' — see "Auth status" below
app.auth.onStatus((status, user) => …)
// Provisioned credential accounts (no email/OAuth — for kids/students):
app.auth.provisionChild({ displayName }) // adult-only → { login, password } once
app.auth.signInWithCredentials(login, password) // child sign-in

// Per-user KV storage
app.kv.set(key, value) / .get(key) / .list() / .delete(key)

// Shared atomic counters
app.counters.increment(name) / .get(name) / .list()

// Real-time WebSocket rooms
app.rooms.join(roomId) → room.send() / .onMessage() / .onPeers() / .close()
//   + .onEvent()      events the app's worker publishes (#351)
//   + .onReconnect()  the socket came back: refetch what you show
//   `user:<uid>` rooms admit only that user; `mcp.json` `rooms` declares who may join others

// Secret-injecting API proxy — requires authMode: 'platform-cookie' (calls are
// bound to the app's own origin; a legacy-bearer call gets 403)
app.proxy.fetch(url, opts)

// Per-app SQL database (D1)
app.db.query(sql, params) / .execute(sql, params) / .batch([...]) / .tables()

// Registered app actions (recommended for user-facing app data)
app.actions.call(name, params)

// Multi-tenant helpers
app.db.tenant(tenantId) → tx.find() / .findMany() / .insert() / .update() / .delete() / .count()

// Roles (app-level RBAC — your app's OWN users; one of 3 role scopes,
// separate from team + platform roles. See docs/authorization-model.md)
app.roles.assign(userId, role) / .revoke(userId, role) / .check(role) / .myRoles() / .listAll()

// File storage (R2) — 50 MB per file; 1,000 files per user per app in each of private / user-public / review (403 at the limit; replacing a file is free). See "File storage deletion" below
app.storage.upload() / .uploadPublic() / .uploadUserPublic() / .publicUrl() / .download() / .list()
app.storage.delete(path) / .deleteUserPublic(path) / .deletePublic(key)
app.storage.uploadForReview(path, file) / .downloadForReview(userId, path) / .reviewUrl(userId, path) / .deleteForReview(userId, path)

// Maps + geocoding + routing (OpenStreetMap, no Google keys)
app.maps.geocode(query) / .reverseGeocode(lat, lng) / .route(from, to) / .embedUrl() / .staticUrl()

// Push notifications (Web Push + VAPID)
app.notifications.subscribe() / .unsubscribe() / .isSubscribed() / .send(userId, payload) / .broadcast(payload) / .notifyUser(userId, payload, { channel })  // see "Notifying another user" below

// SMS (Twilio-backed, creator-only)
app.sms.send(to, message) / .broadcast(numbers, message)

// AI (Workers AI — text, chat, embeddings)
app.ai.generate(prompt, opts) / .chat(messages, opts) / .embed(text, opts)  // limits: see "Workers AI limits" below

// Subscription (Stripe)
app.subscription.status() / .openCheckout(opts) / .openPortal(returnUrl)

// License keys
app.license.current() / .issue() / .revoke() / .validate(key)

// Usage tracking (auto-on, drives creator payouts)
app.usage.start() / .stop() / .flush()

// Runtime monitoring (auto-on — captures errors + failed ops into app_logs)
app.logs.error(category, message, data?) / .warn(...) / .info(...) / .capture(err) / .flush()
```

## Monitoring

`app.logs` batches client log entries to `POST /v1/apps/:appId/logs`, so when a
user hits a failure the owner can inspect it after the fact (owner-only read via
the dashboard / `GET /v1/apps/:appId/logs`).

Auto-on by default: it captures uncaught `error` and `unhandledrejection` events,
and the SDK records failed `app.actions.call()` (action name + status — never the
params). Add your own entries with `app.logs.error('billing', 'checkout failed', { code })`.
Entries carry route, auth mode, and any `monitoring.build` metadata; the SDK never
logs tokens, credentials, SQL params, or request bodies.

```ts
const app = initPro({
  appId: 'my-app',
  monitoring: { auto: false },            // opt out of auto-capture
  // monitoring: { build: { commit: __COMMIT__ } },  // stamp entries with a build id
});
```

Ingestion is hardened: the app must exist and each (app, user) has a daily
ingest quota, so logs can't be spoofed for other apps or flooded.

## React hooks

Import from `@proappstore/sdk/hooks`:

- `useProAuth(app)` — auth state + actions
- `useProSubscription(app)` — subscription state + upgrade/manage
- `useProGate(app, opts)` — combined auth + subscription gate

ProShell already gates the whole app. Use these inside its screens, for
example `useProGate(app, { allowFree: false })` on a single Pro-only screen.

## Auth session storage

Apps should not store PAS session tokens themselves. Use `app.auth.signIn()`,
`app.auth.signOut()`, `app.auth.init()`, and `useProAuth(app)`.

The current SDK keeps the signed-in session in memory and, in legacy bearer
mode, tries to cache it under the PAS-owned `pas:session` key. If browser
storage is blocked or throws, the SDK falls back to memory-only state for the
current page lifetime.

Hosted PAS apps should use the same-origin token-handler model — the
[Application Standard](./standard/auth.md#pas-auth-001) requires it:

```ts
const app = initPro({
  appId: 'my-app',
  authMode: 'platform-cookie',
})
```

In `platform-cookie` mode, OAuth starts at `/.pas/auth/start`, the signed-in
user is read from `/.pas/auth/me`, sign-out posts to `/.pas/auth/logout`, normal
SDK HTTP calls use `/.pas/api/*` or `/.pas/data/*` mediation, and rooms use
same-origin `/.pas/api/*` WebSocket mediation. The bearer token stays in a
host-only HttpOnly cookie and is injected server-side by PAS.

When `authMode` is omitted the SDK reads the `<meta name="pas-auth-mode">`
marker the host stamps on every page it serves and defaults to
`platform-cookie` there; on localhost or any origin the platform does not host
it stays `legacy-bearer`. Set the option explicitly on hosted apps anyway
([PAS-AUTH-001](./standard/auth.md#pas-auth-001)). See [Browser auth session
model](/auth-session-model) and the standard's
[identity chapter](./standard/auth.md).

## App data access

Use registered actions for user-facing app data:

```ts
const result = await app.actions.call<{ rows: Item[] }>('list_items', {
  limit: 20,
});
```

Actions are declared in `mcp.json`, registered on publish, authenticated by the
platform, checked against declared role metadata, and forwarded as prepared SQL
to the app's data worker. The same manifest also exposes the action through the
platform MCP server.

`app.db.query()` and `app.db.execute()` remain available as low-level legacy
APIs for controlled migration and trusted tooling. They require a PAS session,
but browser-supplied raw SQL is not the target authorization boundary. See
[App actions and data access security](/app-actions-security).

## File storage deletion

Each delete method addresses the same namespace its upload wrote to (#207):

| Method | Deletes | Who may call it |
|---|---|---|
| `delete(path)` | your own private file (`upload`) | any signed-in user, own files only |
| `deleteUserPublic(path)` | your own user-public file; pass the `path` you gave `uploadUserPublic`, not the returned key | any signed-in user, own files only (the id comes from the session) |
| `deletePublic('u/<userId>/…')` | any user's public upload, by the `key` `uploadUserPublic` returned, for takedowns | app team `admin` or above |
| `deletePublic(path)` | an owner-curated `uploadPublic` asset | app owner |

`deleteUserPublic` and `deletePublic` throw `File not found.` for a key that does
not exist and `Not allowed to delete this file.` on a 403, so a takedown with a
wrong key is never reported as a success. `delete` still resolves for a missing
file. App-role moderators who are not on the app team cannot delete public files
directly; route their takedowns through the team (see #208).

**Deleted public files can outlive the delete in browser caches.** Public files
are served with `Cache-Control: public, max-age=31536000, immutable`, so a browser
that already fetched one may keep showing it for up to a year after deletion. When
prompt takedown matters, upload each version under a fresh path (for example
`logos/<id>-<timestamp>.png`) and never overwrite a path in place: removing the
key from your data then stops new page loads from referencing it, and the delete
removes the bytes from the server.

## Review uploads (documents for verification)

Some documents should be seen by the uploader and the app's reviewers only:
business-registration certificates, ID evidence, dispute evidence (#208).
`app.storage.uploadForReview(path, file)` stores one privately under the
uploader.

**Who may read or delete it:**

- the uploader;
- any user who holds one of the app's **review roles**, checked live against
  `app.roles` on every request.

Nobody else can, including the app team, the app creator and platform admins.

**Declaring review roles.** A team admin sets them once per app:

```
PUT /v1/apps/<appId>/storage-config   { "review_roles": ["moderator"] }
```

`member` is refused, because every signed-in user holds it. Assign the role
itself with `app.roles.assign`. Revoking the role, or removing it from
`review_roles`, denies the next read.

**Reading.** `uploadForReview` returns `key` = `_review/u/<userId>/<path>`. Store
it on the row under review; a reviewer then calls
`downloadForReview(userId, path)`.

**Serving.** Responses are `Cache-Control: private, no-store` with `nosniff` and a
`default-src 'none'` CSP. There are no signed or public URLs, so access ends when
the role does, and `/public/...` never serves these files.

**Allowed types.** PDF, PNG, JPEG, WebP and HEIC only; anything else is a `400`.

**Audit.** Every read or delete by someone other than the uploader is recorded
*before* the file is served or removed. If the audit write fails, so does the
request. The team admin reads the trail at
`GET /v1/apps/<appId>/storage-review-access?owner=<userId>&limit=50`.

**Expiry.** Delete the document with `deleteForReview` once the review is
decided, so the evidence is kept no longer than the review needs (PAS-OPS-016).
A review nobody decides does not keep its file forever: once a day the platform
deletes every review upload older than the app's retention, **30 days** by
default (#307). Age counts from the upload; replacing a file restarts it. A
team admin sets the retention, 1–365 days, or `null` for the default:

```
PUT /v1/apps/<appId>/storage-config   { "review_retention_days": 14 }
```

Either field of `storage-config` may be sent alone; the other keeps its value.
`GET /v1/apps/<appId>/storage-config` returns `review_retention_days` (null when
unset) and `effective_review_retention_days`. Each expiry is recorded in the
audit trail above with actor `system:retention` and action `platform_expired`.
If your app keeps the review key on a row, expect a `404` for a document past
its retention.

## Workers AI limits

`app.ai` runs Workers AI on the platform's account, so each user is bounded (#218):

- **Per minute:** at most 20 `generate`/`chat`/`embed` calls per user. The 21st is a
  `429` (`rate_limited`) with `Retry-After: 60`.
- **Per day:** 200 weighted units per user per UTC day. `smart` (70B) costs 5, `fast`
  costs 1, and embeddings cost 1 per 10 items (minimum 1). Over budget is a `429`
  (`quota_exceeded`) with `Retry-After` set to the seconds until UTC midnight.
- The budget is charged only for a valid request, just before the model runs. If
  the budget check is unavailable, the call is a `503` (`budget_unavailable`),
  fail-closed.

Platform content moderation (listings, the services marketplace) is bounded
separately, at 60 model calls per user per minute (`429` `moderation_rate_limited`).
It never uses your app's AI budget.

## Notifying another user (push or email)

`app.notifications.notifyUser(userId, { title, body, url? }, { channel })` lets
one user of an app tell another that something happened to them, for example
"you have a new inquiry" (#209).

| `channel` | Delivers | Caller must |
|---|---|---|
| `'push'` (default) | Web Push to the recipient's subscribed devices | hold a push subscription for the app |
| `'email'` | one email to the recipient's verified address | be a member of the app (signed in to it) |
| `'both'` | both | be a member of the app |

**The app never sees an address.** The platform looks up the recipient's
provider-verified email itself and returns only what happened:
`{ sent, failed, email: 'sent' | 'skipped' | 'failed', skipped? }`, where
`skipped` is one of:

- `unsubscribed`: the recipient opted out of this app's emails;
- `no_address`: no verified address, e.g. a credential or child account;
- `not_member`: the recipient has never signed in to this app.

**The email is a fixed platform template.** The subject is
`<app id>: <title>`, the body is your text (escaped, no HTML), and the link is
your `url` or the app's home page. `url` must be `https` on the app's own origin
(its `proappstore.online` subdomain or an active custom domain); anything else
is a `400`. Every email carries a one-click unsubscribe (`List-Unsubscribe`)
that applies to this app only.

**Moderation.** Email content (title and body) is checked by Workers AI (Llama
Guard) before anything is sent (#213):

- Unsafe content is a `422` listing the categories, and nothing is sent. For
  `'both'`, that includes the push.
- If moderation is unavailable, the answer is a `503` with `Retry-After`. It
  fails closed, so retry later.
- A push-only call is never moderated.
- Rejected attempts still count toward the per-minute limits.

**Limits.** Every channel shares 30/min per sender and 10/min per recipient.
Email also has 100/day per app (shared with `app.email.send`) and 10/day per
recipient. A limit is a `429` and nothing is sent; with `'both'`, the push is
not sent either. Title is at most 150 characters and body 2,000 for email.

## ProShell component

`ProShell` is the app frame. It handles the sign-in gate, subscription wall,
provider context, topbar (app name, text size, profile menu), footer, and the
**main navigation**. Import it from `@proappstore/sdk` (or `@proappstore/sdk/shell`).

Every PAS app is wrapped in ProShell, and `pas create` scaffolds it that way
(see [Getting Started](./getting-started.md#build-your-app-inside-proshell)).
Before building on it, read
[what renders before sign-in](#what-renders-before-sign-in-first-render) and
[routing](#routing-which-route-changes-the-shell-sees). To move an existing app
onto it, see [migrating a hand-rolled shell](#migrating-a-hand-rolled-shell).

### Navigation: pass `nav` (every app with more than one screen)

Declare the app's screens once. The shell renders them in its topbar as the
app's main navigation. Do not build navigation into a page, and do not add a
second bar below the shell.

```tsx
<ProShell
  app={app}
  appName="Cases"
  nav={[
    { label: 'Home', href: '/' },
    { label: 'Cases', href: '/cases' },
    { label: 'Settings', href: '/settings' },
  ]}
>
  <Screens />
</ProShell>
```

The built-in `NavBar` provides:

- A `<nav aria-label="Main">` landmark ([PAS-UI-003](./standard/ui.md#pas-ui-003)).
- The current screen marked with `aria-current="page"`. It follows `location.pathname`, including back and forward, and a nested route such as `/cases/42` marks `/cases`.
- A menu button below 640 px (`aria-expanded` / `aria-controls`; Escape or a click outside closes it).
- 44 px targets ([PAS-UI-009](./standard/ui.md#pas-ui-009)) and visible focus rings.
- Styling from the canonical tokens only, so it follows the app's light and dark themes.

The styles are injected when the navbar renders, so no setup is needed. They
are also published as `@proappstore/sdk/shell.css` for apps that prefer to
import them.

**Links.** By default each item is an ordinary link: a click loads that path,
and the platform serves the app for it. Render the screen for
`location.pathname`. With a router, pass `onNavigate` so clicks navigate
client-side:

```tsx
const navigate = useNavigate()
<ProShell app={app} nav={NAV} onNavigate={navigate}>…</ProShell>
```

**Custom navigation.** `renderNav({ items, currentPath, onNavigate })` replaces
the built-in NavBar and still places the result in the topbar. Render a
`<nav aria-label="Main">`. `NavBar` and the `NavItem` type are exported for
custom layouts.

### Custom topbar

`renderTopbar(ctx)` replaces the topbar while keeping the gates. The context
provides `nav` (the rendered navigation), `profileMenu`, `textSizeToggle` and
`proBadge`. Place all of them so navigation and account controls stay
consistent:

```tsx
<ProShell
  app={app}
  appName="My App"
  nav={NAV}
  renderTopbar={({ appName, nav, profileMenu, textSizeToggle }) => (
    <header className="top-nav">
      <a href="/">{appName}</a>
      {nav}
      {textSizeToggle}
      {profileMenu}
    </header>
  )}
>
  <MyAppContent />
</ProShell>
```

Use `hideTopbar` and `hideFooter` only when the app owns all the chrome and
still wants the ProShell gates and provider context. The app then provides its
own `<nav aria-label="Main">`.

### Resilience and feedback (built in)

ProShell also provides the parts every app would otherwise build, or ship
without. Nothing needs enabling; the props below only customise them.

| What | How you use it |
|---|---|
| **Error boundary** around the content: a screen that throws while rendering shows a fallback with **Try again**, not a white screen. The chrome stays. Navigating to another route clears it. | Nothing. The error is recorded via `app.logs` (category `react.error-boundary`, with the component stack). `renderError={({ error, reset }) => …}` replaces the fallback. |
| **Loading fallback**: a shell-level `<Suspense>` shows the SDK spinner while a lazy screen loads. | `const Cases = lazy(() => import('./Cases'))`. `renderLoading={() => …}` replaces the spinner. |
| **Toasts**: one polite live region, mounted once. Messages queue (newest four) and dismiss themselves (default 4 s; `duration: 0` stays until dismissed). | `const toast = useToast(); toast.show('Saved', { variant: 'success' })`. Variants are `info`, `success` and `error`. `toast.dismiss(id)`. Must be inside ProShell. |
| **Offline banner** under the topbar while the connection is down: announced politely, dismissible, cleared on reconnect. | Nothing. Data screens read `useOnline()` for their own offline state ([PAS-UI-019](./standard/ui.md#pas-ui-019)). |
| **Tab title per route** ([PAS-UI-003](./standard/ui.md#pas-ui-003)). | A `title` on a nav item, or `useDocumentTitle('Case 42 — Cases')` in the screen, which wins. |
| **One `h1` per screen.** | `<PageHeader title="Cases" description="…" actions={<Button>New</Button>} />` |
| **Skip link**: "Skip to content", hidden until focused, the first focusable element. It moves focus to `<main id="main">`. | Nothing. |
| **Route changes** (with `onNavigate`): forward navigation lands at the top, back/forward restores where the route was left, and focus moves to the new screen's `PageHeader` heading (else `<main>`). | Pass `onNavigate` (client-side routing). With plain links, every navigation is a page load and the browser handles scroll and focus itself. |

```tsx
import { lazy } from 'react'
import { ProShell, PageHeader, useDocumentTitle, useToast } from '@proappstore/sdk'

const Cases = lazy(() => import('./Cases'))

function CasesScreen() {
  useDocumentTitle('Cases — Support')
  const toast = useToast()
  return (
    <>
      <PageHeader title="Cases" actions={<button onClick={() => toast.show('Exported')}>Export</button>} />
      <Cases />
    </>
  )
}
```

An app that uses none of these renders as before. The only additions are
hidden: the skip link, `id="main"` on the shell's `<main>`, and two empty live
regions.

### What renders before sign-in (first render)

ProShell renders the app, and with it the topbar, navigation, skip link, toast
region and `<main>`, only once its gates pass. Until then it renders
`GateScreen` alone. Plan for these:

- **Every load waits for two checks.** First the gate spinner
  shows. Then ProShell calls `app.subscription.status()` once the user is known,
  and renders the app when that returns. The wait happens on every load, even
  with `allowFree` (the default, `true`). If the check fails, an `allowFree` app
  still opens.
- **A signed-out visitor sees only the sign-in screen**, with no topbar and no
  navigation. Nothing inside ProShell is public: a screen meant for signed-out
  visitors cannot be one of its children.
- **`platform-cookie` apps show the sign-in screen for a moment to returning
  users.** The session is hydrated from the cookie after the first render, and
  the shell treats "no user yet" as signed out. The app appears as soon as
  hydration finishes. Do not start sign-in or redirect because of that first
  signed-out state. `legacy-bearer` apps restore a stored session
  synchronously, so they skip this step.
- **Hooks that need the shell work only in its children.** `useToast` throws
  outside `<ProShell>`, and the gate screens have no toast region.
  `useOnline`, `PageHeader` and `useDocumentTitle` work anywhere.
- **`allowFree` defaults to `true`.** Pass `allowFree={false}` to require an
  active subscription. The upgrade screen then replaces the whole app, not one
  screen.

### Routing: which route changes the shell sees

The shell tracks the current path to mark the active nav item, apply a nav
item's `title`, clear the error boundary and move scroll and focus. It updates
that path on three events:

- the first render (`location.pathname`);
- back and forward (`popstate`);
- nav-item clicks that go through `onNavigate`.

So:

- **Plain links (no `onNavigate`).** Every navigation is a page load, so the shell
  is always current. This is the scaffold's default.
- **A router with `onNavigate`.** A navigation started elsewhere, such as a
  link or `navigate()` call inside a screen, is not seen: the nav's
  `aria-current` and the nav-item title stay on the old route until the next
  nav click or back/forward. Set each screen's title with `useDocumentTitle`,
  which does not depend on the shell's path. For the active item, render the
  built-in `NavBar` from `renderNav` with your router's location:

  ```tsx
  const location = useLocation()
  const navigate = useNavigate()
  <ProShell
    app={app}
    nav={NAV}
    onNavigate={navigate}
    renderNav={({ items, onNavigate }) => (
      <NavBar items={items} currentPath={location.pathname} onNavigate={onNavigate} />
    )}
  >…</ProShell>
  ```

- **Hash routing** (`#/cases`). The shell matches `location.pathname`, which a
  hash router never changes. In `renderNav`, render `NavBar` with the current
  hash route as `currentPath`, kept current on `hashchange`, as the approved
  staged templates do. Their nav hrefs are `#/…`. Nav-item titles do not apply
  here either, so set titles with `useDocumentTitle`.

### Migrating a hand-rolled shell

If an app already builds its own frame, such as a `Shell.tsx` or `Layout.tsx`,
a `<header>` with links, a navbar, or navigation on the Home page, move it onto
ProShell:

1. **Wrap the app.** Make `<ProShell app={app} appName="…" nav={NAV}>` the
   root of `App.tsx`. Keep your screen routing inside it.
2. **Move navigation into `nav`.** Put every link from the hand-rolled navbar,
   or from the Home page, into `NAV` as `{ label, href, title? }`. Delete the
   old navbar, and remove the nav buttons from the pages. If you use a router,
   pass `onNavigate={navigate}`.
3. **Delete what the shell now provides:**
   - the header or topbar, the logo and app-name link, and the avatar or
     profile menu;
   - the theme and text-size toggles;
   - sign-in and upgrade screens (`useProGate` + `GateScreen` at the root);
   - your own skip link, and a nested `<main id="main">`;
   - offline badges, and top-level error boundaries and `<Suspense>`
     wrappers;
   - `document.title` effects that a nav item's `title` covers.
4. **Keep what is app-specific.** Profile-menu entries become `menuItems`. A
   branded topbar becomes `renderTopbar`; place `ctx.nav`, `ctx.profileMenu`
   and `ctx.textSizeToggle` in it. A custom footer becomes `renderFooter`.
5. **Adopt the screen helpers.** Start each screen with `PageHeader` as its
   one `h1`. Replace hand-rolled toasts or snackbars with `useToast`. Replace
   per-screen titles with `useDocumentTitle`.
6. **Check it.** In the browser, check that:
   - the topbar shows one `<nav aria-label="Main">` with the current screen
     marked `aria-current="page"`;
   - Tab reaches "Skip to content" first;
   - below 640 px the navigation collapses into the menu button.

   Then run `pas check`.

Use `hideTopbar` only when the design needs a fundamentally different frame,
such as a full-screen map or an editor. The app then renders its own
`<nav aria-label="Main">`, usually the exported `NavBar`, and still gets the
gates, provider context and resilience layer.

## Error observability

What the platform records when an app operation fails, and what apps must not
put into a log. Design rationale: [ADR-008](./adr/008-error-observability.md).

### Client-side capture (`app.logs`)

On by default. `initPro()` starts it during construction — before app code runs —
so a crash in the app's own first render is still recorded, which is the
white-screen case this exists for.

```ts
const app = initPro({ appId: 'my-app', monitoring: { build: { sha } } })
app.logs.error('checkout failed', { step: 'confirm' })   // deliberate
// window.onerror + unhandledrejection are captured automatically
```

A render error inside `ProShell` is caught by the shell's error boundary.
React does not rethrow it to `window.onerror`, so the boundary records it
itself: level `error`, category `react.error-boundary`, with the stack,
component stack and path.

Uploads work **signed out** — a failure before sign-in has no session, and that is
the report most worth keeping. Anonymous entries carry a rotating per-install
`clientId` instead of a user id. Opt out with `monitoring: { auto: false }`.

Transport is shared with `app.usage` (`telemetry-transport.ts`): batched, flushed
every 10s, `sendBeacon` on `pagehide` in platform-cookie mode, keepalive fetch
otherwise. On a 202 (app over budget) the SDK goes quiet for a minute rather than
retrying; on a 404 (unknown `appId`) it stops permanently.

### Recorded for you, with no SDK code

Every failed app-scoped API operation is logged **server-side** — `app.actions`,
`app.db`, `app.rooms`, `app.invites`, `app.roles`, `app.storage`, `app.tokens`, and credential
provisioning. Nothing to opt into, and it covers apps already deployed.

Each record carries the operation name, HTTP status, category, auth mode, route,
and a **fingerprint** that groups repeat occurrences into one issue. Owners read
them at:

```
GET /v1/apps/:appId/logs          # rows, filterable by level/category/fingerprint/source
GET /v1/apps/:appId/logs/groups   # occurrences, affected clients, first + last seen
```

`source` tells you how far to trust a row:

| `source` | Meaning |
|---|---|
| `server` | Recorded by the backend. Unspoofable, and requires a signed-in caller. |
| `mediated` | Uploaded by an app page whose app identity the host verified. |
| `direct` | Uploaded via a direct API call, which cannot prove which app it is. |

Failures with no session are **counted** but not stored as rows, so an
unauthenticated caller cannot write into another app's log.

### What is deliberately never recorded

Params, request bodies, SQL parameters, credential logins, passwords, tokens, and
cookies. Messages are scrubbed again at the sink, because a deployed app version
cannot be patched on demand — but that is a backstop, not a licence:

> Never put a password, token, student identifier, or raw request body into a log
> message or its `data` payload.

Credential sign-in failures are counted platform-wide with a reason only — no
login, ever, since distinguishing "no such login" from "wrong password" in
telemetry would reintroduce the account enumeration the login path prevents.

### Limits

- 100 entries per upload, 4 KB per entry, 512 KB per request.
- A per-app daily budget shared by client uploads and server records. Over
  budget, uploads return **202** and entries are counted but not stored — the
  spike stays visible while detail stops.
- Detail rows are pruned after 30 days (metrics keep 90).
- Client stack traces are **not** symbolicated yet; grouping still works, and
  `build_meta` identifies the deploy.

## Framework-agnostic on purpose

`@proappstore/sdk` does not pin React, Vue, Svelte, or any UI framework.
It's pure browser ESM with TypeScript types. The scaffolds emitted by
`pas create` use React 19 + Vite + Tailwind, but that's a template choice,
not an SDK requirement.

## Source

- Package: `packages/sdk`
- Backend: `packages/backend`
- Tests: one root `pnpm test` runs every test file across the packages
  with Vitest in Node; Cloudflare bindings (D1, KV, `fetch`) are mocked.
  Each Worker's `wrangler dev` script is for local development only. CI's
  `check` job runs the same suite as `pnpm test:coverage`, which adds V8
  coverage with floors (global, plus the backend's routes and libraries, the
  data worker and the SDK) and a report of the least-covered files; every
  `deploy-*` workflow runs `pnpm test` before it deploys. A separate `pnpm test:runtime` (`packages/runtime-tests`) runs the
  backend and the data worker inside workerd with a real D1 built from the
  root migrations, R2, the Room Durable Object and service bindings; CI runs it
  in its own job and `deploy-backend.yml` runs it before applying migrations. Live coverage comes from the post-deploy health-endpoint smoke
  checks in those workflows and from the QA worker, which runs the stored
  browser flows on a cron and after each app deploy.
