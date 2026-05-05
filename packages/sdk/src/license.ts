import type { LicenseInfo } from './types.js';

export class LicenseApi {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly token: () => string | null,
  ) {}

  /** Returns the license info for the signed-in user, or null. */
  async current(): Promise<LicenseInfo | null> {
    const token = this.token();
    if (!token) return null;
    const res = await fetch(
      new URL(`/v1/apps/${encodeURIComponent(this.appId)}/license`, this.apiBase),
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`license.current failed: ${res.status}`);
    return (await res.json()) as LicenseInfo;
  }

  /**
   * Validate an arbitrary license key against the server. Useful for cases
   * where the key is delivered out-of-band (email, manual entry).
   */
  async validate(key: string): Promise<boolean> {
    const res = await fetch(new URL('/v1/license/validate', this.apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, key }),
    });
    if (!res.ok) return false;
    const { valid } = (await res.json()) as { valid: boolean };
    return valid;
  }
}
