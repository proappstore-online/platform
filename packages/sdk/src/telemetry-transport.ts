/**
 * Shared POST transport for SDK telemetry (usage pings, app logs).
 *
 * Extracted from usage.ts rather than reimplemented for the logger: the awkward
 * parts — same-origin mediated URL vs absolute API base, bearer-vs-cookie auth,
 * and `sendBeacon` on unload — were already solved there, and a second copy
 * would drift.
 *
 * Never throws and never rejects. Telemetry must not break an app.
 */

export interface TelemetryAuth {
  token: string | null;
  usesPlatformCookie?: boolean;
}

/** In platform-cookie mode all calls go same-origin through the host's mediation
 *  so the HttpOnly cookie rides along (and the host can assert the app id). */
export function telemetryUrl(auth: TelemetryAuth, apiBase: string, path: string): string {
  return auth.usesPlatformCookie ? `/.pas/api${path}` : `${apiBase}${path}`;
}

export interface PostOptions {
  /** Unload path: prefer a transport that survives page close. */
  keepalive?: boolean;
  /**
   * Whether `sendBeacon` is acceptable for this payload.
   *
   * Beacons cannot set `Authorization`. In platform-cookie mode the same-origin
   * beacon still carries the session cookie, so nothing is lost; in
   * legacy-bearer mode the request would arrive unauthenticated, which each
   * caller has to decide about for itself.
   */
  beacon?: boolean;
}

/**
 * POST a JSON body. Returns the Response, or null when the request could not be
 * made or was sent via `sendBeacon` (which yields no response).
 */
export async function postTelemetry(
  auth: TelemetryAuth,
  apiBase: string,
  path: string,
  body: string,
  opts: PostOptions = {},
): Promise<Response | null> {
  const url = telemetryUrl(auth, apiBase, path);
  const keepalive = opts.keepalive === true;

  if (
    keepalive &&
    opts.beacon !== false &&
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return null;
    } catch {
      // Fall through to fetch.
    }
  }

  if (typeof fetch === 'undefined') return null;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const init: RequestInit = { method: 'POST', headers, body, keepalive };
    if (auth.usesPlatformCookie) {
      init.credentials = 'same-origin';
    } else if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }
    // No token and no cookie is not an error here: log ingestion accepts
    // anonymous reports on purpose, since a failure before sign-in is exactly
    // the one worth having.
    return await fetch(url, init);
  } catch {
    return null;
  }
}
