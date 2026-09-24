# @proappstore/qa-worker

Headless QA executor (#38). Picks up queued `app_test_runs` and runs each flow
against the **live** app in **Cloudflare Browser Rendering** — the platform runs
the tests itself; GitHub is never in the loop.

Step semantics come from the same `@proappstore/qa-spec` DOM-runner bundle the
observable runner page uses (injected via `page.evaluate`), so a flow can't pass
in one executor and fail in the other. Puppeteer only orchestrates navigation,
injection, and screenshots.

## Flow

```
POST /qa/runs (backend)  ──nudge──▶  QA_WORKER /execute?app=<id>
                                         │
   cron */15 (safety net) ─────────────▶ processQueued
                                         │  recover stale 'running' runs
                                         │  claim queued → running (atomic)
                                         ▼
                                     executeRun (per run)
                                         │  isolated browser context per run
                                         │  goto (cache-busted) + inject runner
                                         │  run steps in-page
                                         │  screenshots + status → D1 / R2
```

## Notes

- **Isolated context per run** — `browser.createBrowserContext()` gives each run
  its own storage; a sign-in flow can't leak its session into the next flow.
- **Stale-run recovery** — a run left `running` by a dead invocation is reclaimed
  (marked `error`) after `STALE_RUN_MS` (10 min) on the next pass.
- **Artifacts** — screenshots (final + per-`screenshot`-step + failure frame) go
  to R2 under `qa/<appId>/<runId>/`; served by the backend at
  `GET /v1/apps/:appId/qa/runs/:runId/artifacts[/:name]`.
- **Trigger** — the backend service-binding nudge after `POST /qa/runs`, plus a
  15-minute cron.
- **One run per invocation** (#62) — each invocation claims and executes exactly
  one queued run, then re-nudges itself over the `SELF` service binding while
  more are queued. A deploy that queues N flows is N short invocations, not one
  long one: the serial batch used to outrun the invocation's lifetime and leave
  the tail `running` until stale recovery marked it `error`. Browser Rendering
  concurrency stays one session per chain. Without `SELF` the worker falls back
  to a short serial batch of 3.

## Bindings

`BROWSER` (Browser Rendering), `DB` (D1 `pas`), `STORAGE` (R2 `pas-storage`).
No public route — invoked via the backend's `QA_WORKER` service binding.

## License

MIT.
