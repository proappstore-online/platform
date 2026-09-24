interface AuthLike {
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** Minimal logger surface (satisfied by Logs) — failures only, never params. */
interface LoggerLike {
  capture(level: 'error', category: string, message: string, data?: Record<string, unknown>): void;
}

/**
 * What a `verify` action returns (#148): the platform verifier's verdict, and
 * the write results when the tool declared statements and the verifier ran.
 * `ok: false` means the input could not be verified (no row, malformed data)
 * and nothing was written.
 */
export interface ActionVerifyResult<TOutput = Record<string, string | number | boolean | null>> {
  ok: boolean;
  verifier: string;
  output: TOutput;
  error?: string;
  writes?: { changes?: number; last_row_id?: number | null }[];
}

export class Actions {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
    private readonly logger?: LoggerLike,
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
      // #106: record the failure (action name + status only — never the params).
      this.logger?.capture('error', 'action', `action ${name} unauthorized`, { action: name, status: 401 });
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger?.capture('error', 'action', `action ${name} failed`, { action: name, status: response.status });
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
