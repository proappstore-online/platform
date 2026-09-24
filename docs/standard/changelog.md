# Standard changelog

Part of the [Application Standard](./index.md). One entry per version, newest
first; the [changelog policy](./governance.md#changelog-policy) defines the
sections.

## 1.5

Testing, deployment, and operations (chapter `OPS`).

- **Added** — PAS-OPS-001 to PAS-OPS-020: test suites in CI (001), negative
  authorization and tenant-isolation tests (002), live sign-in/sign-out/
  custom-domain/rooms/storage flows (003), CI gates (004), keyless deploy and
  required evidence (005), secrets (006), dependency and vulnerability policy
  (007), forward-only schema (008), code rollback (009), post-deploy smoke
  (010), logs without credentials or personal data (011), monitoring and
  error states (012), rate limits (013), recovery without app-facing backups
  (014), incident evidence within retention windows (015), data minimisation
  (016), retention and deletion — including that `deleteAccount()` is not
  account deletion (017), telemetry disclosure (018), the human operational
  checklist (019), the deployment evidence bundle (020). Plus the governing
  rule that passing tests never evidence production security, a
  verification-class table, and a platform-provides / app-must-add table.
- **Changed** — none.
- **Withdrawn** — none.
- **Editorial** — PAS-DATA-014 now names the platform's `verify` actions
  (a scoped read, a platform-vetted verifier such as `chess.replay`, a write
  guarded on the verdict) as the trusted path for logic SQL cannot express;
  the clause's rule is unchanged (no app-owned Worker, no trusted client
  claims). PAS-DATA-017 and PAS-OPS-013 limits corrected: rooms have
  no per-app room cap and no LRU (the previously published "64 rooms/app" was
  never enforced); a full room closes the 33rd join with code 4429
  `room_full`, and a room with live peers is never evicted. Machine-readable
  and AI-friendly forms published alongside the HTML (no clause changes, so no version bump): `standard.json` (generated
  from the markdown by `scripts/build-standard-data.mjs`, validated by
  `standard.schema.json`), `finding.schema.json` with
  `examples/audit.example.json`, `llms-full.txt`, `llms.txt` (site and
  standard), the `audit-instructions` page, and the *Standard finding* GitHub
  issue form in the platform repository. Compliance checks now carry stable
  ids and cite clauses (`pas check`, `--json`, the publish gate); the map is
  published as `compliance-checks.json` and the audit model gained an
  *Automation levels* section stating the limits of automated compliance.

## 1.4

UI, browser security, and PWA (chapter `UI`).

- **Added** — PAS-UI-001 to PAS-UI-023: SDK components and design tokens
  (001), dark mode via `data-theme` and `stores-theme` (002), landmarks and
  headings (003), accessible names and labels (004), keyboard operability
  (005), colour contrast (006), zoom never blocked — `user-scalable=no`
  flagged (007), viewport meta and supported viewports (008), 360 px layout,
  overflow and touch targets (009), safe areas and `svh`/`dvh` (010),
  loading/empty/error states (011), platform security headers as the floor
  (012), stricter per-app CSP (013), no HTML sinks (014), URL and redirect
  validation (015), uploads and content types (016), framing (017),
  service-worker cache and session isolation (018), offline behaviour (019),
  installability (020), bundle budget and no source maps (021), dependency
  hygiene (022), human browser verification (023). Plus the compliance-check
  → clause map with what the scanner cannot prove, the known scaffold
  defects table, the security-versus-quality split, and the SDK component
  accessibility table. Every clause carries a **Kind** line.
- **Changed** — none.
- **Withdrawn** — none.
- **Editorial** — `ui.md` (capability page) token table replaced: the
  purple/slate aliases (`--bg`, `--surface`, `--border`, …) are gone in
  favour of the canonical token names from `DESIGN-SYSTEM.md` (`--paper`, `--panel`, `--panel-alt`, `--line`, `--line-strong`); values unchanged.

## 1.3

Data, actions, and Workers (chapter `DATA`).

- **Added** — PAS-DATA-001 to PAS-DATA-022: schema conventions (001),
  additive named migrations (002), actions not raw SQL (003), explicit
  minimal auth metadata (004), declared bound parameters (005), server-owned
  magic parameters (006), SQL row scoping for users/projects/orgs/tenants
  (007), write invariants and server-derived grants (008), atomic batch
  actions (009), bounded cursor pagination (010), public queries (011),
  exports/search/stats and `caller_unscoped` (012), store selection (013),
  static apps and platform-provisioned data workers (014), same-zone service
  bindings (015), data-worker boundaries (016), rooms as untrusted ephemeral
  fan-out (017), idempotent writes (018), background work without cron (019),
  caches bound to the session (020), surfaced failures (021), cross-tenant
  negative tests (022). Plus the store decision table and the
  `mcp.json` / `migrations.json` audit procedure.
- **Changed** — none.
- **Withdrawn** — none.
- **Editorial** — none.

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
