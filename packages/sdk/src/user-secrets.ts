interface AuthLike {
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** One of the signed-in user's own secrets for this app. Never the value. */
export interface UserSecret {
  name: string;
  updatedAt: number;
  lastUsedAt: number | null;
}

/**
 * The signed-in user's own secrets for this app (#587): bring-your-own API keys.
 *
 *   await app.userSecrets.set('OPENAI_KEY', key)   // a name declared in mcp.json `user_secrets`
 *   const res = await app.proxy.fetch('api.openai.com/v1/organization/costs')
 *
 * Values are write-only: they are encrypted for this (app, user, name) and only
 * ever leave the platform injected into a proxy call by a rule with
 * `secretScope: 'user'`. `list()` returns names and times, never values.
 * Requires `initPro({ authMode: 'platform-cookie' })`: the platform accepts these
 * calls only from the app's own origin.
 */
export class UserSecrets {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.auth.authenticatedFetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/user-secrets${path}`, init);
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`userSecrets request failed: ${response.status} ${text}`);
    }
    return response;
  }

  /** Store (or replace) the user's secret `name`. */
  async set(name: string, value: string): Promise<void> {
    await this.request(`/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  }

  /** Delete the user's secret `name`. */
  async delete(name: string): Promise<void> {
    await this.request(`/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  /** The user's secrets for this app: names and times, never values. */
  async list(): Promise<UserSecret[]> {
    const { secrets } = (await (await this.request('')).json()) as { secrets: UserSecret[] };
    return secrets;
  }
}
