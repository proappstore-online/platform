interface AuthLike {
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export type TokenAccess = 'read' | 'write';

export interface AppToken {
  /** Random id used to list and revoke — never derived from the token. */
  token_id: string;
  app_id: string;
  label: string | null;
  access: TokenAccess;
  /** null = every action of the app. */
  actions: string[] | null;
  created_origin: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  expired: boolean;
}

export interface MintedAppToken extends Omit<AppToken, 'last_used_at' | 'expired'> {
  /** The plaintext `pas_at_…` token. Shown once; the platform stores only its hash. */
  token: string;
  /** Present when the requested lifetime was capped for this origin. */
  note?: string;
}

export interface CreateTokenOptions {
  /** Shown in token lists. */
  label?: string;
  /** Lifetime in seconds. Required. Capped at 90 days from an app origin, 365 from the dashboard. */
  expiresIn: number;
  /** Required. `read` may call query actions only. */
  access: TokenAccess;
  /** Restrict the token to these actions; omitted = every action of the app. */
  actions?: string[];
}

/**
 * Personal app tokens (#154): a signed-in user mints long-lived, revocable
 * bearers for THIS app, to call `POST /v1/apps/<app>/actions/<name>` from
 * scripts and integrations. Tokens work on the HTTP actions route only — not on
 * MCP (which has its own OAuth) and not on any other platform route.
 */
export class Tokens {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.auth.authenticatedFetch(`${this.apiBase}${path}`, init);
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`tokens request failed: ${response.status} ${text}`);
    }
    return (await response.json()) as T;
  }

  /** Mint a token. The returned `token` is the only time the plaintext is available. */
  async create(opts: CreateTokenOptions): Promise<MintedAppToken> {
    return this.request<MintedAppToken>(`/v1/apps/${encodeURIComponent(this.appId)}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: opts.label,
        expires_in: opts.expiresIn,
        access: opts.access,
        ...(opts.actions ? { actions: opts.actions } : {}),
      }),
    });
  }

  /** My tokens for this app. Never includes the token itself. */
  async list(): Promise<AppToken[]> {
    const res = await this.request<{ tokens: AppToken[] }>(`/v1/apps/${encodeURIComponent(this.appId)}/tokens`);
    return res.tokens;
  }

  /** Every token I hold across all apps (what the dashboard shows). */
  async listAll(): Promise<AppToken[]> {
    const res = await this.request<{ tokens: AppToken[] }>('/v1/me/tokens');
    return res.tokens;
  }

  /** Revoke one of my tokens for this app by its id. */
  async revoke(tokenId: string): Promise<void> {
    await this.request(`/v1/apps/${encodeURIComponent(this.appId)}/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
  }
}
