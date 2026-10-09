# Session-loss diagnostics

Issue #353 extends the existing owner-only app log pipeline with two fixed-shape
SDK events: `auth.session_lost` and `auth.hydration_failure`. They are diagnostic
events, not evidence that a reported production logout has been root-caused.

`auth.session_lost` is emitted only for a real in-memory authenticated-to-signed-
out transition. Reasons are `api_401` (the PAS API plane invalidated the host
cookie), `legacy_session_rejected`, and `explicit_sign_out`. A transient network
failure during hydration records `auth.hydration_failure` with `network_error`;
an HTTP failure uses `http_error` plus its numeric status. Neither by itself
discards an already authenticated session.

For an API-plane 401, the host generates a random 32-hex correlation ID, emits it
in its operational log, and returns it in same-origin response headers. The SDK
stores the same ID as the app-log `traceId`, so an app owner can filter the
existing owner-only logs by `trace_id` and operators can join the result to host
invalidation logs. The regular payload scrubber masks the duplicate data value;
the dedicated trace column remains the correlation key. The ID is random and carries no user,
session, cookie, or token data. Data-plane and app-worker 401s do not create this
header and must not sign a user out.

The telemetry schema is allowlisted: reason, phase, route code, correlation ID,
prior-auth boolean, optional numeric status, elapsed milliseconds, online state,
and visibility state. It accepts no URLs, query strings, error objects, headers,
payloads, or user data. Existing logger limits still apply: 100 entries per send,
200 queued entries, 4 KB fields, daily/burst quotas, cooldowns, and no retry loop.

The Chess Clubs report remains unverified in production. The historical duplicate
`init()` mechanism is covered by the current shared-init guard; these events make
future authoritative invalidations and unresolved hydrations diagnosable without
weakening session semantics.
