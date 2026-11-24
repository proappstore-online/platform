---
description: "Phone diagnostics and the user's own cross-app read of native data: what diagnostics may contain, and why owner reads are first-party only."
---

# ADR-019: Native diagnostics and owner access

## Status

Accepted. Extends ADR-015 and ADR-018; supersedes neither. Amends [ADR-020](./020-native-collection-sessions.md) §6 (see decision 6).

## Date

2026-11-24

## Context

The companion's state (permissions, queue, sharing sessions, sync errors, the activity log) lives only on the phone, and the platform's native data is readable only by each app through its own origin (`appUser`, #613). Users asked to see all of it, in the companion and through their own AI assistant over the PAS MCP (#660). Two shortcuts are tempting and wrong: put samples into a diagnostics report, and expose a cross-app read to any signed-in session. App pages hold the user's session, so the second would let any app read every app's location.

## Decision

1. **Diagnostics are platform telemetry, not a native capability.** They have no catalog entry, no grant, no per-app consent and no recipient app. They are on by default, the user can turn them off in the companion, and turning them off deletes the server copy.
2. **A diagnostics report never contains location points, heart-rate samples or any other Collect sample**, nor sensor names or identifiers. It carries counts, states, versions, timestamps, sharing sessions and the activity log (whose details are short codes and server error text, never coordinates). The backend rebuilds the report from whitelisted fields and drops everything else (`nativeDiagnosticsSnapshot` in `packages/backend/src/routes/native-account.ts`). A new field needs a change to that whitelist, reviewed against this rule.
3. **One report per device, replaced on upload, kept 7 days**, deleted with the device.
4. **The user's own cross-app read (`/v1/me/native/*`) requires the user's session and the first-party `X-Internal-Token`**, as `/v1/auth/me/account` does (#136). It refuses an app-bound credential. It is never reachable from an app page: the host strips a browser-supplied internal token. Apps keep reading only through `appUser`.
5. **The device credential is still accepted only by `/native/*`** (ADR-018 §11). It has no read of uploaded data.
6. **Sessions stay unreported to apps.** ADR-020 §6 said sessions are "not reported to the app or the platform". With Diagnostics on, the phone's sessions (running, started when, why the last one ended) are in its report, readable by the user only through decision 4. They are still never reported to an app: no app read or app status gains session or pause state.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Owner reads with a session alone | Any PAS app's page holds the user's session and could read every app's location. |
| A role or scope gate instead of the internal token | MCP sessions are de-privileged to `user` (#56); a role gate would lock out the only caller. |
| Diagnostics as an ADR-018 capability | It has no recipient app, and a catalog entry would put a consent screen in front of telemetry the platform needs for every app. |
| Append every report | Repeats the same activity entries on each upload; one current report plus the activity log's own timestamps answers the same questions. |
| A device-credential read route for the phone's own data | Widens what a stolen device credential can read; the phone already has its own copy. |

## Consequences

**Positive:**
- A user, or their assistant, can see every device, grant, sample and failure for their account in one place.
- App isolation is unchanged.

**Negative:**
- Owner reads depend on `INTERNAL_TOKEN` reaching the MCP worker; without it the tools fail closed.
- The users doc and store declarations gain a diagnostics data type.

**Neutral:**
- The activity log now has a 7-day server copy when diagnostics are on; its on-phone 30-day copy is unchanged.
