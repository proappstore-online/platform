/**
 * App logging + automatic runtime error capture (platform#105, ADR-008).
 *
 * Auto-started by `initPro()` unless `monitoring.auto === false`. Captures
 * `window.onerror` and `unhandledrejection`, batches entries, and flushes them to
 * `POST /v1/apps/:appId/logs`, where the app owner reads them in the console.
 *
 * Design notes:
 *
 * - **Works signed out.** Anonymous reports are the point: a white screen on load
 *   or a broken sign-in has no session, and those are the failures worth having.
 *   A rotating per-install `clientId` gives them a cardinality without naming a
 *   person.
 * - **Browser-only.** Every method no-ops without `window`, so the import stays
 *   SSR-safe.
 * - **Silent.** No throw path, ever. A logger that breaks the app it observes is
 *   worse than no logger.
 * - **Backs off instead of retrying.** The server answers 202 when an app is over
 *   its budget; retrying would turn an error loop into a flood. See `cooldown`.
 * - **Not a replacement for usage telemetry.** `app.usage` is unchanged; the two
 *   share only the transport.
 */

import { postTelemetry, type TelemetryAuth } from './telemetry-transport.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MonitoringOptions {
  /** Default true. Set false to disable auto-capture and the flush timer. */
  auto?: boolean;
  /** Build metadata attached to every entry (commit sha, version, built-at). */
  build?: Record<string, unknown>;
  /** Minimum level actually sent. Default 'info' — `debug` is dropped unless asked for. */
  level?: LogLevel;
}

interface QueuedEntry {
  ts: number;
  level: LogLevel;
  category: string;
  message: string;
  // `| undefined` is required under exactOptionalPropertyTypes: these fields are
  // assigned undefined explicitly and JSON.stringify drops them off the wire.
  data?: unknown | undefined;
  build?: Record<string, unknown> | undefined;
  traceId?: string | undefined;
}

const FLUSH_INTERVAL_MS = 10_000;
/** Matches the server's per-request cap; a full queue flushes immediately. */
const MAX_BATCH = 100;
/** Hard ceiling while offline or backing off. Oldest entries are dropped. */
const MAX_QUEUE = 200;
/** How long to stay quiet after the server says we are over budget. */
const COOLDOWN_MS = 60_000;
const MESSAGE_MAX = 4096;

const CLIENT_ID_KEY = 'pas:client-id';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Redact secret-shaped substrings before anything leaves the browser.
 *
 * Vendored deliberately rather than shared with the backend (the SDK ships to npm
 * and cannot import a private package). The server scrubs again at ingest — this
 * copy exists so a secret never crosses the network in the first place.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w\-._~+/]+=*/gi, 'Bearer [redacted]'],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|client[_-]?secret)\b("?\s*[:=]\s*)("?)[^\s,;"}&]+\3/gi,
    '$1$2[redacted]',
  ],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, '[email]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]'],
];

export function redactClient(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function hasBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Stable-per-install id, created on first use.
 *
 * Not a person identifier: it lives in this browser's storage, clears with site
 * data, and is never correlated across apps. It exists so an owner can tell "one
 * user hit this 40 times" from "40 users hit it once" for reports that have no
 * session at all.
 */
export function readOrCreateClientId(): string | null {
  if (!hasBrowser()) return null;
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const bytes =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2).padEnd(24, '0');
    const id = bytes.slice(0, 24);
    window.localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    // Incognito, blocked storage, quota — anonymous reports still work, they
    // just lose their per-install grouping.
    return null;
  }
}

/** Serialize an unknown thrown value into a message + stack. */
export function describeError(value: unknown): { message: string; stack?: string | undefined } {
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, stack: value.stack ?? undefined };
  }
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

