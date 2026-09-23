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

  /**
   * Issue (or fetch the existing) license key for the signed-in user.
   * Requires an active platform subscription — throws `license.issue failed: 403`
   * otherwise. Idempotent: the live key is returned, not replaced.
   */
  async issue(): Promise<LicenseInfo> {
    const response = await this.auth.authenticatedFetch(
      new URL(`/v1/apps/${encodeURIComponent(this.appId)}/license`, this.apiBase),
      { method: 'POST' },
    );
    if (response.status === 401) { this.auth.handleUnauthorized(); throw new Error('license.issue failed: 401'); }
    if (!response.ok) throw new Error(`license.issue failed: ${response.status}`);
    return (await response.json()) as LicenseInfo;
  }

  /**
   * Revoke the signed-in user's license key(s) for this app — for a leaked key
   * while the subscription is still active. Returns how many keys were revoked;
   * call `issue()` afterwards for a replacement.
   */
  async revoke(): Promise<number> {
    const response = await this.auth.authenticatedFetch(
      new URL(`/v1/apps/${encodeURIComponent(this.appId)}/license`, this.apiBase),
      { method: 'DELETE' },
    );
    if (response.status === 401) { this.auth.handleUnauthorized(); throw new Error('license.revoke failed: 401'); }
    if (!response.ok) throw new Error(`license.revoke failed: ${response.status}`);
    const { revoked } = (await response.json()) as { revoked: number };
    return revoked;
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
