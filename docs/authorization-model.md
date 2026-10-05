# Authorization Model — the three role systems and which to use

> **App requirements** for using these role systems correctly are clauses in the [Application Standard — Identity, sessions, and permissions](./standard/auth.md). This page defines the systems; the standard says what an app must do with them and how an audit checks it.

PAS has **three separate role vocabularies**. They were introduced at different
times for different purposes and their value sets *overlap* (`admin`, `owner`,
and `viewer` each appear in more than one, meaning different things). Using the
wrong one — or checking mere *membership* when a *role* is required — is what
produced the 2026-07 privilege-escalation bugs (#78, #79, #95). Read this before
adding any authorization check.

## Why three systems (and why we deliberately do NOT merge them)

The obvious instinct — "collapse everything into one role system" — is **wrong
here**, and it's worth understanding why, because the three answer three
genuinely different questions about three (often disjoint) sets of people.

It is the same separation every mature platform makes. Compare **GitHub**:

| GitHub | PAS equivalent | Governs |
|---|---|---|
| Your **account** (free / pro / staff) | **Platform role** (`user`/`creator`/`admin`) | Your standing with the platform company itself |
| Your **role on a repo** (read/triage/write/maintain/admin) | **Team role** (`viewer`…`owner`) | Whether you may build/operate *this app* |
| The **users of the app you built** (roles *your* app defines) | **App role** (`owner`/`member`/`moderator`/… + custom) | Roles *inside your app's* own product |

Concretely, for the **chess-academy** app:

- **Platform role** — is this person a ProAppStore admin? (Almost always just
  `user`/`creator`.) Nothing to do with chess.
- **Team role** — the *developers building chess-academy*: the creator
  (`owner`), a hired `developer`, a read-only `viewer` reviewer. They touch the
  repo, D1, and deploys.
- **App role** — the *coaches and students using chess-academy*: a coach is a
  `moderator`, a student is a `member`. They never see the repo; they exist only
  inside the app's own domain, and **the app author invents these roles** (custom
  strings are allowed).

These are usually **three different sets of people**. A student using the app
(app `member`) must never gain deploy rights (team `developer`); a hired
contractor who can deploy (team `developer`) is not automatically a platform
`admin`. Merging any two would force one of those wrong grants — you'd be
fighting the conflation forever. So we keep them separate, make the *names*
unmixable (typed `PlatformRole`/`TeamRole`/`AppRole`), and enforce the right one
per scope.

