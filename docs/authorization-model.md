# Authorization Model — the three role systems and which to use

PAS has **three separate role vocabularies**. They were introduced at different
times for different purposes and their value sets *overlap* (`admin`, `owner`,
and `viewer` each appear in more than one, meaning different things). Using the
wrong one — or checking mere *membership* when a *role* is required — is what
produced the 2026-07 privilege-escalation bugs (#78, #79, #95). Read this before
adding any authorization check.

## The three systems

| System | Values (low → high) | Stored in | Answers |
|---|---|---|---|
| **Platform roles** | `user` · `creator` · `admin` | session JWT (`ADMIN_GITHUB_IDS`) | "What can this identity do on the platform?" (publish, admin endpoints) |
| **Team roles** | `viewer` · `po` · `developer` · `admin` · `owner` | `team_members` table | "What can this user do to *this app's* build/data/config?" |
| **App roles** | `owner` · `member` · `moderator` · `editor` · `viewer` (+ custom) | `app_roles` table | "What can this user do *inside the running app's* domain?" (RBAC the app itself uses) |

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

## Trust boundaries that are NOT roles

- **`INTERNAL_TOKEN`** proves "a trusted *platform worker* is calling"
  (worker-to-worker). It does **not** prove *which app* — so it must never be the
  sole gate where the real caller is per-app CI or an app origin (that was #57,
  kb-host ingest). App-scope those with GitHub OIDC (the `repository` claim →
  app slug), as the data-worker/QA/R2 deploy paths do.
- **GitHub OIDC** (`repository == proappstore-online/<appId>`, `ref == main`) is
  the keyless, app-scoped identity for CI-initiated writes (tool registration,
  KB ingest, R2 creds).

## Rule of thumb

1. Platform capability? → `requireRole`.
2. Something about an app's build/data/config? → `requireAppAccess(minRole)` (or
   `team_role` rank in a separate worker). **Membership is never enough.**
3. Something the running app enforces on its own users? → app roles + row-scoping SQL.
4. Worker-to-worker? → `INTERNAL_TOKEN`. CI-to-platform? → GitHub OIDC. Neither is a role.

When unsure, pick the **higher** bar and fail closed. Names collide — comment
which system your check belongs to.
