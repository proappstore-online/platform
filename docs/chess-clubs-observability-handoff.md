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

- [ ] **App registered and identity confirmed** — `chess-academy` exists, the
      deploying repository's OIDC claims are the pinned Chess Clubs repository.
- [ ] **SDK current** — on an `@proappstore/sdk` release that includes #390
      and #392 (`aa17ff6`, `7490a3d`), so crashes and network failures reach
      the platform with their trace and context. (Keeping a full `build.sha`
      through ingest is a backend fix in #396; it needs no app change.)
- [ ] **Build stamped** — `monitoring: { build: { sha: <full commit SHA> } }`
      (e.g. `VITE_COMMIT_SHA`), so every entry names its release.
- [ ] **React errors captured** — the app's `ErrorBoundary.tsx` calls
      `app.logs.captureReactError(error, info.componentStack)`.
- [ ] **Source maps uploaded for each release** — `build.sourcemap: 'hidden'`,
      and the two #393 steps in Chess Clubs' own deploy workflow (it does not
      use the canonical one): upload keyless with GitHub OIDC, then strip every
      `.map` before the public upload. Check the deploy log for the verified
      digest and that no `.map` is served.
- [ ] **Redundant browser `/migrate` call removed** (Chess Clubs companion
      ticket; the platform's data-plane change is #403).
- [ ] **Alert webhook configured** — an owner-registered `app.alert` webhook,
      if the owner wants push; and, if wanted, reliability objectives (#395)
      with targets the owner chooses.
- [ ] **Owner query tested** against `chess-academy` with an owner session:
      `GET /v1/apps/chess-academy/logs?symbolicate=true`, a trace id through
      `/incidents/<traceId>`, and `/reliability/deliveries`.
- [ ] **Telemetry-health baseline** — `GET /v1/apps/chess-academy/telemetry/health`
      reads `ok` with a recent evaluator stamp, and request totals are not
      `unknown` (needs the Analytics Engine token gate).
- [ ] **Console readback** — the same incident visible in the console Logs
      workspace once proappstore-online/console#7 lands.

Compare each result with the matching conformance scenario (runbook →
"Synthetic conformance checks"); deployed gates are in
`docs/deployed-acceptance-gates.md`.
