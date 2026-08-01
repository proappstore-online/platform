/**
 * Runtime monitoring — batches client log entries to
 * `POST /v1/apps/:appId/logs` so app owners can inspect real user-facing
 * failures after the fact (#105/#106).
 *
 * Auto-started by `initPro()` unless `monitoring.auto === false`. On start it
 * captures uncaught `error` and `unhandledrejection` events; the SDK also feeds
 * failed platform operations (e.g. `app.actions.call`) in via `log()`.
 *
 * Design (mirrors the Usage telemetry module):
 * - **Browser-only / SSR-safe.** Every method no-ops without `window`.
 * - **Silent.** Monitoring must never break an app — all network paths catch.
 * - **Batched.** Entries queue and flush on an interval + on `pagehide`
 *   (sendBeacon/keepalive so the last batch survives unload).
 * - **No secrets/PII.** Auto-capture takes only message + stack + source; the
 *   SDK never logs request bodies, SQL params, tokens, or credential values.
 */

interface AuthLike {
  token: string | null;
  isSignedIn?: boolean;
  usesPlatformCookie?: boolean;
}

export interface MonitoringOptions {
  /** Default true. Set false to disable auto-capture + auto-flush. */
  auto?: boolean;
  /** Build metadata attached to every entry (commit, version, …). */
  build?: Record<string, unknown>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface QueuedLog {
  ts: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

const FLUSH_MS = 15_000;
const MAX_QUEUE = 100;
const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;

function hasBrowser(): boolean {
  return typeof window !== 'undefined';
}
function trunc(s: unknown, max: number): string {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

export class Monitoring {
  private queue: QueuedLog[] = [];
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onError: ((e: ErrorEvent) => void) | null = null;
  private onRejection: ((e: PromiseRejectionEvent) => void) | null = null;
  private onPageHide: (() => void) | null = null;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
    private readonly build?: Record<string, unknown>,
  ) {}

  /** Attach auto-capture + periodic flush. Idempotent. */
  start(): void {
    if (this.running || !hasBrowser()) return;
    this.running = true;

    this.onError = (e) => this.log('error', 'runtime', e.message || 'uncaught error', {
      stack: trunc(e.error?.stack, MAX_STACK), source: e.filename, line: e.lineno, col: e.colno,
    });
    this.onRejection = (e) => {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      this.log('error', 'unhandledrejection', trunc(r?.message ?? String(e.reason ?? 'rejection'), MAX_MESSAGE), {
        stack: trunc(r?.stack, MAX_STACK),
      });
    };
    this.onPageHide = () => this.flush(true);

    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onRejection);
    window.addEventListener('pagehide', this.onPageHide);
    this.timer = setInterval(() => this.flush(false), FLUSH_MS);
  }

  /** Detach handlers + stop flushing. Idempotent. Does not flush. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (hasBrowser()) {
      if (this.onError) window.removeEventListener('error', this.onError);
      if (this.onRejection) window.removeEventListener('unhandledrejection', this.onRejection);
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    }
    this.onError = this.onRejection = this.onPageHide = null;
  }

  /** Queue a log entry. Cheap; no network until the next flush. */
  log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    const route = hasBrowser() && window.location ? window.location.pathname : undefined;
    const entry: QueuedLog = {
      ts: Date.now(),
      level,
      category: category.slice(0, 64),
      message: trunc(message, MAX_MESSAGE),
      data: { mode: this.auth.usesPlatformCookie ? 'platform-cookie' : 'legacy-bearer', ...(route ? { route } : {}), ...data },
    };
    this.queue.push(entry);
    // Bound memory: drop the oldest if a burst outruns the flush interval.
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  error(category: string, message: string, data?: Record<string, unknown>): void { this.log('error', category, message, data); }
  warn(category: string, message: string, data?: Record<string, unknown>): void { this.log('warn', category, message, data); }
  info(category: string, message: string, data?: Record<string, unknown>): void { this.log('info', category, message, data); }

  /** Log a caught exception with its stack. */
  capture(err: unknown, category = 'runtime'): void {
    const e = err as { message?: string; stack?: string } | undefined;
    this.log('error', category, trunc(e?.message ?? String(err), MAX_MESSAGE), { stack: trunc(e?.stack, MAX_STACK) });
  }

  /** Send queued entries. `keepalive` for page-close paths (sendBeacon). */
  flush(keepalive = false): void {
    if (!this.queue.length || !this.isAuthenticated()) return;
    const entries = this.queue.splice(0, this.queue.length).map((e) => ({
      ...e,
      ...(this.build ? { build: this.build } : {}),
    }));
    const body = JSON.stringify({ entries });
    const url = this.auth.usesPlatformCookie
      ? `/.pas/api/v1/apps/${encodeURIComponent(this.appId)}/logs`
      : `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/logs`;

    if (keepalive && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      } catch { /* fall through */ }
    }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const init: RequestInit = { method: 'POST', headers, body, keepalive };
      if (this.auth.usesPlatformCookie) {
        init.credentials = 'same-origin';
      } else {
        if (!this.auth.token) { return; }
        headers.Authorization = `Bearer ${this.auth.token}`;
      }
      void fetch(url, init).catch(() => {});
    } catch { /* monitoring never breaks an app */ }
  }

  private isAuthenticated(): boolean {
    return this.auth.usesPlatformCookie ? this.auth.isSignedIn === true : !!this.auth.token;
  }
}
