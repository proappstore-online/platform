# Anti-patterns to detect and remediate

Each entry: what to look for (a grep the client can run in the repository, or
a question to ask), why it is wrong, the clause, the remediation, and the test
that proves the fix. Findings cite the clause and the file; they never
paraphrase the rule.

## 1. Session in storage

**Detect:** `grep -rnE "localStorage|sessionStorage|indexedDB" src/ | grep -iE "session|token|pas:"`, and any read of the SDK's `pas:session` key, `#pas_session=`, `?session=`, `?code=`.
**Why:** the platform session is HttpOnly on purpose; a copy in storage is readable by any script on the page and outlives sign-out.
**Clause:** [PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002), [PAS-AUTH-012](https://docs.proappstore.online/standard/auth/#pas-auth-012).
**Remediate:** delete the storage code; rely on `authMode: 'platform-cookie'` and `app.auth.init()`; keep only non-identity preferences in `app.kv`.
**Prove:** after sign-in the live app has no storage key holding identity; after sign-out none remains.

## 2. `app.auth.token` coupling

**Detect:** `grep -rn "auth.token\|Authorization: \`Bearer" src/`, and `fetch` calls to `/v1/auth/`, `/.pas/auth/`, `api.proappstore.online`.
**Why:** in platform-cookie mode there is no bearer token to read; hand-built requests bypass the SDK's same-origin CSRF path.
**Clause:** [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003), [PAS-AUTH-009](https://docs.proappstore.online/standard/auth/#pas-auth-009).
**Remediate:** call the SDK (`app.actions.call`, `app.kv`, `app.storage`, …); for a third-party API use `app.proxy.fetch`.
**Prove:** no `Authorization` header is built in app code; mutations succeed through the SDK; a cross-site POST to `/.pas/api/...` returns 403.

## 3. Home-grown sign-in or session tables

**Detect:** `schema_status` / `migrations.json` containing `users`, `sessions`, `password`, `password_hash`, `jwt`, `refresh_token`, `verification_code`; a registration or "forgot password" form; a third-party identity SDK in `package.json`.
**Why:** identity is the platform's; a second identity store is a second attack surface with no platform protections.
**Clause:** [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004), [PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006).
**Remediate:** `app.auth.signIn` / `signInWithEmail`; for users without email `app.auth.provisionChild` + `signInWithCredentials`; keep a profile table keyed by `:__user_id` if the app needs profile fields, never credentials; add an additive migration that stops using the old columns ([PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002)).
**Prove:** no password material in the schema; every sign-in path completes on the live app.

## 4. Membership-only privileged gates

**Detect:** `grep -rnE "roles\.(myRoles|listAll)\(\)\.then|\.length > 0|includes\('member'\)" src/`; actions with `requires_auth: true` but no `app_roles` that delete, bulk-update or read other users' rows; `app_roles: ["member"]`; team-role or platform-role checks in app code.
**Why:** every signed-in user is `member`; "has any role" is true for everyone; team roles govern who builds the app, not who uses it.
**Clause:** [PAS-AUTH-014](https://docs.proappstore.online/standard/auth/#pas-auth-014), [PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016).
**Remediate:** name the role (`app.roles.check('editor')`, `auth.app_roles: ["editor"]`), scope the SQL to the caller or membership, and comment which of the three role systems each check belongs to.
**Prove:** a fresh account with only `member` is denied every privileged action (403) and a role-holder for another tenant's row changes nothing.

## 5. Unsafe return URLs

**Detect:** `grep -rnE "return_to|returnTo|redirect(_uri|Url)?=" src/`; a return target built from a query parameter or from `document.referrer`; a token, code or user data appended to it.
**Why:** an attacker-controlled return target turns sign-in into an open redirect; data in the URL leaks through logs and history.
**Clause:** [PAS-AUTH-010](https://docs.proappstore.online/standard/auth/#pas-auth-010).
**Remediate:** call `app.auth.signIn(provider)` and let the SDK compute the return from the current location, or pass only a same-origin path you validated (`startsWith('/')` and not `//`).
**Prove:** signing in from a deep link returns to that path and query; an injected external origin is ignored.

## 6. Incomplete sign-out

**Detect:** sign-out handlers that clear storage but never call `app.auth.signOut()`; user data kept in module state or a store after sign-out; no sign-out control in some authenticated screens; an installed PWA with no recovery link.
**Why:** the cookie stays valid until the host worker clears it; cached rows can be shown to the next account on the device.
**Clause:** [PAS-AUTH-007](https://docs.proappstore.online/standard/auth/#pas-auth-007), [PAS-DATA-020](https://docs.proappstore.online/standard/data/#pas-data-020).
**Remediate:** `app.auth.signOut()` (or `ProfileMenu`), clear caches in `app.auth.onChange(null)`, show sign-out in every authenticated state, link `/.pas/auth/recover` for installed apps.
**Prove:** after sign-out `/.pas/auth/me` answers 401 and no user data remains in memory or storage.

## 7. Missing negative authorization tests

**Detect:** no test in `pnpm test` or `e2e/` that calls a scoped action as a second user against the first's ids; tests that only cover the happy path; `mcp.json` changed without a test change.
**Why:** scoping bugs are silent — a query that returns too many rows still "works".
**Clause:** [PAS-DATA-022](https://docs.proappstore.online/standard/data/#pas-data-022), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016).
**Remediate:** for every scoped action add a test as user B against user A's ids asserting no rows and no change, a positive test for A, and a "member only" test for each `app_roles` gate; run them in CI.
**Prove:** CI fails when a scoping predicate is removed.

## 8. UI guard as the boundary

**Detect:** a route or button hidden by `app.roles.check(...)` whose action has no `app_roles` and no scoping; an admin page reachable by URL with data loading before the role check.
**Why:** the client is under the user's control; anything it can request, anyone can request.
**Clause:** [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016), [PAS-AUTH-018](https://docs.proappstore.online/standard/auth/#pas-auth-018).
**Remediate:** keep the UI guard for UX and gate the action in the manifest and SQL; make the admin screen render nothing privileged until the role check resolves, and treat a failed check as an error state ([PAS-AUTH-008](https://docs.proappstore.online/standard/auth/#pas-auth-008)).
**Prove:** calling the action directly through the SDK without the role returns 403.