**What actually went wrong** in 2026-07 was never "three systems exist" — it was
(1) the three reuse the words `admin`/`owner`/`viewer`, and (2) some code checked
*membership* ("are you on the team?") where it needed a *role* ("are you an
owner?"). Both are fixed; the three scopes stay.

## The three systems

| System | Values (low → high) | Stored in | Answers |
|---|---|---|---|
| **Platform roles** | `user` · `creator` · `admin` | session JWT (`ADMIN_GITHUB_IDS`) | "What can this identity do on the platform?" (publish, admin endpoints) |
| **Team roles** | `viewer` · `po` · `developer` · `admin` · `owner` | `team_members` table | "What can this user do to *this app's* build/data/config?" |
| **App roles** | `owner` · `member` · `moderator` · `editor` · `viewer` (+ custom) | `app_roles` table | "What can this user do *inside the running app's* domain?" (RBAC the app itself uses) |

## Delegated invite administration is a separate grant, not a fourth role system

Multi-tenant apps can let an in-app administrator invite members without
making them part of the development team. This does not change any of the three
role systems above. Instead, the platform records two additional authorities:

- `app_invite_policies` maps an app data role (for example `org_admin`) to the
  specific app roles it may invite.
- `app_group_admin_grants` gives one user administration of one opaque group id
  within one app.

Both are required for delegated create; delegated list and revoke are limited
to the granted groups. App-team `developer`+ retains its historical app-wide
invite access. A group-admin grant never adds an `app_roles` row or
`team_members` row, and its `(app_id, group_id, user_id)` key prevents a grant
in one app from applying to another. See [Delegated, group-scoped
invites](./delegated-invites.md) for the SDK and management APIs.

### The collisions (read carefully)
- **`admin`** is BOTH a platform role AND a team role. They are unrelated: a
  team `admin` is not a platform `admin`.
- **`owner`** is the top **team** role and also an **app** role. The app-repo/data
  owner is the team `owner`; the creator resolves to team `owner`.
- **`viewer`** is the lowest **team** role and also an **app** role.

Because the words collide, a check that *looks* right can be enforcing the wrong
ladder. Always name which system you mean.

## Which check to use

### Platform-level actions (publish, admin-only endpoints)
Use `requireRole(c, 'admin' | 'creator')` (`backend/src/lib/auth.ts`). Platform
roles come from the signed session; they cannot be forged.

### App build/data/config actions (the common case)
Use **`requireAppAccess(c, appId, minRole)`** (`backend/src/lib/auth.ts`) — the
**one canonical, role-aware** team-role check. It resolves the caller's effective
team role (creator → `owner`, else `team_members.role`) and compares rank against
`minRole`. Examples: reading app data (`viewer`), writing (`developer`),
destructive/deploy/config (`owner`). Prefer `requireAppOwner(c, appId)` for
owner-only.

> **Never gate an app action on membership alone.** `GET /v1/apps` returns every
> app the caller is a team member of **at any role**. `(apps).some(a => a.id === appId)`
> is a *membership* test, not a *role* test — a read-only `viewer` passes it. This
> exact mistake was #78 (data-worker), #79 (agent-teams), and #95
> (`verifyAppOwnership` → MCP).

### App actions from a *separate worker* (can't call `requireAppAccess`)
Per-app workers (data-worker) and the agent-teams DO can't import the backend
helper. They authorize by asking the backend and reading the **`team_role`**
field that `GET /v1/apps` now returns per app, then comparing rank against the
minimum for the route (vendor the `TEAM_ROLES` ladder locally). Fail closed:
absent/unknown role → least privilege. See `packages/data-worker/src/index.ts`
(`authorize(c, minRole)`) and `packages/agent-teams/src/project-do.ts`
(`assertRole` / `minRoleFor`).

### In-app data actions (registered `mcp.json` tools)
Registered actions carry `auth.platform_roles` / `auth.app_roles` metadata,
enforced by `enforceActionAuth` (`backend/src/routes/actions.ts`). **Role
metadata is a coarse gate, not the whole model** — the tool SQL must *also* scope
rows to the caller (`:__user_id`, membership sub-queries). See
[App Actions and Data Access Security](./app-actions-security.md).

### Private apps (`visibility: private`) — who may use the app at all

An app can declare itself private in `mcp.json` (#259):
`"visibility": { "mode": "private", "roles": ["viewer"] }`. This is a gate on the
**whole app**, in front of every check above. It mixes two of the three systems on
purpose, so it is spelled out here:

- **The app's team always passes**, in the sense of `requireAppAccess(c, appId,
  'viewer')`: the creator, **any** `team_members` row of the app (whatever its team
  role), or a platform admin — recognised by `ADMIN_GITHUB_IDS` as well as by the
  session's `admin` role, because a session issued to an app origin carries only
  `['user']` (#56). A team developer can deploy the app and run raw SQL
  against its data worker, so refusing them the app and its console would protect
  nothing and break the console.
- **Anyone else needs one of the declared app roles** (`app_roles`, 0–5 names),
  granted through the ordinary invite flow (`routes/invites.ts`). `member` can
  never be declared: every signed-in user can self-grant it (`ensure-member`),
  the same reason the operator gate refuses it.
- **Role identity.** An `app_roles` row matches the caller's user id. It matches
  the caller's `login` **only for a GitHub (`gh:`) session**, where the login is
  the GitHub-verified login that older, login-keyed grants were written against.
  A credential account's `login` is the display name typed at sign-up, and a
  Google session's is the profile name, so matching them would let anyone
  register an account named `gh:2` or `bob` and take over that holder's role.
  The same rule applies to every app-role check (#272, `lib/role-subject.ts`).
  Until #273 is on main, `lib/visibility.ts` carries its own copy of the rule
  (marked `TODO(#273)`); merge #273 first, then fold it.

`lib/visibility.ts` (`visibilityAllows`) is the single implementation; `GET
/v1/apps/:id/visibility/me` exposes it to the host and the MCP. Where it is
enforced:

| Surface | Enforcement |
|---|---|
| App origin (`/`, assets, `/__qa`), on the platform subdomain or a custom domain | host `visibility-gate.ts`, after `/.pas/auth/*` and before mediation, the edge cache and R2; signed-out navigation → the platform sign-in page `/.pas/auth/signin`; a refused navigation to an invite link `/join/<code>` → the platform invite page `/.pas/auth/join`; anything else 403; never edge-cached |
| Sign-in and invites | platform pages under `/.pas/auth/` (`auth-pages.ts`), which the gate lets through: `/signin` offers GitHub, Google, an emailed link (which also creates an account) and email + password — passkeys are a step-up after sign-in on this platform, not a first factor; `/join` redeems an invite as the session with a same-origin POST, scoped to this app (`POST /v1/invites/:code/redeem` with `{ appId }`), then returns to `/join/<code>` |
| `/.pas/api/*`, `/.pas/data/*`, and the secrets proxy (origin-only, reached through `/.pas/api`) | the same host gate (they are on the app origin) |
| `data-<app>.proappstore.online` | **not gated by the host.** Every SQL route on the data worker requires team `developer`+ (or the platform's internal token), a subset of who the app admits, and the worker also answers on its own custom domain, so a host check would cost every app a D1 read and protect nothing |
| Registered actions | `routes/actions.ts`: a public (`requires_auth: false`) action is refused at registration and at execution, and a console endpoint with `scope: "public"` is refused at creation; every session or app-token caller must pass `visibilityAllows` |
| Public storage `GET /v1/apps/:id/public/*` | `requireVisibleCaller`: no session 401, refused 403; served `private, no-store`, never `public, immutable`. The SDK's `storage.publicUrl()` returns the same-origin `/.pas/api/...` URL on a private app (host marker `<meta name="pas-visibility">`), so an `<img>` carries the session |
| Counters `GET/POST /v1/apps/:id/counters*` | reads `requireVisibleCaller`, writes `requireVisibleUser`; the SDK sends the session on reads when signed in |
| Per-user KV `/v1/apps/:id/kv*`, private storage `/v1/apps/:id/storage/*` and `/v1/apps/:id/files` | `requireVisibleUser` on every route, reads and deletes included (#276): a refused user gets 403 even on their own rows and files, so a private app's storage is not free storage for users it refuses |
| Rooms `GET /v1/apps/:id/rooms/:room` | refused callers' sockets close `4401 app_private` before the room. The room then re-runs the gate on its open sockets every 60 s (a Durable Object alarm, #276) and closes refused ones with the same `4401 app_private`; a failed lookup closes nothing and is retried on the next tick |
| Tool list / per-app MCP | `GET /v1/apps/:id/tools` refuses non-allowed callers; `mcp.proappstore.online/mcp/apps/<id>` refuses the session with 403 |
| Storefront | private apps are absent from `/v1/storefront/apps` and 404 on `/v1/storefront/apps/:id`; the admin publish step never writes a private app to the public `registry.json`, and removes its entry on a republish after it went private |

System identities (`system:schedule`, and the `system:worker` / `system:hook`
callers #251 adds) never pass through the gate: the scheduler forwards to the data
worker directly. A lookup that fails is a 503, never an allow.

**Cost.** On an app origin the visibility mode is read in the route lookup itself
(`host.ts` LEFT JOINs `app_visibility`), so a public app pays no extra D1 read and
no backend call; the `data-<app>` hostname is not gated, so it pays nothing either.
A private app asks the backend (`visibility/me`), and the host remembers the answer
per isolate, keyed by SHA-256(session) + app: an **allow** for 30 s, a **refusal**
(refused, or a session the backend rejects) for 5 s, so a refused or bogus session
costs one backend call per 5 s rather than one per request. A failed lookup is not
cached.

The backend routes that also serve anonymous callers of public apps — public
storage, counter reads and writes, room upgrades — and per-user KV and private
storage read the app's mode from a
per-isolate cache (`getAppVisibilityCached`, 30 s; registering a manifest forgets
the app in that isolate). **Failure mode:** on a D1 error the last known mode is
used, so a D1 blip neither breaks a public app's images nor opens a private app's;
with nothing known (a cold isolate) the request is a **503** — a private app's
files are never served on a guess, so during an outage a cold isolate refuses
public apps' files too. `visibility/me`, actions and the storefront read live.
The room re-check reads live too, once per occupied room per 60 s (and once per
distinct user on a private app).

**Propagation bounds.**

| Change | Takes effect |
|---|---|
| Public → private (new manifest registered) | App origin, `visibility/me`, actions and the tool list: the next request. Public storage, counters and room upgrades: up to 30 s per backend isolate (the mode cache). Nothing on a private app is edge-cached, and a public response cached before the flip is never served because the gate runs before the cache. The MCP may still open an app-scoped session and list the app's tool names and params for up to 10 s (`PUBLIC_APP_TTL_MS`, `TOOL_CACHE_TTL_MS`), but every call is re-checked by the backend. |
| Role revoked, team member removed | Backend routes: the next request. App origin: up to 30 s per host isolate (the allow cache). Open room sockets: closed `4401 app_private` within 60 s (the room's re-check). |
| Role granted, team member added | Backend routes: the next request. App origin: up to 5 s per host isolate (the refusal cache) — at once in the isolate that redeemed it, when it came through the platform invite page. |
| Private → public | App origin and live routes: the next request. Public storage, counters and room upgrades: up to 30 s per backend isolate. |
| Any flip, for an open room socket | Within 60 s (the room's re-check, which reads D1 live). A flip to public closes nothing. |

The KB host reads D1 visibility before serving any app page, asset, custom 404
or conditional response. Private KBs return 404 to browser callers (this origin
has no app session cookie). Platform test-result harvests present INTERNAL_TOKEN;
private responses use `private, no-store`. Lookup failures return an uncacheable
503. Official platform documentation remains public. Public KB responses may
remain in browser caches for their existing TTL after a visibility flip.

**Not covered:**

- **The storefront static site** builds from `registry.json` in
  `proappstore-online/proappstore`. A private app's first publish is kept out of it
  (MCP `publish_app` sends the repo's declared visibility, and the admin registry
  step reads the repo's `mcp.json` when nothing has registered yet), but an app
  published *before* it declared itself private keeps its card until it is
  republished or the storefront build filters private apps. Tracked in
  proappstore-online/proappstore#3.
- **The data worker** (`data-<app>.proappstore.online` and its `workers.dev` URL).
  Its raw-SQL path requires team `developer` or above, and every team member passes
  this gate anyway, so it admits no one the gate would refuse.

## Trust boundaries that are NOT roles

- **`INTERNAL_TOKEN`** proves "a trusted *platform worker* is calling"
  (worker-to-worker). It does **not** prove *which app* — so it must never be the
  sole gate where the real caller is per-app CI or an app origin (that was #57,
  kb-host ingest). App-scope those with GitHub OIDC (the `repository` claim →
  app slug), as the data-worker/QA/R2 deploy paths do.
- **GitHub OIDC** (`repository == proappstore-online/<appId>`, `ref == main`) is
  the keyless, app-scoped identity for CI-initiated writes (tool registration,
  KB ingest, R2 creds).
- **Keyless e2e sessions** (#146): a workflow can also exchange its OIDC token
  for a *user* session — `POST /v1/auth/exchange/oidc` — but only through an
  explicit grant a platform admin creates (`POST /v1/admin/oidc-session-grants`:
  repository, optional workflow, ref → e2e account). The session lasts four
  hours, carries `via: 'oidc-e2e'`, has roles `user` + `creator` and never
  `admin`. The grant, not the workflow, is the authority; revoke it and the
  next run gets 403. This is the last stored credential removed from CI: no
  PAT, no device-flow token in a repo secret.

## Rule of thumb

1. Platform capability? → `requireRole`.
2. Something about an app's build/data/config? → `requireAppAccess(minRole)` (or
   `team_role` rank in a separate worker). **Membership is never enough.**
3. Something the running app enforces on its own users? → app roles + row-scoping SQL.
4. Worker-to-worker? → `INTERNAL_TOKEN`. CI-to-platform? → GitHub OIDC. Neither is a role.

When unsure, pick the **higher** bar and fail closed. Names collide — comment
which system your check belongs to.
