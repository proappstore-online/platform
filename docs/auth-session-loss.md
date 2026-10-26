---
description: "Diagnose session loss and auth hydration failures using fixed-shape SDK events and the owner-only app log pipeline."
---

# Session-loss diagnostics

Issue #353 extends the existing owner-only app log pipeline (#105, #106) with two
fixed-shape SDK events, `auth.session_lost` and `auth.hydration_failure`, and one
host-recorded event. They are diagnostic events. They are not evidence that a
reported production logout has been root-caused.

## Events and reason codes

| Category | Reason | Recorded by | When |
|---|---|---|---|
| `auth.session_lost` | `api_401` | SDK, and the host (server row) | The PAS **API plane** answered 401: the host cleared the session cookie and the SDK moved from signed in to signed out |
| `auth.session_lost` | `legacy_session_rejected` | SDK | A legacy (bearer) session was rejected while hydrating |
| `auth.session_lost` | `explicit_sign_out` | SDK | The user signed out (phase `explicit_sign_out`, route `auth.logout`) |
| `auth.hydration_failure` | `network_error` | SDK | `/me` could not be reached. Session validity is **unresolved**; an established session is kept |
| `auth.hydration_failure` | `http_error` + numeric `status` | SDK | `/me` answered a non-401 HTTP error. Validity is unresolved; an established session is kept |

`auth.session_lost` is emitted only for a real in-memory authenticated-to-signed-out
transition, once per transition. Neither hydration failure by itself discards an
already authenticated session. A **data-plane** (`/.pas/data`) or app-worker 401
never clears the cookie, never signs the user out and creates no event: data
workers hold their own signing key, which can drift from the backend's (#65/#66).

Phases are `api_request`, `cookie_hydration`, `legacy_hydration` and
`explicit_sign_out`. Routes are `platform.api`, `auth.me` and `auth.logout`.

## Correlation

On an API-plane 401 the host:

1. generates a random 32-hex correlation ID;
2. records one server row (`source = 'server'`, category `auth.session_lost`, data
   `{ reason: 'api_401', phase: 'api_request', route: 'platform.api' }`,
   fingerprint `auth-session-api-401`, `trace_id` = the ID, no user, no client)
   through the private `POST /v1/internal/session-invalidations` contract, before
   the cookie is cleared;
3. clears the cookie and returns the ID in the same-origin response headers
   `X-PAS-Session-Invalidation-Reason: api_401` and `X-PAS-Session-Invalidation-Id`.

The SDK records the same ID as its event's `traceId`. In the owner-only app logs,
filter by `category=auth.session_lost`, then by that trace ID: the host row and the
SDK row join on it. The host row is there even when the browser cannot upload its
best-effort event. The ID is random and carries no user, session, cookie or token
data. In the SDK event's `data`, the scrubber masks the duplicate correlation value
as `[hex]`; the trace column is the join key. The same flow applies on default
`<app>.proappstore.online` origins and on active custom domains.

A failure of the host's diagnostic call (thrown, or a 5xx) never delays or prevents
the authoritative 401 and cookie clearing.

## What is recorded, and what never is

The SDK event schema is an allowlist: reason, phase, route code, correlation ID,
prior-auth boolean, optional numeric status, elapsed milliseconds, online state and
visibility state. A value outside the allowlist drops the whole event rather than
serialising it. URLs, query strings, error objects, headers, payloads and user data
are never accepted. Tests feed tokens, cookies, `Authorization` values, query
strings, emails and child/student records into the capture call and prove none
reach the wire. Owner identity on a row is the existing `user_id` column of a
signed-in upload only; the host row has none.

## Limits

- **SDK logger:** 100 entries per send, 200 queued entries, 4 KB fields,
  cooldowns, and no retry loop. A telemetry failure is dropped, never retried or
  logged through itself.
- **Client ingestion:** the app's daily budget (`app_log_usage.count`, 50,000
  entries a day) and the per-isolate burst limit (200 entries a second per key).
- **Host rows:** the server budget (`app_log_usage.server_count`, 10,000 a day, which
  anonymous ingestion cannot spend; #372) under their own burst key. Over budget,
  the row is dropped and the invalidation still happens.

## What remains unverified

- The Chess Clubs report (chess-academy#203) is not verified in production. The
  reproduced mechanism, a duplicate `init()` followed by a transient `/me`
  failure, is covered by the current shared-init guard and by regression tests.
  These events make the next real invalidation or unresolved hydration diagnosable.
- Events carry no SDK version. The app's own `monitoring.build` metadata (commit,
  version) is attached to every entry when the app supplies it; the SDK cannot
  stamp its own version at build time today, because `publish.yml` builds before it
  auto-bumps the version, so a baked constant would be one release behind.
- Whether the deployed apps run an SDK version with these events, and how often
  real users hit each reason, can only be read from production logs after rollout.
