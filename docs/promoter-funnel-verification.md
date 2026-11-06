---
description: "Reproduce the promoter funnel workerd integration tests for enrollment, referral attribution and reporting, and track remaining browser acceptance checks."
---

# Promoter funnel verification

## Delivery scope

The owner explicitly authorized a workerd/backend API fallback for #555 when
connecting the browser infrastructure required substantial additional setup.
`packages/runtime-tests/test/backend/promoter-funnel.test.ts` implements that
fallback. It runs automatically in the existing backend batch suite; no new
configuration or package dependency is needed.

This is a connected API integration test, not a fully observed live signup.
The original mobile Chromium/WebKit, Console/Storefront rendering, QR and
visible browser-card acceptance remains unverified. Keep production recruitment
disabled until those browser and readiness prerequisites pass.

## Reproduce

From the platform root:

```sh
pnpm -C packages/runtime-tests run test:backend
pnpm -C packages/runtime-tests exec vitest run --config vitest.backend.ts test/backend/promoter-funnel.test.ts
pnpm -C packages/runtime-tests typecheck
```

The existing runtime setup applies real root D1 migrations and disables outbound
network connections. The backend runs in workerd. The new suite uses the real
SDK Referrals implementation, host auth callback and cookie mediator, and the
backend HostApi service binding. Every API response comes from the real local
components; there are no mocked attribution or reporting responses.

## Assertions

- A person owning no app discovers readiness, enrolls through the API and retrieves
  the service-issued personal code/share link. Enrollment retries preserve it.
- An independent synthetic HTTP identity captures that link using the SDK. Capture
  survives an interrupted login and reconstruction of the SDK instance.
- Only the provider identity boundary is synthetic: a short-lived hashed login
  code is inserted into the local auth fixture. The production callback exchanges
  and consumes it over HostApi, validates the session and sets the real cookie.
  Reusing the code fails. No provider redirect is followed externally.
- Login alone leaves the confirmed count at zero. A real SDK claim creates a
  pending referral. The first successful mediated authenticated operation confirms
  credit; repeated operations and new SDK instances leave own counts/share at one.
- A separate user activates without a referral. Owner acquisition reports two
  activations, one organic user and one confirmed referred user.
- Anonymous /contributors stays empty without saved consent, exposes the chosen
  profile after opt-in, and becomes empty after promotion opt-out or suspension.
  The promoter gains no team membership.
- Unknown/unsupported readiness refuses enrollment; self, existing-user and
  wrong-app claims fail; duplicate claims create only one attribution.
- External Google, GitHub and production API fetch attempts are rejected by the
  runtime network guard.

No confirmed attribution or activation row is seeded, and recordActivation is
never invoked by the suite. The existing-user boundary uses an old non-ledger KV
fixture to distinguish previous use from the first-activation grace window.
Readiness and synthetic identities are local fixtures, not production attestations.

## Local results and limits

On 2026-11-06, the new suite passed all three tests (exit 0), and runtime package
typecheck passed (exit 0). workerd emitted Windows temporary-directory cleanup
warnings after the successful test process.

The requested working-tree backend baseline was started before the new suite
was created and enumerated 92 existing files. Both general batches passed
(44 files each); the rooms batch failed 18 tests and passed 26 across four
files: room-publish.test.ts, room-seq-durable.test.ts, rooms-do.test.ts and
visibility.test.ts. Errors included WebSocket upgrades returning 500 instead
of 101, rooms.publish failures and workerd internal errors. Baseline exit was
1. Its local log is artifacts/verification/555-backend-baseline.log. These
failures were recorded, not fixed or attributed to the new suite.

The earlier full unit run was 6,593 passed, 36 failed and nine skipped. The failing
files were unchanged publish.test.ts, app-deploy-workflow.test.ts and
mcp-remote-auth.test.ts, with WSL-launcher and POSIX-permission environment errors.
Knip failed loading vitest.backend.ts with undefined.resolve. Those failures were
not fixed, skipped or reclassified as passes. The previous pnpm verify collection
was stopped during offline-browser and is not a completed release receipt.

The seven pre-existing #552 working changes and the earlier referrals.test.ts
modification are excluded from this delivery. The new suite does not depend on
#552's new own-profile GET endpoint. Public consent writes use existing APIs.
This Windows/Node 24 run does not certify the Node 22/POSIX release bar.

## Original joint-browser acceptance still outstanding

Inspected source candidates were backend/host/SDK HEAD
5235a9a9eba7fd9e716f3b205b11becef144f2b1 plus local changes, Console
3d323596741ef7ada9002b5826d44b442577de43 and Storefront
9669c7c78b897c9ec9f7088233063c08f37f6e99. Console/Storefront were not executed by
this fallback. There are no joint-browser CI receipts for these candidates.

Scoped reproducible client build handoffs are tracked by Console#16 and
Storefront#15. A hermetic source build is acceptable instead of an uploaded artifact.

Before production recruitment is enabled through Storefront#13:

- Deliver and verify #552 and the other client/readiness prerequisites.
- Pin exact backend/SDK/Console/Storefront build identities and include
  Storefront#14's real contributor consumer.
- Run the shared recruitment, actual SDK auth-return, enrollment, link/code/QR,
  referred-user and own-reporting flow in mobile Chromium and WebKit.
- Inspect the visible /contributors card through consent and lifecycle changes.
- Verify keyboard access, no horizontal overflow and browser network isolation.
- Retain fixture-only enabled destinations; run all mandatory release gates on
  an unchanged candidate and record commands, fixture mode, build hashes and CI URLs.
- Attach that evidence to #548 and Storefront#13. Their earlier pending checklists
  are not replaced by the API fallback, and the epic must not be represented as
  a fully observed live signup flow.

## Dating pilot browser acceptance (2026-11-06)

The newer `scripts/test-referral-browser.mjs` runs the actual Dating build, Console
and storefront against an isolated workerd backend/D1 ledger and real host cookie
handlers. Both Chromium and WebKit passed the connected flow at 390px, with
Console and contributor layouts also checked at 320px. It verifies keyboard entry,
service-issued enrollment/link/visible QR, referral capture across reload/sign-in,
one confirmed credit after repeated reloads, saved visibility choices, the actual
app-detail contributor card appearing after consent and disappearing after hiding,
and no additional credit from direct legacy claims or a private app.

The Console candidate includes `e17cdec168141e4f3020b45451b22a762bd5a672`, fixing
credentialed CORS failures in the promoter and own-profile consumers. The backend
candidate adds #552's own saved-preferences GET. This check uses a fixture-enabled
storefront and an updated Dating SDK; it is not a live-provider login or a real
production referral. External fonts, avatar images and agent-service requests are
blocked; WebKit also surfaces the existing optional SDK usage-ping credentialed
CORS failure. Attribution and reporting use the real backend responses.

Reproduce with the three build paths:

```sh
PAS_REFERRAL_DIST=/absolute/dating/web/dist \
PAS_CONSOLE_DIST=/absolute/console/web/dist \
PAS_STOREFRONT_DIST=/absolute/storefront-fixture \
node scripts/test-referral-browser.mjs
```

`artifacts/referral-browser/results.json` records exact hashes for all three
builds, each engine's checks and blocked external destinations. The check refuses
an app build that changes while running. Recruitment still requires the deployed
Dating attestation and all normal release gates; this local receipt alone does
not enable it. The earlier API-only results above remain historical receipts.
