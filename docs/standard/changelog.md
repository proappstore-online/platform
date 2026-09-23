# Standard changelog

Part of the [Application Standard](./index.md). One entry per version, newest
first; the [changelog policy](./governance.md#changelog-policy) defines the
sections.

## 1.2

Identity, sessions, and permissions (chapter `AUTH`).

- **Added** — PAS-AUTH-001 to PAS-AUTH-020: platform-cookie mode (001), no
  app-managed session storage with a direct `pas:session` audit rule (002),
  SDK-only auth flows and no `app.auth.token` coupling (003), platform
  providers and provisioned credentials (004), hydration (005), expiry and
  401 handling (006), sign-out and recovery (007), authorization lookups fail
  visibly (008), CSRF via same-origin mediation (009), return URLs (010),
  custom domains (011), no app cookies (012), app roles not team/platform
  roles (013), membership is not a role (014), least privilege (015),
  fail-closed server authorization (016), app-defined roles (017),
  permissions administration UI (018), privileged operations (019),
  human-only production verification (020). Plus the weakness-class table
  from the Chess Academy migration.
- **Changed** — none.
- **Withdrawn** — none.
- **Editorial** — `auth-session-model.md` and `sdk-overview.md` now state the
  hosted-app recommendation (platform-cookie) and the current fleet status
  rather than presenting cookie mode as an experiment.

## 1.1

Stack and platform-service decision guidance (chapter `STACK`).

- **Added** — PAS-STACK-001 to PAS-STACK-024: toolchain and scaffold (001),
  SDK-only platform access (002), single `initPro` with platform-cookie auth
  (003), CLI-managed lifecycle (004), keyless deploy workflow (005), platform
  identity (006), registered actions (007), `migrations.json` (008), KV (009),
  counters (010), tenant scoping (011), storage (012), rooms (013), roles
  (014), secrets and proxy (015), AI (016), maps (017), notifications (018),
  email/SMS/webhooks (019), platform subscription (020), logs and no trackers
  (021), SDK UI and tokens (022), MCP via the same manifest (023), no
  substitute dependencies (024). Plus the required/optional stack table, the
  service-selection table and the app-architecture decision tree.
- **Changed** — none.
- **Withdrawn** — none.
- **Editorial** — none.

## 1.0

Foundation release. Defines the [audit model](./audit-model.md), the
[chapter taxonomy, clause ID grammar, normative keywords, clause template,
versioning and withdrawal rules](./governance.md), and the six chapter pages.

- **Added** — none. Chapters are published without clauses in this version;
  clauses are added in subsequent minor versions.
- **Changed** — none.
- **Withdrawn** — none.
- **Editorial** — initial publication.
