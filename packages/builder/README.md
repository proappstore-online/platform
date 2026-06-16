# @proappstore/builder — centralized build container

Phase 1 of the centralized build service. See
[`docs/adr/006-centralized-build-service.md`](../../docs/adr/006-centralized-build-service.md)
for the full design and rationale.

This package is the **build container**: one app build per invocation —
`clone → pnpm install → vite build → aws s3 sync to pas-apps/apps/<appId>/`.
It deliberately reuses the same R2 S3 upload path as the legacy GitHub Actions
deploy workflow, so hosting behaviour is identical during migration.

## Status

- ✅ Pure logic (layout detection, R2 destination, job validation, clone URL)
  implemented in `src/lib.mjs` and unit-tested in `src/lib.test.ts` (runs in the
  workspace-root vitest).
- ✅ Container entrypoint `src/build.mjs` + `Dockerfile`.
- ⛔ **Not yet deployed or wired.** Phases 2–5 (orchestrator Worker, GitHub App,
  build records + console UI, migration, drift-machinery decommission) are not
  built. This package builds nothing until the prerequisites below exist.

## Prerequisites (account-owner action — see ADR-006 §Prerequisites)

1. **"PAS Builder" GitHub App** — `push` webhook, `contents:read` + `metadata:read`;
   installed on `proappstore-online`. App id / private key / webhook secret →
   Doppler `pas/prd`.
2. **Cloudflare Containers enabled** on the account.
3. **R2 S3 credentials** scoped to `pas-apps` (or upload via a service binding
   back to the orchestrator's R2 binding).

## Running the container (once built/enabled)

```
docker build -t pas-builder packages/builder
docker run --rm \
  -e BUILD_REPO=proappstore-online/clean-up \
  -e BUILD_SHA=<40-hex sha> \
  -e BUILD_APP_ID=clean-up \
  -e BUILD_TOKEN=<github app installation token> \
  -e R2_ACCOUNT_ID=<id> \
  -e AWS_ACCESS_KEY_ID=<r2 key> \
  -e AWS_SECRET_ACCESS_KEY=<r2 secret> \
  pas-builder
```

`BUILD_TOKEN` is a short-lived, repo-scoped GitHub App installation token. The
clone URL and token are never logged.
