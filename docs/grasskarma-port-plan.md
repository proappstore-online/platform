# GrassKarma → PAS port plan

Source: `https://github.com/grasskarma/site` (Firebase, two pnpm workspace packages — `web/` + `admin/` + `functions/`).
Target: `~/dev/stores/pas/grasskarma/` (created by `pas create grasskarma`).
Category: **Ready** (one shared multi-tenant deployment).
v1 scope: **no payments** (platform Marketplace API will broker later — see [[pas-platform-payments]]).

Companion plan: [doordrop-port-plan.md](./doordrop-port-plan.md). This plan diverges from it in one important way — see the **Architecture correction** below.

---

## 0. Architecture correction (vs. doordrop plan)

The doordrop port plan describes a per-app Hono Data Worker with `/v1/` endpoints, distilled `firestore.rules` into `requireAuth/requireAdmin/...` helpers, and `wrangler d1 migrations apply --remote` for schema. **That is not how PAS apps actually work** (confirmed by reading `pas/dating/` and `pas/carsads/`).

The real shape:

- **No per-app Worker code.** Apps are pure SPAs (`web/`) that talk to the platform's pre-built per-app data Worker via the SDK. The data Worker is provisioned automatically at `pas publish` time at `https://pas-data-<appId>.serge-the-dev.workers.dev`.
- **No Hono, no `/v1/` endpoints**, no app-defined routes. Everything is `app.db.query(sql, params)`, `app.db.execute(sql, params)`, `app.db.batch([...])` from the client. The SDK injects the signed-in user id and scopes queries to this app's D1.
- **Migrations are client-defined and SDK-applied.** Declare `const MIGRATIONS = [{ name: '0001_init', sql: '...' }, ...]` in a `lib/db.ts`-style file and call `app.db.migrate(MIGRATIONS)` from a once-per-session `ensureMigrated()`. No wrangler commands.
- **Server-side authz is the platform's job, not the app's.** A signed-in user can in principle craft any SQL against this app's D1 — there's no app-defined gate. So `role = 'admin'` is a **UI signal**, not a security boundary. Anything that requires hard authz (promoting another user, deleting another user's data) is *deferred* until the platform exposes server-side handlers or RLS — same waiting game as the payments SDK. This affects `setUserRole`, `listUsers`, group-admin write privileges, and admin role of `mower_reviews` delete.
- **R2 file uploads are SDK-only.** `app.storage.upload/download/list/delete`. No app Worker, no presigned URLs, no R2 binding declared by the app.

Net effect on the rest of this plan:

- Section **2** stays — same schema, but defined as a JS migration array.
- Section **4** is rewritten: drop the Hono endpoint surface; the equivalent is just "lib functions that wrap `app.db.*` calls". The admin operations get deferred or stubbed.
- Section **6** stays — R2 uploads happen via `app.storage`, not via a `POST /v1/uploads` we own.
- Section **8** "Rewrite as Worker handlers" becomes "Move into `web/src/lib/*`".
- Section **10** sequence drops the Worker steps; everything happens in `web/`.
- Section **12** clarifies that `pas create` only scaffolds; D1 + data Worker are created at `pas publish`.

The doordrop port plan is left as-is; whoever ports doordrop will hit the same realisation and want to revisit it.

---

## 1. What this product is

Three-sided hyper-local lawn-care marketplace organised around the **street group**:

- **Clients** (homeowners) join or create a street group keyed by suburb + postcode + street, browse interested mowers, vote them in, and pay the mower for recurring service.
- **Mowers** (providers) browse open street groups, *express interest*, get voted in by the group's members, run a recurring schedule, and earn per job.
- **Admins** manage users, change roles, moderate groups and reviews.

Supporting features that exist in the current code:

- **Mower interests + member voting.** A mower declares interest in a street group; members of that group vote +1/-1; the group's admins finalise the assignment. (`mowerInterests/{id}/votes` subcollection in Firestore.)
- **Per-group schedules.** Top-level `schedules` collection plus a `streetGroups/{id}/schedules` subcollection — currently both exist; the nested one is canonical going forward (the top-level is legacy from a pre-grouping prototype).
- **Mower reviews.** Two locations in Firestore (`users/{uid}/reviews` legacy + top-level `mowerReviews`) collapse to one `mower_reviews` table.
- **Public mower directory.** `MowersPage` (client side) and `/mower/:mowerId` public profile route browse mowers by suburb/postcode.
- **History.** `historyRecords` collection — each completed job logs door count, duration, income.
- **Separate admin app.** `admin/` is its own React app with its own Vite build and its own AuthContext; `/admin/*` on the public site is just an `<AdminRedirect>` that bounces to the admin subdomain. Port keeps this split.

There is **no chat**, **no live tracking**, **no GPS**, and **no push notifications** in the current product. v1 also doesn't add them.

---

## 2. Data model (D1 schema sketch)

Firestore: 11 collections + 2 subcollections (`streetGroups/{id}/schedules`, `mowerInterests/{id}/votes`). D1 flattens to a relational schema with JSON columns for the few genuinely freeform fields. Dates round-trip as epoch-millis integers across the wire.

```sql
-- ~10-table sketch. Final SQL goes in migrations/0001_init.sql.

users (
  id TEXT PRIMARY KEY,             -- GitHub user id from fas.auth
  email TEXT, name TEXT, photo_url TEXT,
  role TEXT CHECK (role IN ('client','mower','admin')),
  suburb TEXT, postcode TEXT, state TEXT, country TEXT,
  lat REAL, lng REAL,
  client_profile JSON,             -- shape: ClientProfile (street address, preferences, ...)
  mower_profile JSON,              -- shape: MowerProfile (rate per lawn, equipment, blurb, ...)
  street_group_id TEXT,            -- legacy single-group membership; see open decisions
  created_at INTEGER, updated_at INTEGER
)
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_suburb_postcode ON users(suburb, postcode);

street_groups (
  id TEXT PRIMARY KEY,
  name TEXT, street_name TEXT,
  suburb TEXT, postcode TEXT, state TEXT, country TEXT,
  center_lat REAL, center_lng REAL,
  admin_ids JSON,                  -- JSON array — array-contains queries become json_each
  member_ids JSON,                 -- JSON array; see open decisions for join-table tradeoff
  assigned_mower_id TEXT,
  status TEXT,                     -- 'forming' | 'active' | 'paused' | 'archived'
  created_at INTEGER, updated_at INTEGER
)
CREATE INDEX idx_street_groups_assigned_mower ON street_groups(assigned_mower_id);
CREATE INDEX idx_street_groups_suburb_postcode ON street_groups(suburb, postcode);
CREATE INDEX idx_street_groups_status ON street_groups(status);

street_group_interests (             -- "I (client) want to join this group"
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES street_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  message TEXT,
  created_at INTEGER,
  UNIQUE (group_id, user_id)
)

mower_interests (                    -- "I (mower) want to mow this street"
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES street_groups(id) ON DELETE CASCADE,
  mower_id TEXT NOT NULL,
  message TEXT,
  created_at INTEGER, updated_at INTEGER,
  UNIQUE (mower_id, group_id)
)
CREATE INDEX idx_mower_interests_group ON mower_interests(group_id);

mower_interest_votes (
  interest_id TEXT NOT NULL REFERENCES mower_interests(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  vote INTEGER CHECK (vote IN (-1, 1)),
  created_at INTEGER,
  PRIMARY KEY (interest_id, voter_id)
)

schedules (                          -- per-group recurring mowing schedule
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES street_groups(id) ON DELETE CASCADE,
  day_of_week INTEGER,               -- 0..6
  start_time TEXT,                   -- 'HH:MM'
  mower_id TEXT,
  status TEXT,                       -- 'planned' | 'done' | 'skipped'
  due_date INTEGER, completed_at INTEGER,
  created_at INTEGER, updated_at INTEGER
)
CREATE INDEX idx_schedules_group ON schedules(group_id, day_of_week);
CREATE INDEX idx_schedules_mower ON schedules(mower_id, due_date);

mower_reviews (
  id TEXT PRIMARY KEY,
  mower_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  group_id TEXT, schedule_id TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at INTEGER, updated_at INTEGER
)
CREATE INDEX idx_mower_reviews_mower ON mower_reviews(mower_id);

history_records (                    -- per-job log shown on mower history page
  id TEXT PRIMARY KEY,
  mower_id TEXT NOT NULL,
  group_id TEXT, schedule_id TEXT,
  street_name TEXT,
  lawn_count INTEGER, duration_min INTEGER, income INTEGER,
  date INTEGER
)
CREATE INDEX idx_history_mower ON history_records(mower_id, date);

platform_config (
  id TEXT PRIMARY KEY DEFAULT 'platform',
  default_currency TEXT
)
```

Dropped from the original schema:

- `usersPub` (public profile docs) — folded into `users` with explicit public columns (`name`, `photo_url`, `suburb`, `postcode`, `mower_profile.blurb`)
- `users/{uid}/reviews` (legacy mower-review subcollection) — collapsed into `mower_reviews`
- top-level `schedules` (legacy pre-grouping) — replaced by `streetGroups/{id}/schedules` shape under `schedules.group_id`
- `streetGroupPayments` — payment ledger, deferred with the rest of payments
- `posts` — declared in rules, unused in code

---

## 3. Auth model

GrassKarma today: Firebase Auth with Email/password + Google + Facebook, custom claims for admin role (`request.auth.token.role == 'admin'`), `usersPub` mirror docs for public profile.

PAS: `@proappstore/sdk` GitHub OAuth via `useProGate`, role stored in our own `users` table.

### Sign-in flow

```tsx
// web/src/App.tsx
import { initPro } from '@proappstore/sdk'
import { useProGate } from '@proappstore/sdk/hooks'

const pas = initPro({ appId: 'grasskarma' })

export default function App() {
  const { gate, user, signIn } = useProGate(pas, { allowFree: true })

  if (gate === 'loading') return <LoadingScreen />
  if (gate === 'signed-out') return <LoginScreen signIn={signIn} />

  return <AppShell user={user} />
}
```

### First-time role picker

New surface, replaces the role-on-signup field in the Firebase signup form. After first sign-in, if the user has no row in `users` table, prompt `"Are you here to hire a mower for your street, or to mow streets?"` (client vs mower). Admins are promoted only by existing admins via `POST /v1/admin/users/:id/role` (Worker handler).

### Authz primitives

Distilled from `firestore.rules` into Worker helpers (TypeScript, shared across handlers):

```ts
// worker/src/auth.ts
export async function requireAuth(req: Request): Promise<UserId>
export async function requireAdmin(req: Request, db: D1): Promise<UserId>
export async function requireGroupAdmin(req: Request, db: D1, groupId: string): Promise<UserId>
export async function requireGroupMember(req: Request, db: D1, groupId: string): Promise<UserId>
export async function requireAssignedMower(req: Request, db: D1, groupId: string): Promise<UserId>
```

Each rule in `firestore.rules` translates to a guard called at the top of the matching handler. Update-allow-lists are explicit in each handler body (e.g. a mower marking a schedule done: only `status, completed_at, lawn_count, duration_min` are persisted, the rest is ignored).

### Deleted features

- Facebook sign-in — dropped
- Email/password — dropped
- Password reset (`/reset-password`, `ResetPasswordPage`, `ResetPasswordModal`) — dropped (no email/password to reset)
- Reauthentication for sensitive ops — replaced by re-running GitHub OAuth via `signIn()`

---

## 4. Data layer

`functions/src/index.ts` (456 LOC) has five exports. None survive — payment ones are deferred, admin ones become best-effort client-side helpers.

| Area | Disposition |
|---|---|
| `setUserRole`, `listUsers` (admin Cloud Functions) | UI-only admin surface in v1. Stubbed `app.db.execute('UPDATE users SET role = ? WHERE id = ?', ...)` call works but is not security-enforced — see §0. Flag for follow-up when the platform exposes server-side authz. |
| `createStripeCheckoutSession(streetGroupId)` | **Drop in v1** — payments come from platform Marketplace API later ([[pas-platform-payments]]) |
| `createStripeBillingPortalSession` | **Drop in v1** — same |
| `stripeWebhook` (HTTP, signature-verified) | **Drop in v1** — same |

There are no Firestore triggers and no scheduled functions to port.

### Lib surface (replaces the endpoint surface)

`web/src/lib/db.ts` exports thin functions wrapping `app.db.*`. One file or a small set (`lib/users.ts`, `lib/streetGroups.ts`, `lib/interests.ts`, `lib/schedules.ts`, `lib/reviews.ts`, `lib/history.ts`) — TBD, follow whatever shape feels right when porting.

```ts
// Auth
getMe(): Promise<UserRow | null>                     // SELECT FROM users WHERE id = app.auth.user.id

// Users
getUser(id): Promise<UserRow | null>
updateUser(id, patch): Promise<void>                 // self only (caller checks); UI-only
listUsers({ role?, suburb?, postcode? }): Promise<UserRow[]>
adminListAllUsers(): Promise<UserRow[]>              // UI-gated to role='admin' only; not security-enforced
adminSetRole(id, role): Promise<void>                // same

// Street groups
listGroups(filter): Promise<StreetGroupRow[]>
getGroup(id): Promise<StreetGroupRow | null>
createGroup(input): Promise<string>                  // adds creator to admin_ids + member_ids
updateGroup(id, patch): Promise<void>
deleteGroup(id): Promise<void>

// Interests
createGroupInterest(groupId, message): Promise<void>
deleteGroupInterest(id): Promise<void>
createMowerInterest(groupId, message): Promise<void>
deleteMowerInterest(id): Promise<void>
voteOnMowerInterest(interestId, vote: -1 | 1): Promise<void>

// Schedules
listSchedules(groupId): Promise<ScheduleRow[]>
createSchedule(groupId, input): Promise<string>
updateSchedule(id, patch): Promise<void>             // mower-allow-list for status/completion
deleteSchedule(id): Promise<void>

// Mower reviews
createReview(mowerId, input): Promise<string>
listReviews(mowerId): Promise<MowerReviewRow[]>
updateReview(id, patch): Promise<void>
deleteReview(id): Promise<void>

// History
recordHistory(input): Promise<string>
listHistory(mowerId): Promise<HistoryRecordRow[]>
```

Each function is a few lines: SQL string + params + map row → domain type. Pattern matches `pas/dating/web/src/lib/db.ts` closely.

---

## 5. Real-time

**None in v1.** GrassKarma has no chat, no live tracking, no FCM. Nothing in the current codebase subscribes via `onSnapshot` for live updates other than the AuthContext listening for Firebase auth state changes (replaced by `useProGate`).

If a v2 surfaces a need (e.g. live "is the mower coming today" indicator), `fas.rooms` is the path — same pattern documented in [doordrop-port-plan.md §5](./doordrop-port-plan.md#5-real-time).

---

## 6. File uploads

Avatar photos (and any before/after lawn photos) use Firebase Storage today.

v1 plan: **use `app.storage`** — the SDK already exposes it (skills.md §SDK). No per-app R2 binding, no `POST /v1/uploads` to own.

```ts
// web/src/lib/photos.ts
import { app } from './app'

export async function uploadAvatar(userId: string, file: File): Promise<string> {
  const key = `avatars/${userId}.jpg`
  await app.storage.upload(key, file, file.type || 'image/jpeg')
  return key
}

export function avatarUrl(key: string): string {
  return `${app.config.storageBase}/${key}` // or whatever the SDK exposes for read URLs
}
```

The earlier worry (in doordrop's plan) that the SDK didn't have storage is obsolete — it does, per the current skills.md. The `fill-pas-stubs-along-the-way` follow-up may still be worthwhile if `app.storage` turns out to have rough edges during the port.

---

## 7. Push notifications

GrassKarma has none. Nothing to port, nothing to drop.

---

## 8. File-by-area disposition

### Direct copy (no Firebase coupling)

```
web/src/models/*.ts                          → web/src/models/*.ts
web/src/utils/* (non-firestore)              → web/src/utils/* (drop any timestampToDate / Firestore helpers)
web/src/ThemeModeProvider.tsx, App.module.css, index.css → as-is (teal/green palette stays)
web/src/components/auth/Background.tsx, WelcomeSection.tsx → as-is (presentational)
web/src/components/layout/MainLayout.tsx     → as-is
web/src/pages/error/ErrorPage                → as-is
web/src/pages/UserProfile/**                 → as-is presentationally
web/src/pages/UserInfoPage/{DashboardPage,MowersPage,ShareHirePage}.tsx → as-is presentationally
web/src/pages/StreetGroup/StreetGroupSetupPage.tsx → as-is presentationally
web/src/pages/mower/**                       → as-is presentationally
admin/src/components/**, pages/admin/**      → as-is presentationally (data layer swap underneath)
```

### Light rewrite (swap data layer)

```
web/src/services/firebaseConfig.ts           → delete; replace with web/src/services/pas.ts (initPro)
web/src/services/authService.ts              → delete; useProGate covers it
web/src/contexts/AuthContext.tsx             → reduce to gate + currentUser + signIn/signOut (~80 LOC)
web/src/hooks/useAuthContext.ts              → ~10 LOC, wraps useProGate
web/src/repositories/*.ts (8 files)          → rewrite to fetch() against Data Worker. Keep file names & exported shapes so callers don't change.
web/src/repositories/helpers/*               → drop Firestore Timestamp helpers; keep any pure date/format helpers
web/src/routes/PrivateRoute.tsx              → swap Firebase auth check for useProGate + users-table role check
web/src/pages/auth/LoginPage.tsx             → drop email/password form; keep WelcomeSection + a single GitHub sign-in button
web/src/components/auth/AuthDialog.tsx, LoginForm.tsx → drop (email/password)
web/src/pages/AdminRedirect.tsx              → as-is (it's just a route bounce)
admin/src/services/firebaseConfig.ts         → delete; same swap
admin/src/contexts/* + hooks/useAuth.ts      → useProGate + admin-role check
admin/src/repositories/*                     → same fetch-against-Worker rewrite
```

### Move into `web/src/lib/*`

```
functions/src/index.ts                       → split:
  setUserRole, listUsers                     → web/src/lib/admin.ts (UI-only, not security-enforced — see §0)
  createStripe*                              → drop (v1)
  stripeWebhook                              → drop (v1)

firestore.rules                              → become inline UI-level checks (e.g. `if (currentUser.role !== 'admin') redirect`). Real authz is deferred to the platform.
```

### Drop entirely

```
.firebaserc, firebase.json, cors.json, storage.rules, firestore.indexes.json
functions/                                   (after content is ported into worker/)
web/src/services/firebaseConfig.ts, authService.ts
web/src/pages/auth/ResetPasswordPage.tsx
web/src/components/auth/ResetPasswordModal.tsx
*.test.ts that mock firebase                 → port to vitest with fetch mocks
admin/src/services/firebaseConfig.ts
```

### Skipped in v1 (stubbed, returns nothing/dummy)

```
web/src/pages/UserInfoPage/MembershipPage.tsx — stub showing "Subscription managed by ProAppStore platform"
web/src/pages/UserInfoPage/Membership/MembershipSetUpPage.tsx — stub or hide route
Any "Pay now" / "Subscribe" / "Billing" buttons — stub or hide
mower_profile.rate_per_lawn stays in the schema but is informational, not transactional
```

---

## 9. Test strategy

- Jest → Vitest: `jest.fn` → `vi.fn`, `jest.mock` → `vi.mock`, otherwise mechanical
- Repository tests: mock `fetch` instead of mocking Firestore
- Worker handler tests: hit a real ephemeral D1 via `wrangler dev --local` or `@cloudflare/vitest-pool-workers`
- E2E (Playwright not present today): add a thin Playwright smoke covering login → role pick → create group → mower expresses interest → vote → assign
- New: authz tests per handler (anonymous, wrong-role, right-role × CRUD)

---

## 10. Sequence

Strict ordering — earlier steps unblock later ones.

1. **Scaffold** — `pas create grasskarma` from `~/dev/stores/pas/`. Side effects: `web/` scaffold + local git initialized. **D1 and data Worker are NOT created here** — they come at `pas publish` (step 14).
2. **Migrations + types** — write `web/src/lib/db.ts` with the `MIGRATIONS` array (§2 schema), an `ensureMigrated()` helper, and TypeScript row types matching each table. No wrangler commands; `app.db.migrate(MIGRATIONS)` is called on first access at runtime.
3. **Models** — port `web/src/models/*.ts` from the source repo. Drop any Firestore Timestamp logic; dates are epoch-millis integers everywhere.
4. **SDK wrapper + auth** — `web/src/lib/app.ts` initialising `initPro({ appId: 'grasskarma', dataApiBase: 'https://pas-data-grasskarma.serge-the-dev.workers.dev' })`. Hook up `useProGate` from `@proappstore/sdk/hooks`. Add a thin `useCurrentUser()` that loads the `users` row for the signed-in `app.auth.user.id` and seeds it with the first-time role-picker if missing.
5. **Lib data layer** — implement the lib surface from §4 in `web/src/lib/*.ts`. Each function: SQL + params + row mapping. Pattern from `pas/dating/web/src/lib/db.ts`.
6. **App skeleton** — `App.tsx` + `ThemeModeProvider` + `ErrorBoundary` + router + GitHub-only login screen. Drop password/Facebook/ResetPassword UI entirely.
7. **`PrivateRoute` swap** — read role from the `users` row instead of Firebase custom claims.
8. **Pages (client)** — port the client pages from the source repo, swap `*Repository` imports for the new `lib/*` calls. Stub `MembershipPage` and `MembershipSetUpPage` with the "Subscription managed by ProAppStore platform" placeholder.
9. **Pages (mower)** — port the mower pages; interest + voting flows backed by `createMowerInterest` / `voteOnMowerInterest`.
10. **Reviews + history** — wire `mower_reviews` + `history_records` lib functions to the relevant pages; public profile at `/mower/:mowerId`.
11. **Photo uploads** — `web/src/lib/photos.ts` using `app.storage`. Wire avatar upload in `UserProfileEditPage`.
12. **Admin pages** — flatten the source repo's separate `admin/` app into routes under `/admin/*` in the main project. Gate purely on `users.role === 'admin'` (UI-only — see §0). Routes: list users, change role, view/moderate groups.
13. **Tests** — `vitest` unit tests for `lib/*` (mock `app.db`); Playwright smoke (login → role-pick → create group → mower interest → vote → assign).
14. **Publish** — `pas publish` from `~/dev/stores/pas/grasskarma/`. **This is where D1 + data Worker + GitHub repo + CF Pages + DNS + storefront entry are all created.** First publish also runs the initial `app.db.migrate()` once the app boots.
15. **Deploy iterations** — `git push origin main` thereafter. CF Pages auto-deploys.
16. **Follow-up PR on `pas/platform/`** — only if `app.storage` or `useProGate` turned out to have ergonomics gaps worth fixing platform-side ([[fill-pas-stubs-along-the-way]]).

Time estimate is intentionally absent — too dependent on session length and decisions surfaced during the port.

---

## 11. Open decisions (resolve as they arise)

| Decision | Default | When to revisit |
|---|---|---|
| `street_group_id` on `users` (single-group membership) — keep? | Keep, looks load-bearing in current code; flips to many-to-many via a join table only if a user is expected to belong to multiple groups | If a homeowner with multiple addresses surfaces as a real use case |
| `usersPub` merge into `users` with explicit public columns | Yes, simpler | Never; usersPub only mirrored `name`, `photoURL`, and a short blurb |
| Identity providers — accept GitHub-only? | Yes for v1; homeowners and casual mowers are a non-developer audience but the platform is GitHub-only today | If onboarding drop-off is visible in analytics, escalate to platform to add email-link auth |
| `member_ids` / `admin_ids` JSON arrays vs join tables | JSON in v1 (matches Firestore shape, simpler queries) | If groups grow large or queries slow |
| Top-level `schedules` collection — port? | No; the nested one is canonical | Never; the top-level was a pre-grouping prototype |
| Legacy `users/{uid}/reviews` — port? | No; collapse to `mower_reviews` only | Never |
| Schedule generation (auto-create N weeks ahead vs explicit) | Explicit `POST /v1/street-groups/:id/schedules` per occurrence | If admins ask for "generate next 12 weeks" UX, add a `:bulk` endpoint |
| `posts` collection (declared in rules, unused) | Drop | Never |
| Geo unit for "street group" — polygon, postcode, or street name? | Suburb + postcode + street name as a stringly identifier; render as a pin, not a polygon | If two adjacent streets in the same suburb collide |
| Live mower-coming indicator via `fas.rooms` | Defer to v2 | When a stakeholder asks for it |
| File uploads via R2 vs SDK storage primitive | Worker R2 in v1; SDK primitive if doordrop's follow-up has landed first | Don't block v1 on the SDK change |
| Admin app at separate route vs same Pages project | Same Pages project, gated by role — flatten doordrop's split-deploy pattern unless admin needs different cadence | If admin needs different deploy cadence |
| Stripe Connect for client→mower payments | Wait for platform Marketplace API ([[pas-platform-payments]]) | When that API ships |

---

## 12. Provisioning prerequisites

Before `pas create grasskarma`:

- `FAS_SESSION_TOKEN` must be set, or pass `--token`. The token in `~/.fas/config.json` at `.session.token` is the same one — `pas create` doesn't pick it up automatically; extract with `jq -r '.session.token' ~/.fas/config.json` and pass via `--token`.
- Must be run from `~/dev/stores/pas/` so the new app lands at the expected path.

What `pas create` actually does, observed:

- Scaffolds `grasskarma/` with `web/` SPA + `package.json` + `pnpm-workspace.yaml` + `tsconfig.json` + `CLAUDE.md` stub + `LICENSE`.
- Runs `pnpm install`.
- Initialises `grasskarma/.git` with one "Initial scaffold from pas create" commit.
- Calls a compliance-check API that requires the GitHub repo to already exist — emits a `404 GitHub tree fetch failed` warning, then proceeds. Harmless at this stage; the repo gets created at `pas publish`.
- **Does NOT** create D1, deploy a Worker, or write a `.pas.json`. Those happen at `pas publish`.
