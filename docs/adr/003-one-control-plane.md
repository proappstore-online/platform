# ADR-003: One control plane, two SDK shapes — no Ready-specific backend

## Status

Superseded by the PAS-owned control plane cleanup. The "one control plane"
decision still stands, but the current implementation is PAS-owned auth and
provisioning through `api.proappstore.online`, plus per-app data workers, MCP,
and Agent Teams. It no longer uses `fas`/`fas-admin` as runtime control-plane
dependencies. See [Architecture](/architecture).

## Date

2026-05-08

## Context

Once the platform commits to two app categories
([ADR-002](/adr/002-tailored-vs-ready-split)), a natural question is
whether each category needs its own backend. Tailored apps are
forked-and-deployed independently; Ready apps are shared multi-tenant
deployments. They feel like different problems.

Looking concretely at what the platform offers per category:

| Concern | Tailored | Ready |
|---|---|---|
| Identity (GitHub OAuth, sessions) | same | same |
| Stripe / entitlements | same primitives | same primitives |
| Registry / catalog | same | same |
| App-level primitives (KV, rooms) | same opt-in | same opt-in |
| Publish / provision | per-fork repo + Pages + D1 + registry | one repo + Pages + registry |
| Tenant data | per-fork D1 (app's own) | publisher BYO storage |

The differences are concentrated in (a) one provisioning code path and
(b) what publishers do with their own app code. Neither requires a
separate platform-level backend.

## Decision

ProAppStore runs on **one control plane composed of three Workers**:

- `fas` — identity, app primitives, publish endpoint, registry
- `pas` — Stripe, entitlements, license keys
- `fas/admin` — provisioning (GitHub repo, Pages project, DNS, D1)

Both Tailored and Ready apps talk to the same Workers. The category
distinction shows up only in:

- A `category` flag on `POST /api/provision`. Two code paths, one
  Worker.
- Two SDK consumption patterns (which helpers a publisher emphasizes).
- Two `pas init` scaffolds.

No fourth Worker per category. No Ready-specific backend. No
Tailored-specific backend.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Add a fourth `ready` Worker for shared multi-tenant primitives (tenant-aware D1 wrapper, RLS helpers, admin-UI primitives) | Premature. Ready publishers BYO storage today; the platform's job is identity + Stripe + registry, not multi-tenant infrastructure. Build this only when a Ready publisher actually asks for it. |
| Add a fourth `tailored` Worker for fork-management features (template-update notifications, fork drift detection) | Same reasoning. Useful eventually, premature now. Lives in `fas` if and when it's needed. |
| Split `pas` into per-category billing Workers | Stripe primitives are the same regardless of category. The split would duplicate code with no architectural payoff. |
| Merge `fas/admin` into `fas` | Concentration of secrets is undesirable: provisioning needs broad GitHub admin:org + CF Pages tokens; identity does not. Keeping them separate limits blast radius. |

## Consequences

**Positive:**
- Smallest plausible system. Three Workers, three roles, easy to
  reason about.
- Adding a category is a `category` flag + two code paths in one
  function, not a new deployment.
- Service bindings (`fas` → `fas/admin`) keep internal calls off the
  public edge. No CF Access prompts, no token rotation, no edge loops.
- Future fourth concern (e.g. analytics, search indexing) becomes its
  own Worker — additive, not a refactor.

**Negative:**
- `fas/admin` becomes the place where category-specific provisioning
  logic accumulates. Discipline needed to keep it small (file-size
  discipline applies here too).
- Cross-Worker observability is split across three log streams. Not
  unique to this decision, but accentuated.

**Neutral:**
- If a future Ready-shaped need (e.g. shared tenant directory) calls
  for a fourth Worker, this decision doesn't block adding one. It just
  declines to add one preemptively.
