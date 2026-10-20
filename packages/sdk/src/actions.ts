import { classifyTransportError, createRequestContext, makeTraceparent, type CaptureContext, type RequestContext } from './trace.js';

interface AuthLike {
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit, context?: RequestContext): Promise<Response>;
}

/** Minimal logger surface (satisfied by Logs) — failures only, never params. */
interface LoggerLike {
  capture(level: 'error', category: string, message: string, data?: Record<string, unknown>, context?: CaptureContext): void;
  captureException?(error: unknown, context?: CaptureContext & { category?: string }): void;
  addBreadcrumb?(category: 'action', message: string, data?: Record<string, number>): void;
}

/** Options for one action call (#392). */
export interface ActionCallOptions {
  /** Cancels the call. A cancellation you asked for is recorded as a breadcrumb, not an error; `AbortSignal.timeout(ms)` counts as a timeout. */
  signal?: AbortSignal;
  /**
   * Validate, authorize and bind without running (#428). The app's owner and team
   * only, by session; it answers `{ dry_run: true, state, rows: [] }` for a query or
   * `{ …, changes: 0 }` for a write and never touches data. `call` only.
   */
  dryRun?: boolean;
}

const ERROR_CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** The context a failed call is logged with (#390): its trace, its client span, and the server's safe error code. */
function failureContext(ctx: RequestContext, durationMs: number, errorCode: unknown): CaptureContext {
  return {
    traceId: ctx.traceId, spanId: ctx.spanId, operation: ctx.operation, result: 'error', durationMs,
    ...(typeof errorCode === 'string' && ERROR_CODE_RE.test(errorCode) ? { errorCode } : {}),
  };
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
 * when only a passkey will do). `traceId` (#390) is the trace the call was sent
 * with — the same id as the server's log row and the response's `traceId` — and
 * `durationMs` how long it took; both are null on an error built without them.
 */
export class ActionError extends Error {
  readonly code: string | null;
  readonly body: Record<string, unknown> | null;
  readonly traceId: string | null;
  readonly durationMs: number | null;

  constructor(readonly action: string, readonly status: number, text: string, trace?: { traceId: string; durationMs: number }) {
    super(`actions.${action} failed: ${status} ${text}`);
    this.name = 'ActionError';
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    this.body = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    this.code = typeof this.body?.error === 'string' ? this.body.error : null;
    this.traceId = trace?.traceId ?? null;
    this.durationMs = trace?.durationMs ?? null;
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
  /** The action is registered but the app has not gone live: only its owner and team may call it yet (#428). */
  get staged(): boolean {
    return this.status === 403 && (this.code?.startsWith('action is staged') ?? false);
  }

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

  async call<T = unknown>(name: string, params: Record<string, unknown> = {}, options: ActionCallOptions = {}): Promise<T> {
    // A context per call (#390): concurrent calls never share a trace.
    const ctx = createRequestContext(`action.${name}`);
    let response: Response;
    try {
      response = await this.auth.authenticatedFetch(
        `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/actions/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options.dryRun ? { params, dry_run: true } : { params }),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        ctx,
      );
    } catch (error) {
      this.transportFailed(name, ctx, error, options.signal);
      throw error;
    }
    if (response.status === 401) {
      // #106: record the failure (action name + status only — never the params).
      this.logger?.capture('error', 'action', `action ${name} unauthorized`, { action: name, status: 401 }, failureContext(ctx, Date.now() - ctx.startedAt, 'unauthorized'));
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) throw await this.failed(name, ctx, response);
    return (await response.json()) as T;
  }

  async callPublic<T = unknown>(name: string, params: Record<string, unknown> = {}, options: ActionCallOptions = {}): Promise<T> {
    const ctx = createRequestContext(`action.${name}`);
    let response: Response;
    try {
      response = await fetch(
        `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/actions/${encodeURIComponent(name)}`,
        {
          method: 'POST',
          // The URL is always the PAS API, so the trace header is allowlisted.
          headers: { 'Content-Type': 'application/json', traceparent: makeTraceparent(ctx.traceId, ctx.spanId) },
          body: JSON.stringify({ params }),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      this.transportFailed(name, ctx, error, options.signal);
      throw error;
    }
    if (!response.ok) throw await this.failed(name, ctx, response);
    return (await response.json()) as T;
  }

  /**
   * The request never got a response (#392). A cancellation the caller asked
   * for is a breadcrumb; a timeout or network failure is one error event with
   * the call's trace, since no server saw it. The caller still gets the
   * original error, unchanged.
   */
  private transportFailed(name: string, ctx: RequestContext, error: unknown, signal: AbortSignal | undefined): void {
    try {
      const kind = classifyTransportError(error, signal);
      const durationMs = Date.now() - ctx.startedAt;
      if (kind === 'cancelled') {
        this.logger?.addBreadcrumb?.('action', `action ${name} cancelled`, { durationMs });
      } else if (kind) {
        this.logger?.captureException?.(error, { ...failureContext(ctx, durationMs, kind === 'timeout' ? 'timeout' : 'network_error'), category: 'action' });
      }
    } catch {
      // Telemetry never changes the call's outcome.
    }
  }

  private async failed(name: string, ctx: RequestContext, response: Response): Promise<ActionError> {
    const text = await response.text().catch(() => '');
    const durationMs = Date.now() - ctx.startedAt;
    const error = new ActionError(name, response.status, text, { traceId: ctx.traceId, durationMs });
    this.logger?.capture('error', 'action', `action ${name} failed`, { action: name, status: response.status }, failureContext(ctx, durationMs, error.body?.errorCode));
    return error;
  }
}
