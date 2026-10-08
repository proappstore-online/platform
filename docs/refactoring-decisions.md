# Refactoring decisions

This record captures the non-mechanical follow-ups from #250. They were reviewed
in #314 and intentionally remain explicit where merging them would alter a
public response, validation rule, or API surface.

## Custom `HttpError` handling

`lib/route-wrap.ts` is deliberately limited to the plain-text `HttpError`
contract. The remaining inline handlers are not duplicates: payment routes turn
Stripe failures into 502s; invite and storage flows continue after or decorate a
refusal; AI and secrets use JSON errors; analytics, passkeys and QA translate
upstream failures; deploy exposes JSON admin errors; and app-worker deployment
must audit failures. A common wrapper would silently change an observable body,
header, status, or audit effect.

## Deliberately separate helpers

- `isAdmin` answers whether a stored identity appears in `ADMIN_GITHUB_IDS`;
  `requireAdmin` authenticates the current signed session and rejects it with
  the route's `admin only` policy. They are different trust boundaries.
- Base64url routines retain their local validation contracts: passkeys rejects
  malformed client values as `HttpError`, while token and email code decodes
  untrusted signed payloads differently. Do not merge them without preserving
  every decoder's failure semantics.
- SDK request helpers and UI primitives remain public compatibility surfaces;
  similarly named Pro components have intentionally different behavior.

## Resolved stale/dead candidates

- The unused generic `requireRole` helper was removed. Routes now state their
  platform policy explicitly; admin-only routes use `requireAdmin`.
- The empty `RETIRED_CHECK_IDS` list and unexported `FasInitOptions` type were
  removed.
- `APP_ROLE_CONVENTIONS`, `AppRole`, and `ERRORS_DATASET` remain because they
  document platform conventions/data-set names.
- `ProjectDO.publishKb()` is live through Architect chat, and the agent catalog
  already exposes Architect; neither is dead code.
