# ADR-005: D1 per Tailored fork (provisioned by fas/admin)

## Status

Accepted

## Date

2026-05-08

## Context

A Tailored app (a forked CRM, helpdesk, ATS, …) needs somewhere to put
its data. Three plausible places:

1. The forked app's **own D1 database**, provisioned at publish time.
2. A **shared platform D1** (`fas`), partitioned by `(appId, userId)` or
   `(appId, tenantId)`.
3. **Bring your own database** — publisher / forker provisions Postgres,
   Supabase, or whatever they want.

Today, the CRM (`~/work/crm`) ships with its own D1 declared in
`wrangler.toml` and applied via `pnpm db:migrate:remote`. That works
because Rocket Lab provisioned it manually. For a public Tailored
template that anyone can `pas init` and `pas publish`, that step needs
to happen automatically.

## Decision

Each Tailored fork gets **its own D1 database**, provisioned by
`fas/admin` as part of `POST /api/provision`:

- New step 5 in the provisioning sequence: create D1 `db_<id>`, then
  bind it to the Pages project's production environment under the
  `DB` binding name.
- Forked Tailored templates ship with `[[d1_databases]] binding = "DB"`
  in their `wrangler.toml` and run `pnpm db:migrate:remote` on first
  push.
- Each fork's data is fully isolated. No cross-fork queries. No shared
  tenancy.

Ready apps use the platform's shared primitives — per-user KV, shared
counters, and real-time rooms — backed by the `fas` Worker's D1.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Shared platform D1 partitioned by appId+userId | Reintroduces the multi-tenant data layer the platform deliberately avoids. Schemas would need to converge across forks; one fork's migration could break neighbors. Also: D1 has a row-count limit per database; a single shared DB across many forks risks hitting it. |
| Postgres-on-CF (Hyperdrive in front of an external Postgres) | Adds an external DB dependency, a credentials surface, and operational complexity per fork. D1 is enough for the shapes we expect. Hyperdrive remains an option for any fork that outgrows D1 — but we don't bake it in. |
| BYO database for Tailored too | Onboarding friction kills the AI-first thesis. A publisher saying "fork this and bring your own Postgres" loses the magic — the customer expects a working, deployed app within a minute of `pas publish`. |
| Provision D1 only on first deploy (not at publish) | Means there's a window where the deployed app errors because the binding is unresolved. Provisioning at publish time keeps the state consistent. |

## Consequences

**Positive:**
- Per-fork isolation is the strongest possible: separate physical DB,
  separate schema, separate migration history. A buggy migration in one
  fork can't touch any other.
- Matches the CRM's existing pattern. CRM-shaped templates port to the
  platform without a data-layer rewrite.
- Schema changes are append-only migrations per fork — exactly the
  CRM philosophy.
- No multi-tenant query overhead. SQL stays simple.

**Negative:**
- Provisioning becomes more expensive. Creating + binding a D1 takes
  multiple CF API calls; failure modes multiply (D1 quota, binding
  race, etc.). [Publishing flow](/publishing-flow) has the failure
  table.
- Cross-fork analytics / health checks need a fan-out (loop over
  registry entries) rather than a single SQL query. Acceptable for the
  sizes we expect; revisit if the catalog reaches thousands.
- Per-account D1 limits cap how many forks one Cloudflare account can
  host before sharding. Defer until limit pressure shows up.

**Neutral:**
- The `migrations_dir` per fork lives in the forked repo, not the
  platform. Each fork owns its schema's evolution.
- This decision applies to Tailored only. Ready publishers BYO.