export class Logs {
  private queue: QueuedEntry[] = [];
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onError: ((e: ErrorEvent) => void) | null = null;
  private onRejection: ((e: PromiseRejectionEvent) => void) | null = null;
  private onPageHide: (() => void) | null = null;
  private clientId: string | null = null;
  /** Epoch ms until which we send nothing (server asked us to stop). */
  private quietUntil = 0;
  /** Set when the server says this app cannot accept logs at all (404). */
  private disabled = false;
  /** Guards against an error raised inside our own handler re-entering. */
  private capturing = false;
  private minLevel: LogLevel;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: TelemetryAuth,
    private readonly options: MonitoringOptions = {},
  ) {
    this.minLevel = options.level ?? 'info';
  }

  /** Begin auto-capture and periodic flushing. Idempotent. */
  start(): void {
    if (this.running || !hasBrowser()) return;
    this.running = true;
    this.clientId = readOrCreateClientId();

    this.onError = (event: ErrorEvent) => {
      const described = event.error
        ? describeError(event.error)
        : { message: event.message || 'unknown error' };
      this.capture('error', 'window.error', described.message, {
        stack: described.stack,
        source: event.filename || undefined,
        line: event.lineno || undefined,
      });
    };
    window.addEventListener('error', this.onError);

    this.onRejection = (event: PromiseRejectionEvent) => {
      const described = describeError(event.reason);
      this.capture('error', 'unhandledrejection', described.message, {
        stack: described.stack,
      });
    };
    window.addEventListener('unhandledrejection', this.onRejection);

    this.onPageHide = () => this.flush();
    window.addEventListener('pagehide', this.onPageHide);

    this.timer = setInterval(() => {
      void this.send(false);
    }, FLUSH_INTERVAL_MS);
  }

  /** Stop capture and timers. Does not flush — call `flush()` first if needed. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (hasBrowser()) {
      if (this.onError) window.removeEventListener('error', this.onError);
      if (this.onRejection) window.removeEventListener('unhandledrejection', this.onRejection);
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    }
    this.onError = null;
    this.onRejection = null;
    this.onPageHide = null;
  }

  debug(message: string, data?: unknown): void {
    this.capture('debug', 'app', message, data);
  }

  info(message: string, data?: unknown): void {
    this.capture('info', 'app', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.capture('warn', 'app', message, data);
  }

  error(message: string, data?: unknown): void {
    this.capture('error', 'app', message, data);
  }

  /** Number of entries waiting to be sent. Exposed for tests and diagnostics. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Queue one entry.
   *
   * Public so app code can record its own categories (`app.logs.capture('warn',
   * 'checkout', ...)`), and so SDK primitives can report their own failures
   * (platform#106's client half) without another queue.
   */
  capture(level: LogLevel, category: string, message: string, data?: unknown): void {
    if (this.disabled || this.capturing) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    this.capturing = true;
    try {
      const entry: QueuedEntry = {
        ts: Date.now(),
        level,
        category,
        message: redactClient(String(message)).slice(0, MESSAGE_MAX),
        data: data === undefined ? undefined : this.safeData(data),
        build: this.options.build,
        traceId: this.newTraceId(),
      };
      this.queue.push(entry);
      // Drop the OLDEST on overflow: during a loop the newest entries are all
      // the same fault, while the first entries include what preceded it.
      if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
      if (this.queue.length >= MAX_BATCH) void this.send(false);
    } catch {
      // Never let capture throw into app code.
    } finally {
      this.capturing = false;
    }
  }

  /** Fire-and-forget flush, safe on the unload path. */
  flush(): void {
    void this.send(true);
  }

  /** Await a flush. For tests and deliberate checkpoints. */
  async flushAsync(): Promise<void> {
    await this.send(false);
  }

  private safeData(data: unknown): unknown {
    try {
      return JSON.parse(redactClient(JSON.stringify(data) ?? 'null'));
    } catch {
      // Cyclic, BigInt, or a getter that throws — keep the entry, drop the payload.
      return undefined;
    }
  }

  /** W3C traceparent trace-id, so a client entry can be lined up with the
   *  backend and data-worker records for the same logical request. */
  private newTraceId(): string | undefined {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID().replace(/-/g, '');
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  private async send(keepalive: boolean): Promise<void> {
    if (this.disabled || this.queue.length === 0) return;
    if (Date.now() < this.quietUntil) return;

    const batch = this.queue.slice(0, MAX_BATCH);
    // Remove before sending: a retry loop is worse than losing a log line, and
    // the entries most likely to be dropped are duplicates of a fault we already
    // reported.
    this.queue = this.queue.slice(batch.length);

    const body = JSON.stringify({
      entries: batch,
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });

    const res = await postTelemetry(this.auth, this.apiBase, `/v1/apps/${this.appId}/logs`, body, {
      keepalive,
      // A beacon cannot carry the bearer token, so only use it where the
      // same-origin cookie speaks for us. In legacy-bearer mode a keepalive
      // fetch still attaches the token and still survives unload in practice.
      beacon: this.auth.usesPlatformCookie === true,
    });
    if (!res) return;

    if (res.status === 404) {
      // Unknown app id — a misconfigured `appId` will never succeed, so stop
      // rather than retry every ten seconds for the life of the page.
      this.disabled = true;
      return;
    }
    if (res.status === 202 || res.status === 429) {
      // Over budget. Go quiet; the server is still counting the spike.
      this.quietUntil = Date.now() + COOLDOWN_MS;
    }
  }
}
