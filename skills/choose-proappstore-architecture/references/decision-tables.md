# Decision tables

Each row: the need, the platform primitive to recommend, the standard clause
that governs it, the capability page, and what not to use. Limits are the
platform's current, enforced ones. Clause URLs are stable.

## Data

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Records users create and query; anything relational, searched, exported | **D1 via registered actions** (`mcp.json`, `app.actions.call`) | [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007), [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003) | [app actions security](https://docs.proappstore.online/app-actions-security/), [MCP app tools](https://docs.proappstore.online/mcp-app-tools/) | Firestore, Supabase, Mongo; raw `app.db.*` in user code |
| Schema and its evolution | **`migrations.json`**, additive, applied by the deploy | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) | [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) | runtime DDL, `DROP`/`RENAME` |
| Rows shared by an organisation / project / class | membership sub-queries on `:__user_id` in every statement; `app.db.tenant()` for team tooling | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011) | [tailored vs ready](https://docs.proappstore.online/tailored-vs-ready/) | a client-supplied tenant id as the only filter |
| Multi-step writes that must not half-apply | **batch actions** (`operation: "batch"`, ≤ 25 statements, one transaction) | [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009) | [app actions security](https://docs.proappstore.online/app-actions-security/) | sequential client calls |
| Ownership, state transitions, uniqueness | enforced **inside the statement** (`WHERE owner_id = :__user_id`, `AND status = 'open'`, `UNIQUE`) | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) | [app actions security](https://docs.proappstore.online/app-actions-security/) | client-side checks alone |
| Search, export, statistics | scoped and paginated like the list actions; `caller_unscoped` only for true aggregates | [PAS-DATA-012](https://docs.proappstore.online/standard/data/#pas-data-012) | [DATA chapter](https://docs.proappstore.online/standard/data/) | an unscoped export "for admins" |
| Lists | bounded `LIMIT` + keyset cursor | [PAS-DATA-010](https://docs.proappstore.online/standard/data/#pas-data-010) | [recipes: data-table](https://docs.proappstore.online/recipes/) | `OFFSET`, unbounded `SELECT *` |
| Per-user preferences, drafts, small state | **`app.kv`** — 100 keys, 64 KB/value, 1 MB/user | [PAS-STACK-009](https://docs.proappstore.online/standard/stack/#pas-stack-009), [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013) | [recipe kv-preferences](https://docs.proappstore.online/recipes/) | `localStorage` for identity or shared data; KV for relational data |
| Counts many users bump | **`app.counters`** (atomic) | [PAS-STACK-010](https://docs.proappstore.online/standard/stack/#pas-stack-010) | [SDK overview](https://docs.proappstore.online/sdk-overview/) | read-modify-write on KV/D1 |
| Files, images, documents | **`app.storage`** — 50 MB/object; keep the key in D1 | [PAS-STACK-012](https://docs.proappstore.online/standard/stack/#pas-stack-012), [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013) | [recipe file-upload](https://docs.proappstore.online/recipes/) | base64 in D1/KV; S3/Cloudinary with client keys |
| Upload validation and rendering | `accept` list + type/size checks before `upload`; never render uploads as active content | [PAS-UI-016](https://docs.proappstore.online/standard/ui/#pas-ui-016) | [UI chapter](https://docs.proappstore.online/standard/ui/) | `<iframe>`/inline HTML of user files |
| Caches | in-memory for the session only | [PAS-DATA-020](https://docs.proappstore.online/standard/data/#pas-data-020) | — | persisting scoped rows in the browser |

## Realtime

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Presence, cursors, chat-light, signalling, lightweight multiplayer | **`app.rooms`** — 32 peers/room, no per-app room cap, 100 msg/s, 4 KB/msg, 24 h idle, **nothing persisted**, payloads untrusted | [PAS-STACK-013](https://docs.proappstore.online/standard/stack/#pas-stack-013), [PAS-DATA-017](https://docs.proappstore.online/standard/data/#pas-data-017) | [recipe realtime-chat](https://docs.proappstore.online/recipes/) | Pusher/Ably/Socket.IO servers, Firebase RTDB |
| State that must survive a reload or be seen by absent users | write it through an **action** | [PAS-DATA-017](https://docs.proappstore.online/standard/data/#pas-data-017) | — | trusting a room message as the record |
| Server-authoritative game/world state, > 32 peers, persistent worlds | **unsupported for static apps** — see unsupported requirements | — | — | an own WebSocket server |

## Identity and permissions

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Sign-in | **`app.auth`** (GitHub, Google, email magic link, provisioned credentials) in **platform-cookie** mode | [PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006), [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001) | [auth session model](https://docs.proappstore.online/auth-session-model/) | Firebase/Auth0/Clerk, own passwords |
| Who may do what inside the app | **`app.roles`** + `auth.app_roles` on actions + SQL scoping; `app.invites` to onboard into a role | [PAS-STACK-014](https://docs.proappstore.online/standard/stack/#pas-stack-014), [PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013), [PAS-AUTH-014](https://docs.proappstore.online/standard/auth/#pas-auth-014) | [authorization model](https://docs.proappstore.online/authorization-model/), [recipe roles-rbac](https://docs.proappstore.online/recipes/) | team or platform roles for app features; `member` as a privilege |
| Admin surface for roles | in-app screen on `app.roles.listAll/assign/revoke` or the console | [PAS-AUTH-018](https://docs.proappstore.online/standard/auth/#pas-auth-018) | — | editing the database |

## Integrations

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Call an external API with a key | **`pas secret` + `pas proxy allow` + `app.proxy.fetch`** — 10 000 req/day/app, needs platform-cookie mode | [PAS-STACK-015](https://docs.proappstore.online/standard/stack/#pas-stack-015) | [CLI overview](https://docs.proappstore.online/cli-overview/) | keys in `VITE_*`/source |
| Text generation, chat, embeddings | **`app.ai`**; BYO provider via the proxy | [PAS-STACK-016](https://docs.proappstore.online/standard/stack/#pas-stack-016) | [recipe ai-chat](https://docs.proappstore.online/recipes/) | provider SDK in the browser |
| Maps, geocoding, routing | **`app.maps`** (OpenStreetMap, no key) | [PAS-STACK-017](https://docs.proappstore.online/standard/stack/#pas-stack-017) | [recipes map-embed, maps-autocomplete](https://docs.proappstore.online/recipes/) | Google Maps/Mapbox keys |
| Push notifications | **`app.notifications`** | [PAS-STACK-018](https://docs.proappstore.online/standard/stack/#pas-stack-018) | [recipe notifications](https://docs.proappstore.online/recipes/) | OneSignal/FCM |
| Email, SMS, outbound webhooks | **`app.email`** (quota applies), **`app.sms`** (creator-only), **`app.webhooks`** | [PAS-STACK-019](https://docs.proappstore.online/standard/stack/#pas-stack-019) | [recipe email-send](https://docs.proappstore.online/recipes/) | SendGrid/Twilio from the browser |
| Pro features / charging | the **platform subscription**: `app.subscription`, `useProGate`, `GateScreen`; `app.license` where a key is needed | [PAS-STACK-020](https://docs.proappstore.online/standard/stack/#pas-stack-020) | [stripe & entitlements](https://docs.proappstore.online/stripe-entitlements/), [recipe stripe-paywall](https://docs.proappstore.online/recipes/) | own Stripe checkout, per-app prices |
| Let AI agents operate the app | the same **`mcp.json` actions** via `mcp.proappstore.online` | [PAS-STACK-023](https://docs.proappstore.online/standard/stack/#pas-stack-023) | [MCP app tools](https://docs.proappstore.online/mcp-app-tools/) | a second agent API |
| See failures in production | **`app.logs`** (auto) + the runbook | [PAS-STACK-021](https://docs.proappstore.online/standard/stack/#pas-stack-021), [PAS-OPS-012](https://docs.proappstore.online/standard/ops/#pas-ops-012) | [monitoring runbook](https://docs.proappstore.online/monitoring-runbook/) | GA/Mixpanel/Sentry-style trackers |
| App shell, gates, profile, dark mode | **`ProShell`** or the `@proappstore/sdk/ui` components on the design tokens | [PAS-STACK-022](https://docs.proappstore.online/standard/stack/#pas-stack-022), [PAS-UI-001](https://docs.proappstore.online/standard/ui/#pas-ui-001) | [UI components](https://docs.proappstore.online/ui/) | brand overrides |
| Installable / offline shell | the template's PWA config (service worker, manifest) | [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018) | [UI chapter](https://docs.proappstore.online/standard/ui/) | caching `/.pas/*` |
| Background / scheduled work | an idempotent, `LIMIT`-bounded `execute` / `batch` action with fixed `schedule: { cron, params }`, `requires_auth: true`, and `auth.caller_unscoped.reason` (≤5 per app, ≥5-minute UTC cadence) | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019) | [MCP app tools](https://docs.proappstore.online/mcp-app-tools/#scheduled-actions) | browser timers, external cron, own Worker |
| Idempotent writes | client ids + `INSERT OR IGNORE` / state guards | [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) | — | blind retries |
| Recovery | export/import actions, soft deletes, README recovery section | [PAS-OPS-014](https://docs.proappstore.online/standard/ops/#pas-ops-014) | — | assuming a restore exists |

## Stack decisions that are not choices

Toolchain, template, SDK-only access, CLI-managed lifecycle and the keyless
deploy are fixed by [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001) to
[PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005); hosted apps run in
platform-cookie mode ([PAS-STACK-003](https://docs.proappstore.online/standard/stack/#pas-stack-003)). The
full decision tree is in the [STACK chapter](https://docs.proappstore.online/standard/stack/).
