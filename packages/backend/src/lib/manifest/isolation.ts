/**
 * The `isolation` section (#452): `"isolation": "cross-origin"`.
 *
 * `SharedArrayBuffer`, high-resolution timers and WebAssembly threads need the page to be
 * cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` plus a
 * `Cross-Origin-Embedder-Policy`. That breaks things most apps rely on (cross-origin images,
 * fonts and scripts without CORP/CORS headers, popup-based OAuth and payment flows,
 * iframes without COEP), so it is off by default and an app opts in.
 *
 * Two modes, because the browsers differ:
 * - `cross-origin`        COOP same-origin + COEP `credentialless`. Gentler (cross-origin no-CORS
 *                         requests are sent without credentials instead of blocked) but Chromium and
 *                         Firefox only: Safari does not support it, so there the page is not isolated.
 * - `cross-origin-strict` COOP same-origin + COEP `require-corp`. Isolates in every browser that
 *                         supports isolation at all, at the price of blocking every cross-origin
 *                         subresource that does not opt in with CORP or CORS.
 */

export const ISOLATION_MODES = ['cross-origin', 'cross-origin-strict'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

/** Absent, null or "none" is the default: not isolated. */
export function validateIsolation(raw: unknown): { error: string } | { isolation: IsolationMode | null } {
  if (raw === undefined || raw === null || raw === 'none') return { isolation: null };
  if (typeof raw !== 'string' || !(ISOLATION_MODES as readonly string[]).includes(raw)) {
    return { error: `isolation must be ${ISOLATION_MODES.map((m) => `"${m}"`).join(' or ')} (or omitted for the default, not isolated)` };
  }
  return { isolation: raw as IsolationMode };
}
