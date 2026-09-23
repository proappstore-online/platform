# Identity, sessions, and permissions

**Standard version 1.5** · Chapter `AUTH` · Part of the [Application Standard](./index.md)

**Scope.** Platform-cookie authentication, sign-in and sign-out, platform/team/app RBAC, and permissions UI.

Clause IDs in this chapter have the form `PAS-AUTH-<NNN>`; see the
[clause ID grammar](./governance.md#clause-id-grammar). Each clause follows the
[clause template](./governance.md#clause-template) and is audited under the
[audit model](./audit-model.md). The [STACK chapter](./stack.md) decides *that*
the app uses platform identity and app roles; this chapter says how.

## What the platform provides, in one paragraph

Hosted apps sign in through the host worker's `/.pas/auth/*` routes. The
callback redeems a one-time code server-to-server and sets a host-only
`__Host-pas_session` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`,
30 days) on the app's exact hostname — platform subdomain or active custom
domain. Page JavaScript never sees the token; every SDK call is mediated
same-origin through `/.pas/api/*` and `/.pas/data/*`, and mutations require a
positive same-origin `Origin` / `Sec-Fetch-Site` signal. Identity comes from
GitHub, Google, an email magic link, or a provisioned username/password
account. Authorization has three separate scopes — platform, team, app — and
apps use only the third, with the action SQL as the final boundary. The
details live in the [browser auth session model](../auth-session-model.md)
and the [authorization model](../authorization-model.md).

## Weakness classes this chapter detects

These are the classes corrected in Chess Academy during its platform-cookie
migration and action hardening (2026-09). An audit that walks this chapter
must identify each of them from repository evidence alone.

| Class | What it looked like | Clause |
|---|---|---|
| Legacy bearer session in JavaScript | `initPro` without `authMode`; `pas:session` in `localStorage` | [PAS-AUTH-001](#pas-auth-001), [PAS-AUTH-002](#pas-auth-002) |
| Raw auth calls and token coupling | A hand-written `fetch` to a credential-login endpoint; code reading `app.auth.token` | [PAS-AUTH-003](#pas-auth-003) |
| Silent authorization failure | A role hook that turned a failed profile load into "no role" and re-onboarded existing users | [PAS-AUTH-008](#pas-auth-008) |
| No way out of a stuck session | Membership error screens without sign-out; an installed PWA shell that predated the cookie migration | [PAS-AUTH-007](#pas-auth-007) |
| Custom-domain divergence | Sign-in and profile loads behaving differently on the custom hostname | [PAS-AUTH-011](#pas-auth-011) |
| Unscoped privileged writes | Actions gated in the UI but not tied to the caller in SQL | [PAS-AUTH-016](#pas-auth-016), [PAS-AUTH-019](#pas-auth-019) |
| Wrong role scope or membership-as-role | Gating on team membership, platform role, or the automatic `member` role | [PAS-AUTH-013](#pas-auth-013), [PAS-AUTH-014](#pas-auth-014) |

## Recommendation, enforcement, capability

| Statement | Kind |
|---|---|
| `authMode: 'platform-cookie'` on hosted apps | Recommended conformity (`MUST`); the SDK's own default is `legacy-bearer` for compatibility and does not enforce it |
| Same-origin CSRF check on mediated mutations; `return_to` validation; host-only cookie attributes; credential-login rate limit; role-name and `owner` rules; action registration validation | Automated enforcement by the platform — the clause names the mechanism |
| Google / email / credential sign-in, invites, custom roles, custom domains | Optional capabilities — absent use is never a finding |

## Capability pages this chapter builds on

Clauses link to these as *Supporting links*; they describe what the platform
provides and are not restated here.

- [Browser auth session model](../auth-session-model.md)
- [Authorization model](../authorization-model.md)
- [App actions and data access security](../app-actions-security.md)
- [MCP app tools](../mcp-app-tools.md)
- [SDK overview](../sdk-overview.md)
- [UI components](../ui.md)
- [CLI overview](../cli-overview.md)

## Clauses

### PAS-AUTH-001 — Hosted apps authenticate in platform-cookie mode {#pas-auth-001}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** An app served from `<app>.proappstore.online` or an active custom domain MUST initialise the SDK with `authMode: 'platform-cookie'`. `legacy-bearer` (the SDK's compatibility default when the option is omitted) MAY be used only for local development or an app that is not hosted by the platform.

**Applicability.** All hosted apps.

**Rationale.** In legacy-bearer mode the session token is delivered to page JavaScript in the URL fragment and cached in `localStorage` under `pas:session`, where any script on the origin can read and exfiltrate it. In platform-cookie mode the token lives in a host-only `HttpOnly` cookie set by the host worker; page JavaScript never sees it, and every SDK call is mediated through the app's own origin. The secret proxy only answers cookie-mode calls.

**Recommended implementation.** Set the option on the single `initPro` call ([PAS-STACK-003](./stack.md#pas-stack-003)). Nothing else changes: `signIn`, `init`, `signOut`, `useProAuth`, actions, KV, rooms, storage and the rest route through `/.pas/*` automatically.

**Conforming example.**

```ts
export const app = initPro({ appId: 'my-app', authMode: 'platform-cookie' })
```

**Non-conforming example.**

```ts
export const app = initPro({ appId: 'my-app' })   // silently legacy-bearer: token in localStorage
```

**Evidence.** Source: the `initPro(` call — `authMode` present and equal to `'platform-cookie'`. **Direct audit rule:** `grep -rn "initPro(" web/src` and inspect the options; an `initPro` without `authMode: 'platform-cookie'` in a hosted app is a `fail`, not a manual review.

**Remediation.** Add the option; run the sign-in, one data call, sign-out, and (if used) proxy and rooms on the live app; remove any code that read `app.auth.token` (it is `null` in cookie mode — see [PAS-AUTH-003](#pas-auth-003)).

**Tests.** `app.auth.usesPlatformCookie === true` at runtime; `document.cookie` on the live app does not contain a session; after sign-in `localStorage.getItem('pas:session')` is `null`.

**Supporting links.** [Browser auth session model — target model](../auth-session-model.md#target-model), [SDK overview — auth session storage](../sdk-overview.md#auth-session-storage), [PAS-STACK-003](./stack.md#pas-stack-003).

### PAS-AUTH-002 — The app never stores, copies or parses a platform session {#pas-auth-002}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST NOT write a platform session or token to `localStorage`, `sessionStorage`, IndexedDB, a cookie, or any other storage; MUST NOT read the SDK's `pas:session` key; and MUST NOT parse `#pas_session=`, `?session=` or `?code=` from the URL. Session persistence belongs to the SDK and the host worker only.

**Applicability.** All apps.

**Rationale.** A stored copy outlives the SDK's own handling: it survives sign-out, it is readable by any script on the origin, and it is the exact artefact the platform-cookie migration removed. Parsing the callback URL re-creates the legacy bearer flow inside app code.

**Recommended implementation.** Use `app.auth.user`, `app.auth.onChange`, and `useProAuth`. If the app needs to remember something across reloads, remember *what the user chose* in `app.kv`, never *who they are*.

**Conforming example.**

```ts
const { user, loading } = useProAuth(app)      // identity comes from the SDK every load
```

**Non-conforming example.**

```ts
localStorage.setItem('pas:session', JSON.stringify({ token, user }))          // app-managed copy
const token = new URLSearchParams(location.hash.slice(1)).get('pas_session')    // parsing the callback
document.cookie = `session=${token}; domain=.proappstore.online`
```

**Evidence.** Source — **direct audit rule for the legacy pattern:** run `grep -rn "pas:session\|pas_session\|#pas_session\|?session=\|\.auth\.token" web/src` and `grep -rn "localStorage\|sessionStorage\|indexedDB\|document.cookie" web/src`. Any hit that touches a session, token or user identity is a `fail`; hits on unrelated UI state are reviewed under [PAS-STACK-009](./stack.md#pas-stack-009).

**Remediation.** Delete the storage code and the URL parsing; rely on the SDK; if the app is still legacy-bearer, apply [PAS-AUTH-001](#pas-auth-001) at the same time.

**Tests.** The greps above return nothing session-related; after sign-out on the live app no storage key and no cookie carries identity.

**Supporting links.** [Browser auth session model — app author rules](../auth-session-model.md#app-author-rules), [SDK overview — auth session storage](../sdk-overview.md#auth-session-storage).

### PAS-AUTH-003 — Auth flows use SDK methods, never app.auth.token or direct auth endpoints {#pas-auth-003}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST perform every authentication step through `app.auth` (`signIn`, `signInWithEmail`, `signInWithCredentials`, `provisionChild`, `resetPassword`, `changePassword`, `signOut`, `init`) or the SDK UI. It MUST NOT `fetch` `/v1/auth/*` or `/.pas/auth/*` itself and MUST NOT read `app.auth.token` to build requests.

**Applicability.** All apps with sign-in.

**Rationale.** `app.auth.token` is `null` in platform-cookie mode by design; code coupled to it breaks on migration (this blocked four apps in #71). A hand-written call to an auth endpoint skips the SDK's session hydration, error capture and the host's nonce/CSRF handling — Chess Academy's `postCredentialAuth` raw fetch (#141) is the reference case.

**Recommended implementation.** Call the SDK method for the flow; let it update `app.auth.user` and fire `onChange`. Authenticated requests to the app's own data go through `app.actions` / `app.db`, never through a token the app assembled.

**Conforming example.**

```ts
const user = await app.auth.signInWithCredentials(login, password)   // updates app.auth.user, fires onChange
```

**Non-conforming example.**

```ts
const res = await fetch('/.pas/auth/credentials/login', { method: 'POST', body: JSON.stringify({ login, password }) })
const { token } = await res.json()
await fetch(`https://data-my-app.proappstore.online/query`, { headers: { Authorization: `Bearer ${app.auth.token ?? token}` } })
```

**Evidence.** Source: `grep -rn "/v1/auth\|/.pas/auth\|auth\.token" web/src` — every hit outside the SDK is a `fail`.

**Remediation.** Replace each raw call with the SDK method; delete token plumbing; verify each flow (OAuth, email, credentials) on the live app in cookie mode.

**Tests.** Greps return nothing; each sign-in path used by the app completes on the live app and `app.auth.user` is set.

**Supporting links.** [SDK overview — surfaces](../sdk-overview.md#surfaces), [Browser auth session model — phase 4](../auth-session-model.md#phase-4-sdk-migration), [PAS-STACK-002](./stack.md#pas-stack-002).

### PAS-AUTH-004 — Sign-in offers only platform providers; credential accounts are provisioned, not self-registered {#pas-auth-004}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — platform credential sign-in rate limit (10 failures / 15 min per login) · **Since:** 1.2

**Rule.** The app MUST sign users in with the platform's providers — GitHub or Google via `app.auth.signIn(provider)`, email magic link via `signInWithEmail`, or username/password via `signInWithCredentials` for accounts created with `provisionChild`. It MUST NOT implement registration, password storage, password reset, or an identity provider of its own.

**Applicability.** All apps with sign-in.

**Rationale.** Credential accounts exist for students and children without email; they are created by an authorised adult (`provisionChild`), their passwords are shown once and reset only by authorised staff, and failed logins are rate-limited by the platform. A self-built password path has none of these properties and is the most common source of credential leaks.

**Recommended implementation.** Show `SignInButton` (GitHub) and, where wanted, a Google button (`app.auth.signIn('google')`) and an email form (`signInWithEmail`). For provisioned accounts, expose a login form calling `signInWithCredentials`, and an adult-only provisioning screen calling `provisionChild` / `resetPassword`. Authorise who may provision with a registered action named `can_provision_student_credentials` or a creator session — the platform checks it.

**Conforming example.**

```ts
<SignInButton app={app} />
<button onClick={() => app.auth.signIn('google')}>Continue with Google</button>
// staff screen, gated by the app's own role:
const { login, password } = await app.auth.provisionChild({ displayName: 'Ada', orgId })
```

**Non-conforming example.**

```ts
await app.actions.call('register_user', { email, passwordHash: sha256(password) })    // own identity store
```

**Evidence.** Source: sign-in UI wiring; any action or table storing passwords/hashes (`grep -rn "password" mcp.json migrations.json web/src`); `provisionChild` / `resetPassword` usage and what gates it.

**Remediation.** Remove the self-built registration and password tables; move to platform providers; provision credential accounts through the SDK; drop the password columns in a later contract migration.

**Tests.** Every sign-in path works on the live app; no password material in the app's own schema; a wrong credential-login attempt is rejected and the eleventh within 15 minutes returns 429.

**Supporting links.** [Browser auth session model](../auth-session-model.md), [UI — SignInButton](../ui.md#signinbutton), [PAS-STACK-006](./stack.md#pas-stack-006).

### PAS-AUTH-005 — Session hydration completes before auth-dependent UI renders {#pas-auth-005}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST call `app.auth.init()` once at start (directly or via `useProAuth`) and MUST NOT render the signed-out state, redirect to sign-in, or fire authenticated calls until hydration has settled. It SHOULD surface `app.auth.authError` after a failed callback.

**Applicability.** All apps with sign-in.

**Rationale.** Hydration is asynchronous in cookie mode (`/.pas/auth/me`). Rendering "signed out" during it flashes the sign-in screen at signed-in users, and an auto-redirect to sign-in during it produces a loop. A callback that fails leaves `#auth_error=` for the app to explain; ignoring it strands the user on a silent failure.

**Recommended implementation.** Use `useProAuth(app)` and branch on `loading` first; or call `await app.auth.init()` before the first render. Read `app.auth.authError` once after init and show its reason.

**Conforming example.**

```ts
const { user, loading } = useProAuth(app)
if (loading) return <Spinner />
if (!user) return <SignIn error={app.auth.authError} />
return <App user={user} />
```

**Non-conforming example.**

```ts
const user = app.auth.user                 // read synchronously, before init resolves
if (!user) app.auth.signIn()               // redirect loop for signed-in users in cookie mode
```

**Evidence.** Source: where `init()` / `useProAuth` is called relative to routing; any `signIn()` or authenticated call reachable before `loading` is false; whether `authError` is read.

**Remediation.** Gate the tree on `loading`; move redirects behind it; render `authError`.

**Tests.** Reloading the live app while signed in never shows the sign-in screen; a cancelled OAuth (`#auth_error=access_denied`) shows a message and a retry, not a blank page.

**Supporting links.** [SDK overview — React hooks](../sdk-overview.md#react-hooks), [Browser auth session model — phase 4](../auth-session-model.md#phase-4-sdk-migration).

### PAS-AUTH-006 — Expiry and 401 are handled by the SDK; the app does not refresh, retry or re-mint {#pas-auth-006}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST treat the SDK's sign-out on an API-plane 401 as authoritative and MUST NOT implement token refresh, silent re-authentication, retry-with-cached-credentials, or any second session store. A 401 from the app's data plane is a data error, not a sign-out, and the app MUST NOT sign the user out itself on it.

**Applicability.** All apps with sign-in.

**Rationale.** Sessions are 30-day signed tokens verified locally by every worker. The backend is the session authority: the host clears the cookie only on an API-plane 401. A data-worker 401 can be signing-key drift and must surface as an error, not a forced sign-out (#65/#66). App-side refresh logic has nothing to refresh with and only masks these states.

**Recommended implementation.** Let `app.auth.onChange` drive the UI; when `user` becomes `null`, show sign-in. Catch failures from `app.actions.call` / `app.db.*` and show an error with retry.

**Conforming example.**

```ts
app.auth.onChange((u) => { if (!u) navigate('/signin') })
try { rows = await app.actions.call('list_items') } catch (e) { setError('Could not load items'); app.logs.warn('items', String(e)) }
```

**Non-conforming example.**

```ts
fetch(url).then((r) => { if (r.status === 401) { localStorage.removeItem('pas:session'); location.reload() } })   // app-side session policy
```

**Evidence.** Source: custom 401 handling, `reload()` on auth failure, `setInterval` refresh, second session caches.

**Remediation.** Delete the custom handling; subscribe to `onChange`; convert data-plane failures into error states.

**Tests.** With the session cookie deleted in devtools, the next SDK call signs the user out cleanly; with the data worker returning 401 (simulated), the app shows a data error and stays signed in.

**Supporting links.** [Browser auth session model — current state](../auth-session-model.md#current-state) (operational invariant), [SDK overview — monitoring](../sdk-overview.md#monitoring).

### PAS-AUTH-007 — Sign-out is complete and a recovery path exists for stuck sessions {#pas-auth-007}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST sign out through `app.auth.signOut()` (or `ProfileMenu`), MUST clear its own in-memory and cached user data on sign-out, and MUST offer a way out of every authenticated-but-broken state — at minimum a visible sign-out, and for installed PWAs a link to the host's `/.pas/auth/recover` route, which clears the session cookie and Cache Storage.

**Applicability.** All apps with sign-in; the recovery route applies to installed PWAs and custom domains.

**Rationale.** A user whose membership lookup fails, whose PWA shell predates the cookie migration, or whose account was switched can otherwise be trapped on a screen with no exit. Chess Academy needed three fixes for exactly this (sign-out on membership failure, a cache-safe recovery route, unblocking recovery from pending push cleanup).

**Recommended implementation.** Wire `signOut` into the profile menu and every error screen shown to a signed-in user. Do not make sign-out depend on other requests succeeding (push unsubscribe, telemetry flush) — best-effort them and sign out regardless. Link `/.pas/auth/recover` from the error screen.

**Conforming example.**

```ts
const handleSignOut = async () => { try { await app.notifications.unsubscribe() } catch {} ; app.auth.signOut() }
<LoadError message="Couldn't load your membership" onRetry={reload} onRecovery={() => location.assign('/.pas/auth/recover')} />
```

**Non-conforming example.**

```ts
const handleSignOut = async () => { await app.notifications.unsubscribe(); app.auth.signOut() }   // sign-out never runs if unsubscribe throws
// error screen with no sign-out and no recovery link
```

**Evidence.** Source: sign-out call sites and what they await; error screens reachable while signed in and whether each has sign-out/recovery; cached user state cleared on `onChange(null)`.

**Remediation.** Make sign-out unconditional; add sign-out and the recovery link to error screens; clear caches on sign-out.

**Tests.** On the live app: sign-out returns to the signed-out state and `/.pas/auth/me` answers 401; visiting `/.pas/auth/recover` on an installed PWA lands on `/?recovered=1` signed out.

**Supporting links.** [Browser auth session model — phase 2](../auth-session-model.md#phase-2-host-worker-token-handler), [UI — ProfileMenu](../ui.md#profilemenu).

### PAS-AUTH-008 — A failed authorization lookup is an error state, never "no role" and never "allowed" {#pas-auth-008}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** When the app loads the caller's role, membership or profile to decide what to show, a request failure MUST produce a distinct error state with retry and sign-out. It MUST NOT be collapsed into "the user has no role" (which strands or re-onboards an existing user) and MUST NOT default to any permission.

**Applicability.** Apps that read a role or membership before rendering (most apps with app roles).

**Rationale.** Chess Academy's `useRole` swallowed a failed `get_my_profile` as `userRole = null`, so a transient failure on a custom domain sent coaches back to onboarding. The opposite default — treating failure as permitted — is a privilege escalation. Both are the same bug: an unknown answer treated as a known one.

**Recommended implementation.** Model three outcomes: loaded, loading, failed. Render failure explicitly. Keep the server-side gate (manifest `auth.app_roles` + SQL scoping) as the real boundary, so a client-side mistake here is a UX defect rather than a security one.

**Conforming example.**

```ts
const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ok'; role: Role | null } | { kind: 'error' }>({ kind: 'loading' })
app.actions.call<{ rows: Role[] }>('get_my_profile').then(r => setState({ kind: 'ok', role: r.rows[0] ?? null })).catch(() => setState({ kind: 'error' }))
if (state.kind === 'error') return <LoadError onRetry={reload} onRecovery={signOut} />
```

**Non-conforming example.**

```ts
app.actions.call('get_my_profile').then(setRole).catch(() => setRole(null))   // failure == "no role" → onboarding again
if (!role) return <Onboarding />
```

**Evidence.** Source: the hook or loader that fetches role/membership; its `catch` branch; whether the UI distinguishes error from absent.

**Remediation.** Add the error state; render retry and sign-out; keep the server-side gate unchanged.

**Tests.** Simulating a failed `get_my_profile` (network offline) shows the error screen, not onboarding, and retry recovers without re-onboarding.

**Supporting links.** [Authorization model — rule of thumb](../authorization-model.md#rule-of-thumb), [PAS-AUTH-007](#pas-auth-007), [PAS-AUTH-016](#pas-auth-016).

### PAS-AUTH-009 — State-changing requests stay on the SDK's same-origin, CSRF-checked path {#pas-auth-009}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — host worker rejects mediated mutations without a positive same-origin `Origin` / `Sec-Fetch-Site` signal · **Since:** 1.2

**Rule.** All mutations MUST go through the SDK (which uses same-origin `/.pas/*` mediation with `credentials: 'same-origin'`). The app MUST NOT expose or call any other cookie-authenticated mutation endpoint, MUST NOT submit HTML forms or top-level navigations to `/.pas/*`, and MUST NOT request credentialed CORS from other origins.

**Applicability.** All hosted apps.

**Rationale.** The host's CSRF defence is a positive same-origin check on every mediated mutation; it fails closed when neither header is present (a top-level navigation sends `Sec-Fetch-Site: none`). A form POST or a cross-origin credentialed call either fails that check or, if the app adds its own endpoint, bypasses it entirely.

**Recommended implementation.** Use `app.actions.call`, `app.kv.set`, `app.storage.upload`, etc. For a form, handle `onSubmit` in JavaScript and call the SDK.

**Conforming example.**

```ts
<form onSubmit={async (e) => { e.preventDefault(); await app.actions.call('create_item', { title }) }}>
```

**Non-conforming example.**

```ts
<form method="POST" action="/.pas/api/v1/apps/my-app/actions/create_item">     // top-level nav: Sec-Fetch-Site none → 403, or worse, an app-added route with no check
fetch('https://other.example.com/api', { credentials: 'include' })
```

**Evidence.** Source: `<form action=` targets; `fetch(` with `credentials: 'include'`; any app-owned Worker or route accepting the session cookie.

**Remediation.** Convert forms to SDK calls; remove app-owned cookie-authenticated routes; drop credentialed cross-origin calls.

**Tests.** A cross-site POST to `/.pas/api/...` (e.g. from a test page on another origin) returns 403; the app's own mutations succeed.

**Supporting links.** [Browser auth session model — phase 3 and 5](../auth-session-model.md#phase-3-same-origin-api-mediation), [PAS-STACK-002](./stack.md#pas-stack-002).

### PAS-AUTH-010 — Return URLs are same-origin paths and never carry credentials {#pas-auth-010}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — host and backend validate `return_to` (same origin, not `/.pas/*`; platform or active custom-domain origins only) · **Since:** 1.2

**Rule.** When starting sign-in the app MUST let the SDK compute `return_to` from the current location, or pass only a same-origin path. It MUST NOT pass another origin, MUST NOT encode tokens, codes or user data into the return URL, and SHOULD avoid depending on `location.hash` surviving the round-trip.

**Applicability.** All apps with sign-in.

**Rationale.** The callback is an open-redirect target if `return_to` were honoured blindly; the platform rejects foreign origins, so a foreign value silently becomes `/` and the user lands somewhere unexpected. The SDK drops the hash on the way out because the legacy callback writes its own; hash-router state must therefore be recoverable from the path or query.

**Recommended implementation.** Call `app.auth.signIn()` from the page the user should return to. If a deep link must survive, keep it in the path or query (`/tickets/42`, `?tab=x`), or stash it in `sessionStorage` under an app key *without* identity data.

**Conforming example.**

```ts
// user clicked "sign in" on /tickets/42?tab=notes — nothing to pass; SDK returns here
app.auth.signIn('github')
```

**Non-conforming example.**

```ts
location.assign(`/.pas/auth/start?return_to=${encodeURIComponent('https://evil.example/' + user.email)}`)
```

**Evidence.** Source: direct construction of `/.pas/auth/start` or `/v1/auth/*/start` URLs; hash-based routing that expects the hash to survive sign-in.

**Remediation.** Use `signIn()`; move deep-link state out of the hash.

**Tests.** Signing in from a deep link returns to the same path and query on the live app.

**Supporting links.** [Browser auth session model — phase 2](../auth-session-model.md#phase-2-host-worker-token-handler).

### PAS-AUTH-011 — Custom domains are registered, active, and served identically {#pas-auth-011}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — backend allows `return_to` only for `active` rows in `app_custom_domains` · **Since:** 1.2

**Rule.** An app on a custom domain MUST register it with `pas domain add` and verify it (`pas domain verify`) before relying on sign-in there. App code MUST NOT special-case hostnames, copy a session between hosts, or point the SDK at a different origin per domain; the same `initPro` and the same `/.pas/*` paths serve every hostname.

**Applicability.** Apps with a custom domain.

**Rationale.** The session cookie is host-only (`__Host-`), set on the exact hostname by the PAS host worker. A domain that is not active is refused as a `return_to`, so sign-in bounces to `/`; a domain not served through the host worker cannot receive the cookie at all. Per-host special cases are how Chess Academy's custom-domain profile failures started.

**Recommended implementation.** Register and verify the domain; deploy nothing domain-specific. Test every auth flow on both the platform subdomain and the custom domain.

**Conforming example.**

```bash
pas domain add app.example.com
pas domain verify app.example.com     # wait for status: active
```

**Non-conforming example.**

```ts
const apiBase = location.hostname === 'app.example.com' ? 'https://api.proappstore.online' : '/.pas/api'   // per-host plumbing
```

**Evidence.** Configuration: `pas domain list` status; Source: `location.hostname` comparisons, `proApiBase`/`dataApiBase` overrides; Runtime: `https://app.example.com/.pas/auth/me` returns JSON (not the SPA).

**Remediation.** Remove the per-host code; register/verify the domain; re-test sign-in, data, rooms and sign-out on it.

**Tests.** Sign-in on the custom domain sets `__Host-pas_session` for that host (visible in devtools as HttpOnly) and `/.pas/auth/me` returns the user.

**Supporting links.** [Browser auth session model — custom domains](../auth-session-model.md#custom-domains), [CLI overview — custom domains](../cli-overview.md#commands).

### PAS-AUTH-012 — The app sets no auth cookies of its own {#pas-auth-012}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST NOT set, read or emulate authentication cookies. The only session cookie is the host worker's `__Host-pas_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, host-only, 30-day `Max-Age`), which page JavaScript cannot access. In particular the app MUST NOT set any cookie with `Domain=.proappstore.online`.

**Applicability.** All hosted apps.

**Rationale.** A `Domain=` cookie on the shared parent is readable by every other app on the platform — cross-app session theft by construction. A JavaScript-readable cookie reintroduces the legacy-bearer exposure. Emulating the platform cookie name cannot work (the `__Host-` prefix is enforced by browsers) and signals a misunderstanding worth a finding.

**Recommended implementation.** Nothing to implement; the host sets and clears the cookie. Use `app.auth.user` for identity.

**Conforming example.**

```text
Set-Cookie: __Host-pas_session=…; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax   (set by the host worker, not the app)
```

**Non-conforming example.**

```ts
document.cookie = `pas_user=${user.id}; domain=.proappstore.online; path=/`
```

**Evidence.** Source: `document.cookie` writes; `Set-Cookie` in any app-owned Worker; Runtime: cookies on the live origin other than the platform's.

**Remediation.** Delete the cookie code; if identity was being shared across apps, that is a product question for platform support, not a cookie.

**Tests.** On the live app, the only cookies present after sign-in are `__Host-pas_session` (and transiently `__Host-pas_auth_nonce`), both HttpOnly.

**Supporting links.** [Browser auth session model — target model](../auth-session-model.md#target-model).

### PAS-AUTH-013 — In-app permissions use app roles, not team or platform roles {#pas-auth-013}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST gate its own users' capabilities with **app roles** (`app.roles`, `auth.app_roles` in `mcp.json`). It MUST NOT gate in-app features on **team** membership or role (who may build the app) or on **platform** roles (`creator`/`admin`), and code MUST name which scope a check belongs to.

**Applicability.** All apps where users differ in capability.

**Rationale.** PAS has three role vocabularies with colliding words (`admin`, `owner`, `viewer` each mean different things in different scopes). A student in a chess app is an app `member`; the contractor deploying it is a team `developer`; neither is a platform `admin`. Checking the wrong ladder either locks legitimate users out or grants deploy-level trust to app users — the 2026-07 escalation bugs (#78, #79, #95).

**Recommended implementation.** Define the app's roles as strings, assign them with `app.roles.assign`, check with `app.roles.check`/`myRoles`, and declare them in `auth.app_roles` on the actions they gate. Never call the team API (`/v1/apps/:id/team`) or read `user.roles` (platform) to decide app features.

**Conforming example.**

```ts
// app scope: coaches may publish lessons
if (await app.roles.check('coach')) showPublish()
// mcp.json: "auth": { "app_roles": ["coach"] }
```

**Non-conforming example.**

```ts
const apps = await fetch('/.pas/api/v1/apps').then(r => r.json())        // TEAM membership
if (apps.some(a => a.id === 'my-app')) showAdmin()                         // any viewer passes
if (app.auth.user.roles.includes('creator')) showAdmin()                  // PLATFORM role
```

**Evidence.** Source: `app.roles` usage; `/v1/apps`, `/team`, `user.roles` reads in `web/src`; `auth.platform_roles` on user-facing actions in `mcp.json`.

**Remediation.** Replace team/platform checks with app roles; add `auth.app_roles` to the actions; comment the scope at each check.

**Tests.** A team `viewer` who is not an app `coach` cannot reach the coach feature; a platform `user` who is an app `coach` can.

**Supporting links.** [Authorization model — the three systems](../authorization-model.md#the-three-systems), [MCP app tools — roles and permissions](../mcp-app-tools.md#roles-and-permissions), [PAS-STACK-014](./stack.md#pas-stack-014).

### PAS-AUTH-014 — Membership is not a role: `member` means "signed in" {#pas-auth-014}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** The app MUST check for the specific role a capability requires (`app.roles.check('editor')`, `auth.app_roles: ["editor"]`) and MUST NOT treat *having any role*, *appearing in the roles list*, or holding `member` as a privilege. The platform grants `member` automatically to every user on first sign-in.

**Applicability.** All apps using app roles.

**Rationale.** `ensure-member` runs on every sign-in, so every signed-in user holds `member`. A gate on `member`, on `myRoles().length > 0`, or on membership in a list is a gate on "signed in" — the same class of bug as gating team actions on `GET /v1/apps` membership (#78/#79/#95), one scope down.

**Recommended implementation.** Name the privilege. Reserve `member` for "a signed-in user of this app" and nothing more.

**Conforming example.**

```ts
const canModerate = await app.roles.check('moderator')
```

**Non-conforming example.**

```ts
const roles = await app.roles.myRoles()
const canModerate = roles.length > 0                       // everyone: member is automatic
// mcp.json: "auth": { "app_roles": ["member"] }             // equivalent to requires_auth alone
```

**Evidence.** Source: `myRoles()` results used as booleans; `app_roles: ["member"]` on privileged actions; `listAll()` used as an allow-list.

**Remediation.** Replace with the specific role; if `member` gating was intended as "signed in", use `requires_auth: true` and drop the role gate.

**Tests.** A freshly signed-in user with only `member` cannot reach any privileged feature or action.

**Supporting links.** [Authorization model — which check to use](../authorization-model.md#which-check-to-use), [PAS-AUTH-013](#pas-auth-013).

### PAS-AUTH-015 — Least privilege by default {#pas-auth-015}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** New users MUST receive no role beyond the automatic `member`. Privileged roles MUST be granted explicitly by an authorised administrator (or by redeeming an invite whose role the administrator chose), and each action MUST declare the narrowest `auth.app_roles` that can perform it.

**Applicability.** All apps using app roles.

**Rationale.** A default grant of `editor` or `admin` on sign-up turns every stranger into staff; an action gated on a broad role list is reachable by everyone in it. The blast radius of a compromised account is whatever its roles allow.

**Recommended implementation.** Assign roles from an admin screen ([PAS-AUTH-018](#pas-auth-018)) or via `app.invites.create({ role })`; keep first-run bootstrap (the first owner) explicit and one-time. Per action, list only the roles that need it.

**Conforming example.**

```ts
const invite = await app.invites.create({ role: 'coach', uses: 1, expiresIn: '24h' })   // admin chooses the role
// mcp.json: publish_lesson → "auth": { "app_roles": ["coach"] }
```

**Non-conforming example.**

```ts
app.auth.onChange(async (u) => { if (u) await app.roles.assign(u.id, 'editor') })      // everyone becomes editor
// mcp.json: delete_any_lesson → "auth": { "app_roles": ["member", "coach", "editor", "viewer"] }
```

**Evidence.** Source: `roles.assign` call sites and what triggers them; `auth.app_roles` lists in `mcp.json`; onboarding flows that pick a role from client input.

**Remediation.** Remove automatic grants; route grants through admin/invite; tighten each action's role list.

**Tests.** A new account has exactly `member` after first sign-in; each privileged action is denied to `member`.

**Supporting links.** [Authorization model](../authorization-model.md), [SDK overview — surfaces](../sdk-overview.md#surfaces) (`app.invites`).

### PAS-AUTH-016 — Authorization fails closed on the server, with SQL scoping as the final check {#pas-auth-016}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — platform action registration (explicit `requires_auth`; authenticated statements must reference `:__user_id` unless `caller_unscoped` with a reason; public actions are constrained read-only queries) · **Since:** 1.2

**Rule.** Every action MUST default to denied: `requires_auth: true` unless the action is a deliberately public, constrained read; `auth.app_roles` where a role is needed; and SQL that scopes rows to `:__user_id` or a membership sub-query. An unknown or absent role MUST deny. Client-side checks are UX only and MUST NOT be the sole gate.

**Applicability.** All apps with registered actions.

**Rationale.** Role metadata is a coarse early gate; the SQL is the authorization model and the only check an attacker who calls the action directly meets. Chess Academy's write-action audit (`scope app actions to the calling user`, `close write-action audit gaps`) closed exactly this class: actions gated in the UI but unscoped on the server.

**Recommended implementation.** Per action: `requires_auth: true`, minimal `auth.app_roles`, and a `WHERE` that ties every row to the caller. Use `caller_unscoped: { reason }` only for aggregates that return no row data.

**Conforming example.**

```json
{ "name": "update_lesson", "operation": "execute", "requires_auth": true, "auth": { "app_roles": ["coach"] },
  "sql": "UPDATE lessons SET body = :body WHERE id = :id AND club_id IN (SELECT club_id FROM club_members WHERE user_id = :__user_id AND role = 'coach')",
  "params": { "id": { "type": "string" }, "body": { "type": "string" } } }
```

**Non-conforming example.**

```json
{ "name": "update_lesson", "operation": "execute", "requires_auth": true,
  "sql": "UPDATE lessons SET body = :body WHERE id = :id", "params": { "id": { "type": "string" }, "body": { "type": "string" } } }
```

**Evidence.** Configuration: each `mcp.json` statement — `requires_auth`, `auth`, and the `WHERE` clause; every `caller_unscoped` reason; Source: whether the UI is the only place a capability is checked.

**Remediation.** Add the role gate and the scoping predicate; justify or remove each `caller_unscoped`; re-register on deploy.

**Tests.** Calling the action through the SDK as a user without the role returns 403; as a user with the role but for another club's row, it changes nothing.

**Supporting links.** [App actions and data access security — auth rules](../app-actions-security.md#auth-rules), [MCP app tools — security model](../mcp-app-tools.md#security-model), [PAS-STACK-011](./stack.md#pas-stack-011), [Data chapter](./data.md).

### PAS-AUTH-017 — App-defined roles are explicit, documented, and never `owner` {#pas-auth-017}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — platform rejects assigning `owner` and non-conforming role names (`^[a-z][a-z0-9_-]{0,49}$`) · **Since:** 1.2

**Rule.** The app SHOULD define its role vocabulary explicitly (the platform's `member`, `moderator`, `editor`, `viewer` plus any custom lowercase names) and document what each permits, in the repository README or the action descriptions. The app MUST NOT assign `owner` — it is platform-managed for the creator — and MUST NOT let a user choose their own role.

**Applicability.** All apps using app roles.

**Rationale.** Undocumented roles cannot be audited: an auditor cannot say whether `coach` should reach `publish_lesson`. `owner` is the creator's and the platform refuses to assign it; a client-chosen role is self-granted privilege.

**Recommended implementation.** Keep a short role table in the README; use the same names in `auth.app_roles` and `app.roles.assign`; validate role names server-side by using only the documented set.

**Conforming example.**

```text
| Role | Grants |
|---|---|
| member | sign in, view own progress (automatic) |
| coach | create and publish lessons for own club |
| admin | manage club members and roles |
```

**Non-conforming example.**

```ts
await app.roles.assign(user.id, selectedRole)      // selectedRole comes from a <select> the user filled in
await app.roles.assign(user.id, 'owner')             // refused by the platform
```

**Evidence.** Documentation: README role table; Configuration: the set of role names across `mcp.json`; Source: `roles.assign` arguments and their origin.

**Remediation.** Write the table; align names; remove user-chosen roles.

**Tests.** Every role in `auth.app_roles` appears in the table; `app.roles.assign(x, 'owner')` returns 400.

**Supporting links.** [Authorization model — the three systems](../authorization-model.md#the-three-systems), [SDK overview — surfaces](../sdk-overview.md#surfaces).

### PAS-AUTH-018 — Privileged roles are administered through a gated permissions UI {#pas-auth-018}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — `/v1/apps/:id/roles` list/assign/revoke require team `admin`; app-side assignment requires app owner/admin · **Since:** 1.2

**Rule.** An app with privileged roles MUST provide an administration surface — an in-app screen built on `app.roles.listAll` / `assign` / `revoke` and `app.invites`, or the creator console's Roles manager — reachable only by users holding the app's administrative role. It MUST show who granted what and when, and MUST NOT be reachable by URL alone.

**Applicability.** Apps with any role beyond `member`.

**Rationale.** Roles that can only be changed by editing the database are either never revoked or revoked by the wrong person. The platform records `granted_by` / `granted_at` for exactly this. A screen that is hidden but not gated is reachable by anyone who guesses the route.

**Recommended implementation.** Gate the route on `app.roles.check('admin')` (or the app's equivalent) *and* rely on the platform's server-side gate on the roles API. Render the `RoleAssignment` fields including `grantedByLogin` / `grantedAt`. Use invites for onboarding into a role.

**Conforming example.**

```ts
if (!(await app.roles.check('admin'))) return <NotFound />
const assignments = await app.roles.listAll()          // userLogin, roleName, grantedByLogin, grantedAt
await app.roles.revoke(userId, 'coach')
```

**Non-conforming example.**

```ts
<Route path="/secret-admin" element={<RolesPage />} />     // no gate; relies on nobody finding the URL
```

**Evidence.** Source: the admin route and its gate; use of `listAll`/`assign`/`revoke`/`invites`; whether `grantedBy` is displayed. If the app defers to the console, the README says so.

**Remediation.** Add the gate; build or link the roles screen; show provenance.

**Tests.** A non-admin navigating to the admin route sees nothing privileged; an admin can grant and revoke and the change takes effect on the next action call.

**Supporting links.** [SDK overview — surfaces](../sdk-overview.md#surfaces), [Authorization model](../authorization-model.md), [PAS-AUTH-015](#pas-auth-015).

### PAS-AUTH-019 — Privileged operations are gated, scoped, confirmed and logged {#pas-auth-019}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** Destructive, bulk, cross-user or administrative operations MUST be registered actions gated by `auth.app_roles`, scoped in SQL, confirmed in the UI, and recorded with `app.logs` (or an app audit table written in the same batch). `caller_unscoped` MAY be used only for aggregates that return no row data, with a reason.

**Applicability.** Apps with any operation that affects other users' data or the app's configuration.

**Rationale.** These are the operations an audit finding cares most about: they are where an unscoped statement leaks or destroys other users' data, and where the absence of a record makes an incident unreconstructable.

**Recommended implementation.** Use a `batch` action so the change and its audit row commit atomically; put the role gate and scoping on the action; confirm in the UI with the affected count.

**Conforming example.**

```json
{ "name": "remove_member", "operation": "batch", "requires_auth": true, "auth": { "app_roles": ["admin"] },
  "statements": [
    "DELETE FROM club_members WHERE club_id = :club_id AND user_id = :target AND club_id IN (SELECT club_id FROM club_members WHERE user_id = :__user_id AND role = 'admin')",
    "INSERT INTO audit_log (id, actor, action, target, at) VALUES (:__uuid, :__user_id, 'remove_member', :target, :__now)"
  ], "params": { "club_id": { "type": "string" }, "target": { "type": "string" } } }
```

**Non-conforming example.**

```json
{ "name": "reset_all", "operation": "execute", "requires_auth": true, "auth": { "caller_unscoped": { "reason": "admin tool" } },
  "sql": "DELETE FROM lessons WHERE created_at < :before", "params": { "before": { "type": "integer" } } }
```

**Evidence.** Configuration: privileged actions in `mcp.json` — gate, scoping, audit statement, `caller_unscoped` reasons; Source: confirmation UI.

**Remediation.** Convert to gated, scoped batch actions with an audit row; replace `caller_unscoped` on row-returning or mutating statements with real scoping.

**Tests.** Each privileged action is denied without the role, affects only the caller's scope, and leaves an audit row.

**Supporting links.** [App actions security — batch tools](../app-actions-security.md#batch-tools-atomic-multi-statement-actions), [PAS-AUTH-016](#pas-auth-016), [PAS-STACK-021](./stack.md#pas-stack-021).

### PAS-AUTH-020 — Sign-in, sign-out and role changes are verified by a person on the live app {#pas-auth-020}

**Severity:** Medium · **Verification:** Human · **Enforcement:** none (recommended) · **Since:** 1.2

**Rule.** Before an audit closes, a person MUST verify on the deployed app — on the platform subdomain and on each custom domain — every sign-in path the app offers, sign-out, the recovery route, and that granting and revoking a role changes what a second account can do. An AI auditor records this clause as `manual-review` with the checklist; it MUST NOT mark it `pass`.

**Applicability.** All hosted apps with sign-in.

**Rationale.** Cookie attributes, redirect targets, custom-domain serving and role propagation are runtime properties of the deployed system that static evidence cannot prove. Chess Academy's custom-domain and credential-mode failures were invisible in source and found only by driving the live app.

**Recommended implementation.** Run the checklist below with two accounts (one privileged, one `member`), on each hostname, in a fresh browser profile. Record the outcome in the audit report with date and hostnames.

**Conforming example.**

```text
[ ] GitHub sign-in → app.auth.user set; cookie __Host-pas_session present, HttpOnly
[ ] Google / email / credentials sign-in (whichever the app offers)
[ ] Reload while signed in → no sign-in flash, no redirect loop
[ ] Deep link → sign-in → returns to the same path
[ ] Sign-out → /.pas/auth/me is 401; no identity in storage
[ ] /.pas/auth/recover → lands on /?recovered=1 signed out
[ ] Grant a role to account B → B can use the gated action; revoke → B gets 403
[ ] Repeat on each custom domain
```

**Non-conforming example.**

```text
AI report: PAS-AUTH-020 pass (inferred from source)      ← not allowed: Human verification
```

**Evidence.** Runtime: the completed checklist with hostnames, accounts (ids only) and date; Documentation: the audit report.

**Remediation.** Run the checklist; file findings for anything that fails under the clause it breaches.

**Tests.** The checklist is complete for every hostname; every line passed or has a linked finding.

**Supporting links.** [Audit model — verification classes](./audit-model.md#verification-classes), [Browser auth session model — acceptance criteria](../auth-session-model.md#acceptance-criteria).
