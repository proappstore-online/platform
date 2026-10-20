# Browser verifier on ProAgentStore agents (trial, #456)

A ProAppStore app can ask a **ProAgentStore (PAGS) agent** to run its QA flows in a
real browser, under the **subscriber's own subscription** (Claude Code or Codex signed
in on their runner machine), instead of ProAppStore spending API keys. The platform
Worker only passes messages: it never runs an engine, and no subscription login ever
reaches Cloudflare. If the agent can't take the job, the flows run on the platform's
headless executor instead, and the run says why.

> **Status: inert until PAGS delivers four additions** (below). The platform side is
> deployed, but without the PAGS HTTP API there is nothing to call, so every `pags`
> run falls back to the headless executor with `pags_not_configured`.

## How a run goes

1. The owner binds the app to a PAGS agent instance: `PUT /v1/apps/:id/qa/pags`.
2. `POST /v1/apps/:id/qa/runs` with `{ "engine": "pags" }` (and optionally `flowId`).
   Each flow becomes a run (`engine: "pags"`) and one job is queued on the agent.
3. The agent clicks through the flow on the subscriber's machine and reports each state
   to `POST /v1/pags/callback`: `queued`, `running`, `needs-you`, `done`, `failed`.
4. `GET /v1/apps/:id/qa/runs/:runId` shows the run, the agent's state, its question when
   it needs a person, and a link to its report.

| Agent state | Run status | Notes |
|---|---|---|
| `queued` | `queued` | the agent accepted the job |
| `running` | `running` | |
| `needs-you` | `running` | `pags.detail.question` holds what it asks |
| `done` | `passed` / `failed` / `error` | from `result.status`; `error` if it sent none |
| `failed` | `error` | the agent's run failed |

`done` and `failed` are final. A late event for a finished run is acknowledged and ignored.

## Falling back to the headless executor

A run keeps `engine: "headless"` and records `fallback_reason` when it ran there instead:

| `fallback_reason` | Why |
|---|---|
| `pags_not_configured` | the Worker has no PAGS API URL, token or callback secret |
| `no_binding` / `binding_disabled` | the app has no enabled agent binding |
| `pags_overloaded` | PAGS answered 429 or 503 (the runner is busy) |
| `pags_unauthorized` | PAGS refused the token (401/403) |
| `pags_refused_<status>` | any other refusal |
| `pags_unreachable` / `pags_timeout` | no answer in 8 s |
| `pags_bad_response` | no usable job id came back |
| `flows_too_large` | the flow specs exceed 64 KB |
| `pags_timeout: no event … for N min` | the agent went quiet for 15 min (checked every 5 min) |
| `pags_needs_you_unanswered` | a question waited 2 h with no answer |

## Setting it up (owner)

```bash
cd packages/backend
pnpm exec wrangler secret put PAGS_TOKEN             # the LIMITED ProAgentStore token
pnpm exec wrangler secret put PAGS_CALLBACK_SECRET   # the shared HMAC secret
# PAGS_API_URL is a plain variable (the ProAgentStore HTTP API base URL).
```

Then bind each app: `PUT /v1/apps/:id/qa/pags` with `{ "instanceId": "…", "repo": "org/app" }`
(`GET` reads it, `DELETE` removes it; owner only). `GET` also says whether the platform is
`configured`.

## The callback

`POST https://api.proappstore.online/v1/pags/callback`

```
X-PAS-Timestamp: <unix ms>
X-PAS-Signature: sha256=<hex HMAC-SHA256(PAGS_CALLBACK_SECRET, "<timestamp>.<raw body>")>

{ "event_id": "…", "job_id": "…", "state": "running",
  "note": "…", "question": "…", "report_url": "https://…", "screenshots": ["https://…"],
  "result": { "status": "passed", "steps_total": 4, "steps_passed": 4, "failed_step": null, "error": null } }
```

- The signature is checked, in constant time, before anything is parsed. The timestamp is
  inside the signed text and must be within 5 minutes of now, so a captured request can't
  be replayed later.
- Each `event_id` is applied once per job: a redelivery answers `200 { duplicate: true }`.
- Text is bounded; `report_url` and `screenshots` must be `https`.
- The GitHub commit or PR the agent made is the real result; `report_url` should link it.

## What ProAgentStore must deliver (file on ProAgentStore/platform)

Nothing in the ProAgentStore repo was changed for this trial. Four small additions are needed
before an end-to-end run:

1. **A limited token** that can only queue work and read status on chosen instances, not a
   full account token. It is held as `PAGS_TOKEN`.
2. **A callback URL and job ID on queued runs.** `coding_loop_start` has no callback field
   today. A job accepts `callback_url` and returns a `job_id`.
3. **An HTTP route the Worker can call directly**, not MCP only, with rate limits:
   `POST /v1/verifier/jobs` (`Authorization: Bearer <limited token>`), body
   `{ instance_id, repo, app_id, app_url, run_id, flows: [{ flow_id, name, spec }], callback_url }`,
   answering `202 { job_id }`, or `429`/`503` when the runner is overloaded (see ProAgentStore #1264).
4. **Run-state events delivered to connections:** queued, running, needs-you, done, failed,
   posted to the callback with the signature above.

The `spec` is a platform QA flow (see the QA spec in `packages/qa-spec`). The agent runs it in a
browser against `app_url` and reports pass or fail with screenshots.

## Limits and risks

- A leaked `PAGS_TOKEN` can queue verifier jobs on the bound instances only, which is why the
  token must be the limited one.
- Runner capacity (ProAgentStore #1264) and the vendors' rate limits and terms on automated use
  apply. Offline machines are handled by the timeout and the headless fallback.
- Coder and automation-runner agents come after this trial succeeds.
