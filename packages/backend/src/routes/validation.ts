/**
 * Shared route-input validation. One source of truth — APP_ID_RE was previously
 * defined in three places with two different semantics (unbounded in usage.ts /
 * submissions-helpers.ts with a separate length check, but `{1,30}` baked into
 * analytics-shared.ts), so two code paths disagreed on what a valid app id is.
 *
 * A lowercase slug starting with a letter, 1–58 chars (matching the existing
 * external length caps in usage.ts / submissions.ts). Char-safe for use as a
 * validated segment before parameterized SQL / subrequest paths.
 */
export const APP_ID_RE = /^[a-z][a-z0-9-]{0,57}$/;
