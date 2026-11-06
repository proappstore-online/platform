---
description: "Deployment-scoped referral readiness, recruitment gates, and client coordination (#553)."
---

# Referral readiness before recruitment

Enrollment availability (`enrollment_open`) is an owner's preference. Attribution
readiness is a separate deployment contract. Public visibility, issued tokens,
credential mints and SDK-looking strings in a public bundle establish neither
capture nor authenticated activation. Unknown deployments are unavailable.

## Contract

Migration `0133` starts with no ready apps. An app's authorized GitHub Actions
workflow on `main` can report referral protocol version 1 after uploading and
successfully verifying the deployment. The server binds this attestation to the
`deploy_id` returned by `POST /v1/apps/:appId/deploy-credentials`, the verified
OIDC repository and SHA, and the latest audit ID for that app. Another mint
invalidates readiness before upload credentials are returned, even for the same
SHA. A failed or cancelled deploy stays unavailable until verification succeeds.
Stale reports return `409 stale_or_unknown_deployment`.

`POST /v1/apps/:appId/referral-readiness/oidc` accepts:

```json
{
  "protocol_version": 1,
  "deploy_id": 123,
  "sdk_version": "1.16.104",
  "auth_mode": "platform-cookie",
  "synthetic_verified": true
}
```

This is an authenticated **app deployment attestation**: the app owner is
responsible for its verification script, just as for its build. The API does
not claim to have independently executed a browser test, inspect private source,
or infer an installed SDK version. Browser clients and ordinary owner sessions
cannot set readiness. An attestation with older SDK, legacy auth or unsuccessful
synthetic verification records an unavailable state.

Minimum requirements for protocol 1:

- Published `@proappstore/sdk >= 1.16.104` (the next SDK release including the cookie-auth claim fix in
  #553; prereleases do not qualify), with automatic referral capture and claim
  enabled through `initPro`.
- `platform-cookie` auth on the PAS host, including custom domains mediated by
  that host. Explicit `legacy-bearer` mode cannot qualify.
- Host `/.pas/auth/*` and `/.pas/api/*` mediation, with the private `HostApi`
  binding to the backend containing #550. The backend must record first
  authenticated app activation and support `/referrals/claim`.
- A successful synthetic check of the uploaded build in an isolated test environment: a captured
  `?ref=` survives sign-in, the app claims it through mediation, a successful
  app-bound authenticated request activates it, and repeated claims/activations
  leave exactly one confirmed credit. Verify that private/legacy paths cannot
  produce a credit. Use managed test identities and granted test access, never
  real-user accounts or a credential bypass. Test fixtures must stay in an
  isolated ledger, so a fresh app can verify before recruitment opens and no
  synthetic credit contaminates its production reporting.

## Making an app ready

Update the owner's bound app repository and lockfile to a compatible SDK and
use `platform-cookie` auth. Add a root `test:referral-readiness` package script
that serves the build at `PAS_REFERRAL_DIST` in an isolated synthetic host/backend
environment and verifies the above flow with synthetic fixtures. It must test
the exact build directory uploaded by this run, cookie mediation and the real
backend attribution contract. A script that only checks source, a version string
or a mocked claim response does not meet this contract. It must not enroll test
promoters or create credits in the production app to bootstrap this check.

In the app's reusable-workflow caller, opt in with:

```yaml
with:
  referral-readiness: true
```

The reusable pipeline uploads first, runs that script, resolves the installed
SDK version, and sends the OIDC attestation only on success. Missing scripts,
audit IDs, failed tests and refused attestations fail that opt-in step. Apps
that do not opt in remain unavailable. Deploy the backend before adopting the
new workflow input. The updated reusable workflow must be promoted through the
normal `app-deploy-v1` release process before callers pinned to that tag use the
input; pushing platform `main` alone does not move that tag. No bulk app edits
or redeploys are needed or authorized by this change.

## Console and Storefront coordination

`GET /v1/storefront/promoters/apps` retains its response shape but lists only
public, enrollment-open, ready apps. Enrollment also enforces readiness in its
atomic writes and returns `403 referral_tracking_not_ready` when unavailable.

Clients can explain an unavailable destination with
`GET /v1/storefront/promoters/apps/:appId/readiness`:

```json
{
  "enrollment_open": true,
  "referral_tracking": {
    "ready": false,
    "reason": "deployment_unverified",
    "protocol_version": 1
  }
}
```

Reasons are `deployment_unverified`, `sdk_unsupported`, `legacy_auth`, or
`synthetic_check_required`; ready has `reason: null`. Private/missing apps are
the same `404`. No deployment SHA, repository, test identity or credential is
published. Owner `GET /apps/:appId/promoters/settings` adds the same
`referral_tracking` object; `PUT` still changes enrollment availability only.

Console (#14) should display these independent states and handle the new
enrollment refusal. Storefront must retain `data/promoter-destination.json`
`ready:false` until its client changes and cross-repository acceptance under
#548 are complete. This platform change does not enable signup or close #548.

Existing relationships, codes, history and confirmed credits are retained. A
readiness loss prevents recruitment/re-enrollment; it does not withdraw an
existing promoter, erase a credit, or backfill historical attribution.

## Exact-build browser check

`scripts/test-referral-browser.mjs` takes an absolute `PAS_REFERRAL_DIST` and
`PAS_REFERRAL_APP` (Dating by default). It serves those unchanged build bytes,
uses real host cookie handlers and HostApi with the backend in workerd and real
D1 migrations, and writes hashes and engine results under
`artifacts/referral-browser/`. The synthetic provider and identities exist only
inside this runner; the test worker has no production deployment configuration.
Browser traffic is restricted to loopback transport, with known platform URLs
proxied into the local components. Worker outbound traffic is denied.

Pass both `PAS_CONSOLE_DIST` and `PAS_STOREFRONT_DIST` for joint acceptance using
real client builds. The storefront fixture must enable the promoter destination;
never deploy that fixture. Without those inputs the runner verifies only the app
build's referral behavior, suitable for each app deployment's readiness check.
