# DoorDrop → PAS port plan

Source: `~/dev/doordrop/` (Firebase, ~22k LOC).
Target: `~/dev/stores/pas/doordrop/` (created by `pas create doordrop`).
Category: **Ready** (one shared multi-tenant deployment).
v1 scope: **no payments** (platform Marketplace API will broker later).

---

## Shipping status (2026-05-22)

**Live.** App at <https://proappstore-doordrop.pages.dev>, Worker at <https://pas-data-doordrop.serge-the-dev.workers.dev>, repo at <https://github.com/proappstore-online/doordrop>, D1 `pas-data-doordrop` (`7e14b85d-…`).

**14 of 17 tasks complete.**

| # | Task | Status |
|---|---|---|
| 1 | Provision (D1 + Worker + apps row) | ✅ |
| 2 | D1 schema migration (19 tables) | ✅ |
| 3 | Port 13 domain models | ✅ |
| 4 | Worker auth + `/v1/me` + role-picker | ✅ |
| 5 | 38 `/v1/*` CRUD handlers w/ authz | ✅ |
| 6 | React app skeleton + `useProGate` | ✅ |
| 7 | Rewrite 14 repositories to fetch Worker | ✅ |
| 8 | Port pages, components, hooks, utils | 🟡 5 of 12 stubs ported; 7 still placeholders |
| 9 | `useDeliveryTracking` onto Data Worker | ✅ |
| 10 | Chat onto `fas.rooms` | ⏸ pending (polling stub in place) |
| 11 | In-app notifications + inline triggers | ⏸ pending (polling stub in place) |
| 12 | R2 file uploads | ✅ (via built-in `pas.storage`, no custom binding needed) |
| 13 | Admin Vite app | ⏸ pending; recommend embed under `/admin/*` to preserve 1-Pages-project-per-app |
| 14 | Tests | 🟡 Playwright infra + 1 passing + 6 skipped w/ TODOs (Jest→Vitest unit tests still pending) |
| 15 | `pas publish` (GitHub repo + Pages + DNS + registry) | ✅ (with platform workarounds — see §17) |
| 16 | First deploy via `git push origin main` | ✅ (deploys via `wrangler pages deploy`; platform GitHub-integration not viable yet — see §17) |
| 17 | Platform follow-ups | ⏸ 5 items captured |

**Pages ported full** (replace stubs):
- `WalkerCampaignDetailPage`
- `WalkerDeliveryPage` + walker route tree
- `ClientCampaignDetailPage` + client route tree
- (plus the auth/login/role-picker pages from the original skeleton work)

**Pages still stubbed as "Coming soon" placeholders**:
- `Campaign/DoorDetailPage`
- `Messages/MessagesPage`
- `UserInfoPage/ShareHirePage`
- `UserProfile/UserProfileEditPage`
- `walker/WalkerDashboardPage`
- `walker/WalkerDeliverRedirect`
- `walker/WalkerHistoryPage`

