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

/**
 * A refused or failed action call (#299). The message is unchanged from before
 * (`actions.<name> failed: <status> <body>`); `code` is the server's `error`
 * field — e.g. `step_up_required` or `requires app role` — and `body` the rest
 * of its JSON body (a step-up refusal carries `max_age`, and `method: 'passkey'`
 * when only a passkey will do).
 */
export class ActionError extends Error {
  readonly code: string | null;
  readonly body: Record<string, unknown> | null;

  constructor(readonly action: string, readonly status: number, text: string) {
    super(`actions.${action} failed: ${status} ${text}`);
    this.name = 'ActionError';
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    this.body = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    this.code = typeof this.body?.error === 'string' ? this.body.error : null;
  }

  /** The server wants a recent sign-in (or a passkey check, see {@link needsPasskey}) before it runs this action. */
  get stepUpRequired(): boolean {
    return this.code === 'step_up_required';
  }

  /** Only a passkey step-up will do; a fresh sign-in would be refused again. Every app `step_up` action answers this way (#337). */
  get needsPasskey(): boolean {
    return this.stepUpRequired && this.body?.method === 'passkey';
  }

  /**
   * The caller lacks a role the action declares (`auth.app_roles` /
   * `auth.platform_roles`). Only those refusals (#344): a private app, a
   * worker- or hook-only action, a read-only token or a scheduled action is a
   * 403 too, with its own `code`, and is not a missing role.
   */
  get forbidden(): boolean {
    return this.status === 403 && (this.code === 'requires app role' || this.code === 'requires platform role');
  }
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
      throw new ActionError(name, response.status, text);
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
      throw new ActionError(name, response.status, text);
    }
    return (await response.json()) as T;
  }
}
