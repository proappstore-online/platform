interface AuthLike {
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export class Actions {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  async call<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.auth.authenticatedFetch(
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/actions/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      },
    );
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`actions.${name} failed: ${response.status} ${text}`);
    }
    return (await response.json()) as T;
  }

  async callPublic<T = unknown>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(
      `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/actions/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`actions.${name} failed: ${response.status} ${text}`);
    }
    return (await response.json()) as T;
  }
}
