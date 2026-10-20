# Chess Clubs observability handoff (#396)

The platform's diagnostics contracts are proven generically by the synthetic
conformance suite (`packages/runtime-tests/test/backend/e2e-conformance.test.ts`)
against a dedicated fixture app, `diag-e2e`, with synthetic owners — no Chess
Clubs code, data or users. It is the baseline: anything below that does not
behave the way that suite does for `diag-e2e` is a Chess Clubs integration gap,
not a platform one. Chess Clubs work happens in its own repository
(`ChessClubs-online/chess-clubs`, companion epic #214); nothing here edits it.

Chess Clubs is `chess-academy` on the platform, served at
`chess-academy.proappstore.online` and `chessclubs.online`; its deploy
authenticates as `ChessClubs-online/chess-clubs` (#386).

## Checklist before relying on it live

Status 2026-10-20, from read-only checks of production and of the Chess Clubs
repository. No Chess Clubs session, user or data was touched.

- [x] **App registered and identity confirmed** — `chess-academy` exists, and its
      deploys authenticate as `ChessClubs-online/chess-clubs` (its keyless
      source-map uploads succeed under that repository's OIDC claims).
- [x] **SDK current** — `@proappstore/sdk 1.16.85`, which includes #390 and #392
      (`aa17ff6`, `7490a3d`).
- [x] **Build stamped** — 66 of its 67 client entries in the last three days carry
      a full 40-character `build.sha` (6 releases).
- [x] **React errors captured** — `ErrorBoundary.componentDidCatch` →
      `reportError({ kind: 'boundary' })` → `captureReactError` with the component
      stack (`web/src/lib/report-error.ts`). No live React error has arrived yet.
- [x] **Source maps uploaded for each release** — 25 active releases since
      2026-10-18; every map path probed is 404 on both origins, including the
      live bundle's; two real releases resolve to the exact original line through
      the platform symbolicator (#393).
- [x] **Redundant browser `/migrate` call removed** — chess-clubs#218, closed.
- [ ] **Alert webhook configured** — none, and no reliability objectives (#395).
      An owner choice; nothing pushes until the owner registers one.
- [ ] **Owner query tested** against `chess-academy` with an owner session:
      `GET /v1/apps/chess-academy/logs?symbolicate=true`, a trace id through
      `/incidents/<traceId>`, and `/reliability/deliveries`. Needs the owner.
- [ ] **Telemetry-health baseline** — the evaluator is OK every tick in
      production and the Analytics Engine token is in place, so the owner's
      `GET /v1/apps/chess-academy/telemetry/health` should read `ok` with request
      totals; that owner read has not been done.
- [ ] **Data worker on #394** — `pas-data-chess-academy` predates the fault
      verdicts and traces (fleet rollout, #394).
- [ ] **Console readback** — the same incident visible in the console Logs
      workspace once proappstore-online/console#7 lands.

Live verification of the incident workflow itself is tracked on chess-clubs#228.
This page should be linked from the Chess Clubs epic (#214); that is a write to the
Chess Clubs repository, which the platform's agent sessions are not registered for.

Compare each result with the matching conformance scenario (runbook →
"Synthetic conformance checks"); deployed gates are in
`docs/deployed-acceptance-gates.md`.