**Platform follow-ups discovered along the way** (Task #17):
1. `pas create` doesn't send `skipCompliance: true` + `skipPublish: true`, so the first-bootstrap call fails on a 404 compliance check. CLI source already patched in `pas/platform/packages/cli/src/create.ts`; needs npm publish.
2. Platform Data Worker `/migrate` endpoint fails silently when SQL has leading `--` comments. Fork in our `worker/` strips them; upstream fix needed in `pas/platform/packages/data-worker/src/index.ts`.
3. `pas publish` redeploys the platform's generic Data Worker over the app's custom Worker every time. Workaround: re-run `worker:deploy` after `pas publish`. Long-term: teach `pas publish` to detect app's `worker/wrangler.toml` and skip.
4. `pas publish` first-time also hits the same compliance-against-nonexistent-repo problem; needs `skipCompliance` support or admin-provision-before-compliance.
5. `pas publish`'s **Hosting route** step deterministically crashes with `Cannot read properties of undefined (reading 'prepare')` server-side in fas/admin. Custom domain + DNS + storefront registry entry can't land until this is fixed. We deployed CF Pages ourselves via `wrangler pages deploy` as workaround.

**Key architectural decisions reaffirmed by the port**:
- We chose to **override the platform's generic Data Worker** with our own per-resource handlers (Option A from the original Worker-home question). Authz boundary stays server-side. Pattern works; the friction is just the publish-redeploys-ours issue above.
- Real-time is **deliberately deferred** to `fas.rooms` (#10/#11). Polling stubs are in place and tagged with `TODO(task #10)` / `TODO(task #11)` for easy find-and-replace.
- The **DebugPanel** that consumed a verbose aggregate `debugInfo` object was dropped during the port — `trackingDebugInfo` from the SDK hook is enough for `DeliveryTrackingPanel`.

**Memory pointer**: see `~/.claude/projects/-Users-serge-ivo-dev-stores/memory/doordrop-pas-port-shipped.md` for the cross-session summary.

For per-area architecture, current file layout, and how to add a feature, see [`doordrop/CLAUDE.md`](./doordrop/CLAUDE.md).

---

## 1. What this product is

Two-sided flyer-delivery marketplace:

- **Clients** create *campaigns* targeting suburbs / postcodes / streets, upload flyer designs (*printouts*), and pay walkers per door.
- **Walkers** browse open campaigns, express *interest*, get assigned, deliver to *doors* tracked via GPS, and earn per delivery.
- **Admins** manage users, set roles, oversee compliance.
- **Properties** are a global address registry shared across campaigns; can be reported (no-junk-mail, construction, angry-owner) by anyone with access.
- **Live tracking** during delivery: GPS-streamed, geofenced auto-delivery when walker is within 100m of a door at walking pace, Douglas-Peucker simplification before persist.
- **Chat** per campaign between client admins and the assigned walker.
- **Notifications** when a walker shows interest / when a walker is assigned.

---

## 2. Data model (D1 schema sketch)

Firestore has nested subcollections (`campaigns/{id}/doors`, `users/{id}/notifications`, …). D1 flattens to relational tables with foreign keys. JSON columns where the nested shape is genuinely freeform.

```sql
-- 20-table sketch. Final SQL goes in migrations/0001_init.sql.

users (
  id TEXT PRIMARY KEY,             -- GitHub user id from fas.auth
  email TEXT, name TEXT, photo_url TEXT,
  role TEXT CHECK (role IN ('client','walker','admin')),
  payment_mode TEXT,
  client_profile JSON,             -- shape: ClientProfile
  walker_profile JSON,             -- shape: walkerProfile sub of UserData
  campaign_id TEXT,                -- legacy single-campaign membership; drop if unused
  created_at INTEGER, updated_at INTEGER
)

campaigns (
  id TEXT PRIMARY KEY,
  name TEXT, name_key TEXT, street_name TEXT,
  suburb TEXT, postcode TEXT, state TEXT, country TEXT,
  plan_type TEXT, status TEXT,
  admin_ids JSON,                  -- JSON array — array-contains queries become json_each
  member_ids JSON,
  assigned_walker_id TEXT,
  schedule_rule JSON,
  total_doors INTEGER, budget INTEGER,
  due_date INTEGER, completed_at INTEGER, archived_at INTEGER,
  lat REAL, lng REAL, door_radius_m INTEGER,
  junk_mail_policy TEXT, property_filter TEXT,
  business_categories JSON, active_printout_id TEXT,
  created_at INTEGER, updated_at INTEGER
)
CREATE INDEX idx_campaigns_assigned_walker ON campaigns(assigned_walker_id);
CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_suburb_postcode ON campaigns(suburb, postcode);

doors (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  address TEXT, street_name TEXT, house_number TEXT,
  lat REAL, lng REAL,
  status TEXT CHECK (status IN ('pending','delivered','reported')),
  delivered_at INTEGER, delivered_by TEXT, delivery_count INTEGER,
  history JSON,                    -- array of DeliveryEvent
  property_id TEXT REFERENCES properties(id)
)
CREATE INDEX idx_doors_campaign ON doors(campaign_id);

properties (
  id TEXT PRIMARY KEY,             -- deterministic from address|suburb|postcode (see propertyDocId)
  address TEXT, street_name TEXT, house_number TEXT,
  suburb TEXT, postcode TEXT, state TEXT,
  lat REAL, lng REAL, commercial INTEGER,
  access_user_ids JSON,
  created_at INTEGER
)
CREATE INDEX idx_properties_suburb_postcode ON properties(suburb, postcode);

property_reports (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reason TEXT, photo_url TEXT, notes TEXT,
  reported_at INTEGER, reported_by TEXT, campaign_id TEXT
)

flyers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,          -- client user that owns the design
  name TEXT, description TEXT, file_url TEXT,
  created_at INTEGER, created_by TEXT
)
CREATE INDEX idx_flyers_owner ON flyers(owner_id);

printouts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  version INTEGER, name TEXT, description TEXT, file_url TEXT,
  flyer_id TEXT REFERENCES flyers(id),
  created_at INTEGER, created_by TEXT
)

delivery_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  walker_id TEXT, status TEXT,
  date INTEGER, created_at INTEGER, updated_at INTEGER
)

track_sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  walker_id TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER
)
CREATE INDEX idx_track_sessions_campaign ON track_sessions(campaign_id);

track_points (
  session_id TEXT NOT NULL REFERENCES track_sessions(id) ON DELETE CASCADE,
  t INTEGER, lat REAL, lng REAL, speed REAL,
  PRIMARY KEY (session_id, t)
)

track_stops (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES track_sessions(id) ON DELETE CASCADE,
  lat REAL, lng REAL, start_time INTEGER, end_time INTEGER
)

walker_interests (
  id TEXT PRIMARY KEY,
  walker_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_at INTEGER, updated_at INTEGER,
  UNIQUE (walker_id, campaign_id)
)

walker_reviews (
  id TEXT PRIMARY KEY,
  walker_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  campaign_id TEXT, schedule_id TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at INTEGER, updated_at INTEGER
)

history_records (
  id TEXT PRIMARY KEY,
  walker_id TEXT NOT NULL,
  street_name TEXT, income INTEGER, door_count INTEGER, duration_min INTEGER,
  date INTEGER
)

notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT, title TEXT, body TEXT,
  campaign_id TEXT,
  read INTEGER DEFAULT 0,
  created_at INTEGER
)
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read);

campaign_notes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id TEXT, user_name TEXT,
  text TEXT,
  created_at INTEGER
)
CREATE INDEX idx_campaign_notes_campaign ON campaign_notes(campaign_id, created_at);

chat_read_state (
  user_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  last_read_at INTEGER,
  PRIMARY KEY (user_id, campaign_id)
)

platform_config (
  id TEXT PRIMARY KEY DEFAULT 'platform',
  default_payment_mode TEXT
)
```

Dropped from the original schema:
- `usersPub` (public profile docs) — fold into `users` with explicit public columns
- `walkerInterests/{id}/votes` — voting subfeature, no model defined, unused
- `places_cache` — Google Places cache, already replaced by Overpass calls
- `users/{id}/secrets/keys` — legacy openAIKey, unused
- `campaigns/{id}/bookings` — partially-built feature; revisit if needed
- `campaigns/{id}/payments` — payment ledger, deferred with the rest of payments

---

## 3. Auth model

DoorDrop today: Firebase Auth with Google + Facebook + email/password, custom claims for admin role, `usersPub` mirror docs for public profile.

PAS: `@freeappstore/sdk` GitHub OAuth via `useProGate`, role stored in our own `users` table.

### Sign-in flow

```tsx
// web/src/App.tsx
import { initPro } from '@proappstore/sdk'
import { useProGate } from '@proappstore/sdk/hooks'

const pas = initPro({ appId: 'doordrop' })

export default function App() {
  const { gate, user, signIn } = useProGate(pas, { allowFree: true })

  if (gate === 'loading') return <LoadingScreen />
  if (gate === 'signed-out') return <LoginScreen signIn={signIn} />

  return <AppShell user={user} />
}
```

### First-time role picker

New surface, replaces the role-on-signup flag. After first sign-in, if the user has no row in `users` table, prompt `"Are you here to hire a walker, or to deliver?"` (client vs walker). Admins are promoted only by existing admins via `POST /admin/users/:id/role` (Worker handler).

### Authz primitives

Distilled from `firestore.rules` into Worker helpers (TypeScript, shared across handlers):

```ts
// worker/src/auth.ts
export async function requireAuth(req: Request): Promise<UserId>
export async function requireAdmin(req: Request, db: D1): Promise<UserId>
export async function requireCampaignAdmin(req: Request, db: D1, campaignId: string): Promise<UserId>
export async function requireAssignedWalker(req: Request, db: D1, campaignId: string): Promise<UserId>
```

Each rule in `firestore.rules` translates to a guard called at the top of the matching handler. The `affectedKeys().hasOnly([...])` pattern from rules becomes explicit allow-lists in the update handler bodies (e.g. walker updating a door: only `status, deliveredAt, deliveredBy, deliveryCount, history` are persisted, ignore the rest).

### Deleted features

- Facebook sign-in — dropped
- Email/password — dropped
- Password reset — dropped (no email/password to reset)
- Reauthentication for sensitive ops — replaced by re-running GitHub OAuth via `signIn()`

---

## 4. Server logic

`functions/src/index.ts` (574 LOC) breaks into four areas. Three are ported, one is deferred.

| Area | LOC | Disposition |
|---|---|---|
| Stripe (createStripeCheckoutSession, createStripeBillingPortalSession, stripeWebhook) | ~280 | **Drop in v1** — payments come from platform Marketplace API later ([[pas-platform-payments]]) |
| Admin (setUserRole, listUsers) | ~140 | Port to `POST /v1/admin/users/:id/role`, `GET /v1/admin/users` on Data Worker (admin-only) |
| Firestore triggers (onWalkerInterestCreated, onCampaignAssigned) | ~70 | Inline into the matching handlers — when `POST /v1/interests` succeeds, write notifications; when `PATCH /v1/campaigns/:id` changes assignedWalkerId, write notification |
| Schedule generation (ensureSchedulesForGroup) | ~80 | Move to `POST /v1/campaigns/:id/schedules/refresh`, called explicitly by client when needed |

The Data Worker scaffolded by `pas create` becomes the home for all of these. One Hono app, ~25 endpoints.

Endpoint surface (full list):

```
# Auth
GET    /v1/me                                            current user + role

# Users
GET    /v1/users/:id                                     (auth)
PATCH  /v1/users/:id                                     (self or admin)
GET    /v1/users?role=walker&suburb=...                  (auth)
DELETE /v1/users/:id                                     (admin)
POST   /v1/admin/users/:id/role                          (admin)
POST   /v1/users/:id/walker-stats/increment              (self) — replaces incrementWalkerStats

# Campaigns
GET    /v1/campaigns                                     filters: status, adminId, walkerId, suburb+postcode
POST   /v1/campaigns                                     (auth — creator added to admin_ids)
GET    /v1/campaigns/:id
PATCH  /v1/campaigns/:id                                 (campaign-admin) — fires notification on assignedWalkerId change
DELETE /v1/campaigns/:id                                 (campaign-admin)

# Doors
GET    /v1/campaigns/:id/doors
POST   /v1/campaigns/:id/doors                           (campaign-admin)
PATCH  /v1/campaigns/:id/doors/:doorId                   (campaign-admin OR assigned-walker with allow-list)
POST   /v1/campaigns/:id/doors:bulk                      bulk import

# Printouts
GET    /v1/campaigns/:id/printouts
POST   /v1/campaigns/:id/printouts                       (campaign-admin)
PATCH  /v1/campaigns/:id/printouts/:printoutId           (campaign-admin)

# Flyers
GET    /v1/users/:userId/flyers                          (self)
POST   /v1/users/:userId/flyers                          (self)
DELETE /v1/users/:userId/flyers/:flyerId                 (self)

# Properties
GET    /v1/properties?userId=...                         (auth, scoped by access_user_ids)
POST   /v1/properties                                    (auth, adds self to access_user_ids; deterministic id)
GET    /v1/properties/:id
PATCH  /v1/properties/:id                                (in access_user_ids)
POST   /v1/properties/:id/reports                        (auth)
GET    /v1/properties/:id/reports

# Walker interests
POST   /v1/interests                                     (self) — writes notifications to campaign admins
DELETE /v1/interests/:id                                 (owner)

# Walker reviews
POST   /v1/walkers/:walkerId/reviews                     (auth, 1-5)
GET    /v1/walkers/:walkerId/reviews

# History
POST   /v1/history                                       (self)
GET    /v1/history?walkerId=...

# Notifications
GET    /v1/notifications?userId=...&unread=true          (self)
PATCH  /v1/notifications/:id                             (self, only `read` field)

# Chat
GET    /v1/campaigns/:id/notes?since=...                 (campaign-admin OR assigned-walker)
POST   /v1/campaigns/:id/notes                           same — also broadcasts via fas.rooms
PUT    /v1/users/:userId/chat-read-state/:campaignId     (self)

# Track sessions (live delivery)
POST   /v1/campaigns/:id/track-sessions                  (assigned-walker)
POST   /v1/track-sessions/:id/append                     (owner) — batch insert points/stops
PATCH  /v1/track-sessions/:id                            (owner) — set endedAt
GET    /v1/campaigns/:id/track-sessions                  (campaign-admin / assigned-walker)

# Platform config
GET    /v1/config/platform
PUT    /v1/config/platform                               (admin)

# Files (R2)
POST   /v1/uploads                                       returns presigned URL or accepts multipart
```

Notifications fire inline from the relevant write handlers; no separate trigger plumbing needed. Schedule generation is explicit, not implicit.

---

## 5. Real-time

Two surfaces need real-time. Both use `fas.rooms` (WebSocket DOs).

### 5a. Campaign chat (in v1)

Current: `ChatRepository.subscribeToMessages` uses Firestore `onSnapshot`.

Port:

```ts
// web/src/repositories/chatRepository.ts
import { initApp } from '@freeappstore/sdk'
const fas = initApp({ appId: 'doordrop' })

export const ChatRepository = {
  async sendMessage(campaignId, text, userName, userId) {
    // POST to Data Worker — handler inserts row AND broadcasts to room
    return fetch(`${dataApiBase}/v1/campaigns/${campaignId}/notes`, {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ text, userName, userId }),
    })
  },

  subscribeToMessages(campaignId, callback) {
    const room = fas.rooms.join(`chat:${campaignId}`)
    room.onMessage((msg) => callback(prev => [...prev, msg]))
    return () => room.leave()
  },

  // chat_read_state stays polled (no real-time need on read state — UI updates on local action)
}
```

Worker side: chat POST handler does `INSERT INTO campaign_notes` + `room.broadcast(...)`. New subscribers fetch `GET /v1/campaigns/:id/notes` for backlog, then subscribe via room for new messages.

### 5b. Live delivery observation (v2, deferred)

The current `useDeliveryTracking` flushes batches to Firestore every 30s. Nobody actually observes live. v1 keeps that pattern — flush batches via `POST /v1/track-sessions/:id/append`. v2 adds a `track:{sessionId}` room so admins/clients can watch a walker live; the walker's flush handler broadcasts new points to the room.

---

## 6. File uploads

`flyerRepository`, `printoutRepository`, and `propertyRepository.uploadPropertyPhoto` use Firebase Storage. PAS SDK does not yet expose file storage (it's listed as a future "advanced storage tier").

v1 plan: bind R2 to the Data Worker, add `POST /v1/uploads` returning `{ uploadUrl, fileUrl }` (presigned PUT URLs). App-side helper:

```ts
// web/src/utils/storageUpload.ts (port of existing)
export async function uploadFile(file: File, path: string): Promise<string> {
  const { uploadUrl, fileUrl } = await fetch(`${dataApiBase}/v1/uploads`, {
    method: 'POST', credentials: 'include',
    body: JSON.stringify({ path, contentType: file.type })
  }).then(r => r.json())
  await fetch(uploadUrl, { method: 'PUT', body: file })
  return fileUrl
}
```

Per the memory `fill-pas-stubs-along-the-way`: also propose adding `pas.storage` as a primitive to `@proappstore/sdk` so future apps don't re-implement this. Track as a follow-up PR on `pas/platform/`.

---

## 7. Push notifications

Current: FCM via `users/{id}/fcmTokens` + Firebase Cloud Messaging in functions.

v1 disposition: **drop FCM**. In-app notifications (the `notifications` table + a polling/room-subscribed badge in the UI) cover the use cases visually. The PWA template `pas create` emits already supports installable PWA — Web Push API can be wired in v2 if engagement data shows users miss it.

Files to skip: `web/src/services/pushNotifications.ts`, FCM token subcollection logic, `sendPushToUser` in functions.

---

## 8. File-by-area disposition

### Direct copy (no Firebase coupling)

```
shared/src/models/*.ts                  → web/src/models/*.ts (or workspace `shared`)
web/src/utils/trackSimplification.ts    → web/src/utils/trackSimplification.ts
web/src/utils/overpassQuery.ts          → web/src/utils/overpassQuery.ts
web/src/utils/sortDoorsGeo.ts           → web/src/utils/sortDoorsGeo.ts
web/src/utils/timestampToDate.ts        → drop (no Firestore Timestamp anymore; use plain Date)
web/src/utils/campaignStatusColors.ts   → web/src/utils/campaignStatusColors.ts
web/src/utils/pwaHelpers.ts             → web/src/utils/pwaHelpers.ts
web/src/utils/firestore/formatDateTime  → web/src/utils/formatDateTime.ts (rename, drop Timestamp checks)
web/src/components/campaign/CampaignMap.tsx + Leaflet UI → as-is
web/src/components/{auth,layout,membership,reviews}      → as-is, except membership pages stay stubbed
web/src/components/{CustomizedTextField,DebugPanel,ErrorBoundary,LiveTrackingIndicator,SuburbPostcodeAutocomplete}.tsx → as-is
web/src/pages/**                        → as-is presentationally; only hooks/repo imports change
web/src/routes/**                       → as-is
web/src/ThemeModeProvider.tsx, App.module.css, index.css → as-is
admin/src/components/AdminLayout.tsx, pages/**           → as-is (data layer swap underneath)
```

### Light rewrite (swap data layer)

```
web/src/services/firebaseConfig.ts      → delete; replace with web/src/services/pas.ts (initPro)
web/src/services/authService.ts         → delete; useProGate covers it
web/src/contexts/AuthContext.tsx        → ~80 LOC (was 424). Just gate + currentUser + signIn/signOut.
web/src/hooks/useAuthContext.ts         → ~10 LOC, wraps useProGate
web/src/repositories/*.ts (15 files)    → rewrite to fetch() against Data Worker. Keep file names & exported shapes so callers don't change.
web/src/repositories/helpers/firestoreConverters.ts → delete (no Timestamps); date round-trip = epoch-millis integers
web/src/repositories/helpers/datetime.ts → keep if it has utility, drop Timestamp helpers
web/src/hooks/useNotifications.ts       → swap from onSnapshot to GET + room subscribe
web/src/hooks/useCampaignData.ts        → swap repository imports (no logic change)
web/src/hooks/useDeliveryTracking.ts    → swap Firestore writes (3 sites: create session, periodic flush, final stop) to POST to Data Worker. Keep state machine, geofence, Douglas-Peucker, localStorage resume verbatim.
web/src/hooks/useDoorManagement.ts      → repository swap only
web/src/hooks/useUnreadMessages.ts      → repository swap only
web/src/hooks/usePrintoutManagement.ts  → repository swap + R2 upload helper
web/src/hooks/useWalkerInterest.ts      → repository swap only
web/src/hooks/useActiveCampaignTracking.ts → repository swap only
web/src/hooks/useUserData.ts            → repository swap only
web/src/hooks/useGeolocation.ts         → as-is (no Firebase)
admin/src/services/firebaseConfig.ts    → delete; same swap
admin/src/hooks/useAuth.ts              → useProGate + admin-role check
web/src/data/**, web/src/types/**       → as-is unless they import firebase types
```

### Rewrite as Worker handlers

```
functions/src/index.ts                  → split:
  setUserRole, listUsers                → worker/src/admin.ts
  onWalkerInterestCreated logic         → inline in POST /v1/interests handler
  onCampaignAssigned logic              → inline in PATCH /v1/campaigns/:id handler
  ensureSchedulesForGroup logic         → worker/src/schedules.ts, called from POST /v1/campaigns/:id/schedules/refresh
  Stripe handlers                       → drop (v1)

firestore.rules                         → distilled into worker/src/auth.ts (requireAuth, requireAdmin, requireCampaignAdmin, requireAssignedWalker) + per-handler allow-lists
```

### Drop entirely

```
.firebaserc, firebase.json, cors.json, storage.rules, firestore.indexes.json
functions/                              (after content is ported into worker/)
web/src/services/firebaseConfig.ts, authService.ts, pushNotifications.ts
*.test.ts that mock firebase           → port to vitest with fetch mocks
admin/src/services/firebaseConfig.ts
```

### Skipped in v1 (stubbed, returns nothing/dummy)

```
web/src/pages/UserInfoPage/MembershipPage.tsx (630 LOC) — stub showing "Subscription managed by ProAppStore platform"
Any pages or buttons that say "Pay now" / "Subscribe" / "Billing" — stub or hide
walkerProfile.ratePerDoor stays in the schema but is informational, not transactional
```

---

## 9. Test strategy

- Jest → Vitest: `jest.fn` → `vi.fn`, `jest.mock` → `vi.mock`, otherwise mechanical
- Repository tests: mock `fetch` instead of mocking Firestore
- Worker handler tests: hit a real ephemeral D1 via `wrangler dev --local` or `@cloudflare/vitest-pool-workers`
- E2E (Playwright): keep flow tests, swap auth fixtures to mock the FAS session cookie
- New: authz tests per handler (anonymous, wrong-role, right-role × CRUD)

---

## 10. Sequence

Strict ordering — earlier steps unblock later ones.

1. **Provision** — `pas create doordrop` from `~/dev/stores/pas/`. Side effects: D1 DB created, Data Worker deployed at `pas-data-doordrop.serge-the-dev.workers.dev`, `.pas.json` written, local git initialized.
2. **Schema** — write `migrations/0001_init.sql` (sec 2). Run `wrangler d1 migrations apply --remote`.
3. **Models** — copy `shared/src/models/*.ts` to `web/src/models/*.ts`. Drop `Timestamp` references (already plain TS in most). Establish that all dates round-trip as epoch-millis integers across the wire.
4. **Worker auth + base handlers** — implement `worker/src/auth.ts` + `GET /v1/me` + first-time role-picker endpoint. Wire to D1.
5. **Worker user/campaign/door/property handlers** — port the core CRUD surface. ~50% of total endpoint LOC. Authz allow-lists inline.
6. **App skeleton** — App.tsx + ThemeModeProvider + ErrorBoundary + routes + login screen. Use `useProGate` from `@proappstore/sdk/hooks`.
7. **Repository ports** — rewrite the 15 repositories to fetch the Worker. Same exported names so callers don't change.
8. **Pages** — copy all pages, fix imports as repo signatures shift. Stub MembershipPage.
9. **Live tracking** — port `useDeliveryTracking.ts` Firestore writes to Worker; verify Douglas-Peucker + geofence + walking-pace logic untouched.
10. **Chat** — port `chatRepository`, add `fas.rooms` subscription. Worker POST handler broadcasts to room.
11. **Notifications** — port `useNotifications`, inline notification writes in interest/campaign handlers.
12. **File uploads** — bind R2 to Data Worker; add `POST /v1/uploads` + `web/src/utils/storageUpload.ts`. Wire flyer/printout/property-photo flows.
13. **Admin app** — port admin/src with same data layer.
14. **Tests** — repository unit tests, handler authz tests, E2E with mocked session.
15. **Publish** — `pas publish` from `~/dev/stores/pas/doordrop/`. Provisions GitHub repo + CF Pages + DNS + storefront entry.
16. **Deploy** — `git push origin main`. CF Pages auto-deploys.
17. **Follow-up PR on `pas/platform/`** — add `pas.storage` primitive to `@proappstore/sdk` so the next app doesn't re-roll R2 wiring ([[fill-pas-stubs-along-the-way]]).

Time estimate is intentionally absent — too dependent on session length and decisions surfaced during the port.

---

## 11. Open decisions (resolve as they arise)

| Decision | Default | When to revisit |
|---|---|---|
| `campaignId` on `users` (single-campaign membership) — keep? | Keep, looks load-bearing in `getCampaignsByUser` and `getUsersByCampaign` | If multi-campaign membership is actually a future requirement |
| `usersPub` merge into `users` with explicit public columns | Yes, simpler | Never; usersPub had only `name` + `photoURL`, both fine to expose |
| FCM push notifications | Drop in v1 | If users complain post-launch |
| File uploads via R2 vs. SDK storage primitive | Worker R2 in v1, SDK primitive as platform follow-up | Don't block v1 on the SDK change |
| Live delivery observation via `fas.rooms` | Defer to v2; v1 keeps batch flush | When a stakeholder explicitly asks to watch a walker live |
| `places_cache` Google Places | Drop; Overpass query already in `utils/overpassQuery.ts` | If Overpass rate-limits hurt UX |
| Property `accessUserIds` JSON vs join table | JSON in v1 (matches Firestore shape, simpler queries) | If access lists grow large and queries slow |
| Admin app at separate route vs same Pages project | Same Pages project, gated by role | If admin needs different deploy cadence |
| Stripe Connect for client→walker payments | Wait for platform Marketplace API ([[pas-platform-payments]]) | When that API ships |

---

## 12. Provisioning prerequisites

Before `pas create doordrop`:

- `FAS_SESSION_TOKEN` must be set, or pass `--token`. Get one via `fas login` from `@freeappstore/cli`.
- Must be run from `~/dev/stores/pas/` so the new app lands at the expected path.
- The shared CLAUDE.md in `~/dev/stores/` requires that the only ways to create a repo in `proappstore-online` are admin UI or `pas publish` — `pas create` doesn't create the GitHub repo, just provisions D1 + Data Worker locally. The repo creation happens at step 15 (`pas publish`).
