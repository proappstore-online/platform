# ADR-007: Durable provisioning via Cloudflare Workflows — poll-based CI gate, per-deploy instance id (NOT slug)

## Status

**Accepted, shipped behind a canary flag** (2026-06-23). The admin-side engine is
built, deployed, and live-smoke-verified (auto-id, no 409, self-poll → terminal,
error tail propagated). The consumer cutover (agent-teams' `deploy-stage.ts`) is
now also built — opt-in per app slug via `WORKFLOW_DEPLOY_SLUGS`, **off by
default** (inline push+poll stays the path until a slug is listed). Refs
proappstore-online/platform#24. Builds on ADR-006 (build stays on per-repo GitHub
Actions — the Workflow orchestrates *around* that CI, it does not replace it).

**To canary:** set `WORKFLOW_DEPLOY_SLUGS = "<slug>"` (a `[vars]` entry on the
agent-teams Worker, or `'*'` for all), redeploy, and run one ticket through that
project. Watch for `complete`→done and a red build routing back to Dev with the
compiler error. Unset to roll back instantly.

## Date

2026-06-23

## Context

The 5-step publish/agent-deploy provisioning flow (GitHub repo → collaborator →
R2 route → registry/analytics → push → CI verify) was hand-rolled-idempotent. A
spike (commits f26fd3d, 645dc7d, 261d0cf) moved it onto Cloudflare Workflows for
durable execution: per-step retry + persistence, and a **CI-green gate** that
blocks — billed $0 while idle — until the pushed commit's CI reports a verdict.

The spike's marquee CI gate used `step.waitForEvent("ci-result")`, fed
server-side by `handleDeployStatus → instance.sendEvent`. For that event to reach
the right instance, the spike pinned **workflow instance id = app slug**
(`create({ id: body.id })`).

**The wall this hit.** Cloudflare's `create({id})` "throws an error if the
provided ID is already used by an existing instance that has not yet passed its
retention limit" — *even after the prior instance is terminal* (retention is
days). But agent apps deploy **repeatedly**: every ticket redeploys, and within a
single ticket a red build sends the app back to Dev and redeploys seconds later.
So:

- Deploy #1 of an app → works.
- Deploy #2 (next ticket, or the red→Dev→fix→redeploy retry) → `create({id:
  slug})` **409s**. `index.ts` even caught this as `"instance exists or create
  failed"` — a known dead end, not a designed path.

The slug-keyed id was not incidental — it was load-bearing for the event routing.
The spike validated a single fresh provision; the agent path is inherently
multi-deploy. The cutover was therefore blocked, not "90% done."

## Decision

Make the CI gate **self-contained** so the instance id can be unique per deploy:

1. **Instance id is CF-auto-generated** (unique per deploy), not the slug.
   `create({ params })` with no `id`. An app can now deploy unlimited times with
   no collision. The caller stores the returned `instance.id` and polls
   `/api/provision-workflow/status?id=`.

2. **CI gate polls instead of waiting for an event.** The Workflow loops
   `step.do("ci-poll-N", () => gh.deployResult(slug, { sha }))` against the exact
   pushed commit, with `step.sleep("ci-wait-N", "20s")` between checks (bounded:
   40 polls ≈ 13 min). `step.sleep` is billed $0 while idle — identical cost
   posture to `waitForEvent`, but with **no external event sender**, so nothing
   depends on the instance id matching the slug.

3. **Delete the event path.** `notifyProvisionWorkflow` and the
   `handleDeployStatus → instance.sendEvent` coupling are removed. The CI gate
   throws on a red build with the **failed job's log tail folded into the error
   message**, so the Workflow's `errored` status carries the real compiler error
   back to Dev (not just a run URL).

The inline `provisionApp` / `/api/agent-deploy` path remains the default. The
Workflow is opt-in per app (canary) once the consumer cutover lands.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Keep `waitForEvent`, mint a **per-deploy** instance id (`${slug}@${sha}`) and route the event by it | Chicken-and-egg: the Workflow pushes internally, so the event sender (`handleDeployStatus`) never sees the sha→instance mapping to route by. Would need a side table written at push time. Self-polling removes the whole problem. |
| `restart()` the existing slug-keyed instance per deploy | `restart()` re-runs with the **original params** — can't restart with a new files bundle, which is the entire point of a redeploy. |
| Drop Workflows; keep the hand-rolled inline path | The inline path works, but loses durable retry/persistence and the $0 CI-green gate. Worth keeping Workflows for the agent pipeline; just fix the identity model. |

## Consequences

**Positive:**
- The single-shot-per-app wall is gone; the agent path can deploy repeatedly.
- CI gate is self-contained — no slug coupling, no best-effort event delivery
  race (event fired before the instance was waiting → dropped → 15-min hang).
- Each poll is its own persisted `step.do`, so a worker eviction mid-build
  resumes the loop rather than restarting it.
- Dev still gets the real compiler error (errorTail rides the errored status).

**Negative:**
- Polling does N cheap GitHub API calls per deploy (≤40) vs. one event. Trivial
  cost, well within rate limits, but not zero API traffic while a build runs.
- Two *concurrent* deploys of the same app now create two instances (two pushes →
  git ref conflict). The inline path's existing fast-forward-retry handles this;
  the DO serializes deploys per ticket anyway.

**Neutral:**
- The consumer (agent-teams `deploy-stage.ts`) must store the returned instance
  id and poll status, mapping `complete`→done / `errored`→Dev-or-needs-input, and
  still run the post-deploy steps (data plane, MCP, test harvest) DO-side. That
  cutover is deliberately deferred until a live smoke proves the engine.

## Verification plan (before the consumer cutover)

1. Deploy admin via `deploy-admin.yml` (CI; no laptop deploys — ci-cd-canonical).
2. Live smoke: `POST /api/provision-workflow/agent` with a throwaway slug + a
   trivial `index.html`. Assert: 202 with an auto id, a second POST for the same
   slug also 202s (no 409), the instance reaches `complete`, and `status.output`
   carries `commitSha`. A deliberately-broken build reaches `errored` with the
   compiler error in `status.error`.
3. Only then wire `deploy-stage.ts` behind a per-slug canary allowlist.
