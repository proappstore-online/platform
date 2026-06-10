import type { LicenseInfo } from './types.js';

interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export class LicenseApi {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Returns the license info for the signed-in user, or null. */
  async current(): Promise<LicenseInfo | null> {
    let response: Response;
    try {
      response = await this.auth.authenticatedFetch(new URL(`/v1/apps/${encodeURIComponent(this.appId)}/license`, this.apiBase));
    } catch {
      return null;
    }
    if (response.status === 401) { this.auth.handleUnauthorized(); return null; }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`license.current failed: ${response.status}`);
    return (await response.json()) as LicenseInfo;
  }

  /** Validate an arbitrary license key against the server (no auth required). */
  async validate(key: string): Promise<boolean> {
    const response = await fetch(new URL('/v1/license/validate', this.apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, key }),
    });
    if (!response.ok) return false;
    const { valid } = (await response.json()) as { valid: boolean };
    return valid;
  }
}
