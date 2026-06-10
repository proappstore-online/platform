/** Minimal auth interface — matches the Auth class from @freeappstore/sdk. */
interface Auth {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Browser-side wrapper around the platform's per-app secret-injecting proxy.
 *
 * Pattern:
 *   const fas = initApp({ appId: 'weather' });
 *   const res = await fas.proxy.fetch(
 *     'api.openweathermap.org/data/2.5/weather?q=London',
 *   );
 *
 * The first segment is the upstream host; the rest is path + query. The
 * platform Worker authenticates the call with the user's session token,
 * matches the URL against the app's allowlist, decrypts the developer's
 * stored API key, and forwards the request server-side.
 *
 * The developer's secret never touches the browser.
 */
export class ApiProxy {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /**
   * Fetch via the proxy. Accepts either:
   *   - "host/path?query"  (preferred, matches the SDK's CLI register form)
   *   - a full "https://host/path?query" URL (we strip the scheme)
   */
  async fetch(target: string, init?: RequestInit): Promise<Response> {
    const url = `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/proxy/${normalizeTarget(target)}`;
    const headers = new Headers(init?.headers);
    const proxyResponse = await this.auth.authenticatedFetch(url, { ...init, headers });
    if (proxyResponse.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('proxy.fetch: session expired. User has been signed out.');
    }
    return proxyResponse;
  }
}

/**
 * Strip a leading scheme (`https://`, `http://`) so callers can paste either
 * form and get the same result. Throws on schemes other than http(s) — the
 * proxy only ever forwards over https upstream and we want a loud error
 * rather than a silent rewrite.
 *
 * Scheme detection is case-insensitive: `HTTPS://api.example.com/x` should
 * normalize the same as `https://api.example.com/x`.
 */
export function normalizeTarget(target: string): string {
  const schemeMatch = target.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      return target.slice(schemeMatch[0].length);
    }
    throw new Error('proxy.fetch: only http(s) targets are supported');
  }
  // Already in "host/path" form.
  return target.replace(/^\/+/, '');
}
