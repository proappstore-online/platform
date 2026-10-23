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
 * - **Backs off instead of retrying into a flood.** The server answers 202 when an
 *   app is over its budget; the SDK goes quiet (see `COOLDOWN_MS`). Only a
 *   transient failure (network, timeout, 5xx) is retried, a few times with
 *   backoff and within a TTL (#392); offline, the queue waits for `online`.
 * - **Best effort.** The queue is bounded and lives in memory: a closed tab, a
 *   long outage or an over-budget app loses entries. `health()` says how many.
 * - **Not a replacement for usage telemetry.** `app.usage` is unchanged; the two
 *   share only the transport.
 */

import { SDK_VERSION } from './sdk-version.js';
import type { CaptureContext } from './trace.js';
import { sendTelemetry, type TelemetryAuth, type TelemetryResult } from './telemetry-transport.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fixed, privacy-reviewed session diagnostics emitted by {@link Auth}. */
export type AuthTelemetryEvent = {
  category: 'auth.session_lost' | 'auth.hydration_failure';
  reason: 'api_401' | 'explicit_sign_out' | 'legacy_session_rejected' | 'http_error' | 'network_error';
  phase: 'api_request' | 'cookie_hydration' | 'legacy_hydration' | 'explicit_sign_out';
  route: 'platform.api' | 'auth.me' | 'auth.logout';
  /** Anonymous 32-hex correlation id. It is persisted as the log trace id. */
  correlationId: string;
  priorAuthenticated: boolean;
  status?: number;
  elapsedMs: number;
  online: boolean | null;
  visibility: 'visible' | 'hidden' | 'unknown';
};

const AUTH_CATEGORIES = new Set<AuthTelemetryEvent['category']>(['auth.session_lost', 'auth.hydration_failure']);
const AUTH_REASONS = new Set<AuthTelemetryEvent['reason']>(['api_401', 'explicit_sign_out', 'legacy_session_rejected', 'http_error', 'network_error']);
const AUTH_PHASES = new Set<AuthTelemetryEvent['phase']>(['api_request', 'cookie_hydration', 'legacy_hydration', 'explicit_sign_out']);
const AUTH_ROUTES = new Set<AuthTelemetryEvent['route']>(['platform.api', 'auth.me', 'auth.logout']);
const CORRELATION_ID_RE = /^[a-f0-9]{32}$/i;

export type { CaptureContext } from './trace.js';

/** Envelope version on every entry; the ingest allowlist keys on it. */
export const LOG_ENVELOPE_VERSION = 1;
const SPAN_ID_RE = /^[a-f0-9]{16}$/i;
const CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_DURATION_MS = 60 * 60 * 1000;

function envelopeFields(ctx: CaptureContext | undefined): Partial<QueuedEntry> {
  if (!ctx) return {};
  const out: Partial<QueuedEntry> = {};
  if (typeof ctx.spanId === 'string' && SPAN_ID_RE.test(ctx.spanId) && !/^0+$/.test(ctx.spanId)) out.spanId = ctx.spanId.toLowerCase();
  if (typeof ctx.operation === 'string' && CODE_RE.test(ctx.operation)) out.operation = ctx.operation;
  if (ctx.result === 'ok' || ctx.result === 'error') out.result = ctx.result;
  if (typeof ctx.errorCode === 'string' && CODE_RE.test(ctx.errorCode)) out.errorCode = ctx.errorCode;
  if (Number.isInteger(ctx.durationMs) && ctx.durationMs! >= 0 && ctx.durationMs! <= MAX_DURATION_MS) out.durationMs = ctx.durationMs!;
  return out;
}

/** What a breadcrumb records (#392). Anything else is ignored. */
export type BreadcrumbCategory = 'navigation' | 'ui' | 'network' | 'room' | 'auth' | 'action';
const BREADCRUMB_CATEGORIES = new Set<BreadcrumbCategory>(['navigation', 'ui', 'network', 'room', 'auth', 'action']);

/** Primitive values only: a breadcrumb never carries an object, DOM node or form payload. */
export type BreadcrumbData = Record<string, string | number | boolean | null>;

export interface Breadcrumb {
  ts: number;
  category: BreadcrumbCategory;
  message: string;
  data?: BreadcrumbData;
}

/** Delivery health of `app.logs` (#392). Counts are since the logger started. */
export interface LogHealth {
  /** Entries waiting to be sent. */
  queued: number;
  /** Entries the server accepted, or handed to `sendBeacon`. */
  sent: number;
  /** Entries lost: queue overflow, retries exhausted, over budget (202/429), unknown app (404). */
  dropped: number;
  /** Repeats folded into an earlier queued entry instead of sent again. */
  duplicates: number;
  /** Breadcrumbs held in memory. */
  breadcrumbs: number;
  /** True once the server said this app cannot accept logs (404). Permanent for the page. */
  disabled: boolean;
  /** Epoch ms until which nothing is sent (server backpressure), or null. */
  quietUntil: number | null;
}

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
  v: number;
  sdkVersion: string;
  operation?: string;
  spanId?: string;
  result?: 'ok' | 'error';
  errorCode?: string;
  durationMs?: number;
}

const FLUSH_INTERVAL_MS = 10_000;
/** Matches the server's per-request cap; a full queue flushes immediately. */
const MAX_BATCH = 100;
/** Hard ceiling while offline or backing off. Oldest entries are dropped. */
const MAX_QUEUE = 200;
/** How long to stay quiet after the server says we are over budget. */
const COOLDOWN_MS = 60_000;
const MESSAGE_MAX = 4096;
/** Backoff before each retry of a batch that failed transiently. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/** A batch still failing this long after its first failure is dropped, not retried. */
const RETRY_TTL_MS = 60_000;
const MAX_BREADCRUMBS = 50;
/** The most recent breadcrumbs attached to an error entry. */
const ATTACHED_BREADCRUMBS = 20;
const BREADCRUMB_MESSAGE_MAX = 200;
const BREADCRUMB_VALUE_MAX = 120;
const BREADCRUMB_DATA_KEYS = 8;
/** An identical entry among the last few queued is folded into it (`repeats`). */
const DEDUPE_WINDOW = 5;
/** Ingest keeps `data` up to 4 KB of JSON; leave room for its redaction. */
const DATA_BUDGET = 3500;
const STACK_MAX = 2500;
const MAX_CAUSE_DEPTH = 5;
const CAUSE_LINES = 4;

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

function describeOne(value: unknown): { message: string; stack?: string | undefined } {
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

/**
 * Serialize an unknown thrown value into a message + stack. An Error's `cause`
 * chain (#392, up to five levels) is appended to the stack as `Caused by:`
 * sections, so a wrapped failure keeps its root. Bounded; never throws.
 */
export function describeError(value: unknown): { message: string; stack?: string | undefined } {
  const head = describeOne(value);
  const causes: string[] = [];
  try {
    const seen = new Set<unknown>([value]);
    let cause = value instanceof Error ? (value as { cause?: unknown }).cause : undefined;
    for (let depth = 0; cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH && !seen.has(cause); depth++) {
      seen.add(cause);
      const described = describeOne(cause);
      // The message and the top frames: enough to place the root, small enough to keep every level.
      causes.push(`Caused by: ${(described.stack ?? described.message).split('\n').slice(0, CAUSE_LINES).join('\n')}`);
      cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
    }
  } catch {
    // A hostile `cause` getter: keep what we have.
  }
  if (!head.stack && causes.length === 0) return { message: head.message };
  const tail = causes.join('\n').slice(0, STACK_MAX);
  // The outer stack gives way first, so the root cause always survives the cap.
  const outer = head.stack ? head.stack.slice(0, Math.max(0, STACK_MAX - tail.length - 1)) : '';
  return { message: head.message, stack: [outer, tail].filter(Boolean).join('\n') };
}

/** Category of a render error a React error boundary caught. */
export const REACT_ERROR_CATEGORY = 'react.error-boundary';

/**
 * The entry for a render error a React error boundary caught: the message and
 * stack (with causes), the component stack and the path. Shared by AppShell's
 * boundary and {@link Logs.captureReactError}, so both read the same.
 */
export function describeReactError(error: unknown, componentStack?: string | null): { message: string; data: Record<string, unknown> } {
  const described = describeError(error);
  return {
    message: described.message,
    data: {
      stack: described.stack,
      componentStack: componentStack ? componentStack.slice(0, STACK_MAX) : undefined,
      path: typeof window === 'undefined' ? undefined : window.location?.pathname,
    },
  };
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The logger that owns auto-capture for each app id, so a second init does not double it. */
const activeLoggers = new Map<string, Logs>();

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
  private onOnline: (() => void) | null = null;
  /** In-memory only, never persisted (#392). */
  private breadcrumbs: Breadcrumb[] = [];
  /** Errors already recorded, so a caught-then-rethrown error is one event. */
  private reported = new WeakSet<object>();
  private stats = { sent: 0, dropped: 0, duplicates: 0 };
  /** A non-unload send is in flight: the next one waits for it. */
  private sending = false;
  private retryAttempt = 0;
  private retryStartedAt = 0;
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

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
    // A second init for the same app (StrictMode, HMR, a re-created instance)
    // takes over auto-capture rather than registering every handler twice.
    const previous = activeLoggers.get(this.appId);
    if (previous && previous !== this) {
      previous.flush();
      previous.stop();
    }
    activeLoggers.set(this.appId, this);
    this.running = true;
    this.clientId = readOrCreateClientId();

    this.onError = (event: ErrorEvent) => {
      if (this.alreadyReported(event.error)) return;
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
      if (this.alreadyReported(event.reason)) return;
      const described = describeError(event.reason);
      this.capture('error', 'unhandledrejection', described.message, {
        stack: described.stack,
      });
    };
    window.addEventListener('unhandledrejection', this.onRejection);

    this.onPageHide = () => this.flush();
    window.addEventListener('pagehide', this.onPageHide);

    // Offline, `send` holds the queue; back online, deliver it now.
    this.onOnline = () => {
      this.retryAt = 0;
      void this.send(false);
    };
    window.addEventListener('online', this.onOnline);

    this.timer = setInterval(() => {
      void this.send(false);
    }, FLUSH_INTERVAL_MS);
  }

  /** Stop capture and timers. Does not flush — call `flush()` first if needed. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (activeLoggers.get(this.appId) === this) activeLoggers.delete(this.appId);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (hasBrowser()) {
      if (this.onError) window.removeEventListener('error', this.onError);
      if (this.onRejection) window.removeEventListener('unhandledrejection', this.onRejection);
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
      if (this.onOnline) window.removeEventListener('online', this.onOnline);
    }
    this.onError = null;
    this.onRejection = null;
    this.onPageHide = null;
    this.onOnline = null;
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

  /**
   * Record one fixed-shape auth diagnostic. This deliberately accepts neither a
   * URL nor an Error/payload: auth state is security-sensitive and must never
   * accidentally serialize query strings, headers, credentials, or app data.
   */
  captureAuthEvent(event: AuthTelemetryEvent): void {
    if (
      !AUTH_CATEGORIES.has(event.category)
      || !AUTH_REASONS.has(event.reason)
      || !AUTH_PHASES.has(event.phase)
      || !AUTH_ROUTES.has(event.route)
      || !CORRELATION_ID_RE.test(event.correlationId)
      || !Number.isInteger(event.elapsedMs)
      || event.elapsedMs < 0
      || event.elapsedMs > 10 * 60 * 1000
      || (event.status !== undefined && (!Number.isInteger(event.status) || event.status < 100 || event.status > 599))
    ) return;

    const data = {
      reason: event.reason,
      phase: event.phase,
      route: event.route,
      correlationId: event.correlationId,
      priorAuthenticated: event.priorAuthenticated,
      ...(event.status === undefined ? {} : { status: event.status }),
      elapsedMs: event.elapsedMs,
      online: event.online,
      visibility: event.visibility,
    };
    const message = event.category === 'auth.session_lost'
      ? 'PAS session was invalidated'
      : 'PAS session hydration could not establish validity';
    this.capture('warn', event.category, message, data, { traceId: event.correlationId });
  }

  /** Number of entries waiting to be sent. Exposed for tests and diagnostics. */
  get pending(): number {
    return this.queue.length;
  }

  /** Delivery health: queued, sent and dropped entries, breadcrumbs, backpressure. */
  health(): LogHealth {
    return {
      queued: this.queue.length,
      sent: this.stats.sent,
      dropped: this.stats.dropped,
      duplicates: this.stats.duplicates,
      breadcrumbs: this.breadcrumbs.length,
      disabled: this.disabled,
      quietUntil: this.quietUntil > Date.now() ? this.quietUntil : null,
    };
  }

  /**
   * Record a breadcrumb (#392): a short, redacted note of what happened before a
   * failure. Kept in a bounded in-memory buffer (the newest 50) and attached to
   * the next error entries; never persisted and never sent on its own. Only the
   * listed categories are kept, and `data` keeps up to eight primitive values —
   * do not pass form text, DOM content, tokens or user data.
   */
  addBreadcrumb(category: BreadcrumbCategory, message: string, data?: BreadcrumbData): void {
    try {
      if (!BREADCRUMB_CATEGORIES.has(category)) return;
      const crumb: Breadcrumb = { ts: Date.now(), category, message: redactClient(String(message)).slice(0, BREADCRUMB_MESSAGE_MAX) };
      if (isPlainObject(data)) {
        const clean: BreadcrumbData = {};
        for (const key of Object.keys(data).slice(0, BREADCRUMB_DATA_KEYS)) {
          const value = data[key];
          if (typeof value === 'string') clean[key] = redactClient(value).slice(0, BREADCRUMB_VALUE_MAX);
          else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' || value === null) clean[key] = value;
        }
        if (Object.keys(clean).length) crumb.data = clean;
      }
      this.breadcrumbs.push(crumb);
      if (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.splice(0, this.breadcrumbs.length - MAX_BREADCRUMBS);
    } catch {
      // Never let capture throw into app code.
    }
  }

  /** Forget every breadcrumb. The SDK calls this when the signed-in user changes. */
  clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }

  /**
   * Queue one entry.
   *
   * Public so app code can record its own categories (`app.logs.capture('warn',
   * 'checkout', ...)`), and so SDK primitives can report their own failures
   * (platform#106's client half) without another queue. `context` (#390) joins
   * the entry to a request: pass the trace and span ids the call was sent with.
   */
  capture(level: LogLevel, category: string, message: string, data?: unknown, context?: CaptureContext): void {
    if (this.disabled || this.capturing) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    this.capturing = true;
    try {
      const redactedMessage = redactClient(String(message)).slice(0, MESSAGE_MAX);
      // An error loop repeats one fault: fold it into the queued entry. Not for
      // request-correlated entries — each failed call keeps its own trace — and an
      // entry with its own correlation id (a session loss's, #353) folds only into
      // one with the same id, so a second id still reaches the server (#429).
      if (!context?.spanId) {
        const correlation = typeof context?.traceId === 'string' ? context.traceId.toLowerCase() : null;
        const twin = this.queue.slice(-DEDUPE_WINDOW).find((e) =>
          !e.spanId && (correlation === null || e.traceId === correlation)
          && e.level === level && e.category === category && e.message === redactedMessage);
        if (twin && (twin.data === undefined || isPlainObject(twin.data))) {
          const prior = isPlainObject(twin.data) && typeof twin.data.repeats === 'number' ? twin.data.repeats : 1;
          twin.data = { ...(twin.data as Record<string, unknown> | undefined), repeats: prior + 1 };
          this.stats.duplicates++;
          return;
        }
      }
      let payload = data === undefined ? undefined : this.safeData(data);
      if (level === 'error') payload = this.withBreadcrumbs(payload);
      const entry: QueuedEntry = {
        ts: Date.now(),
        level,
        category,
        message: redactedMessage,
        data: payload,
        build: this.options.build,
        traceId: typeof context?.traceId === 'string' && CORRELATION_ID_RE.test(context.traceId) && !/^0+$/.test(context.traceId)
          ? context.traceId.toLowerCase()
          : this.newTraceId(),
        v: LOG_ENVELOPE_VERSION,
        sdkVersion: SDK_VERSION,
        ...envelopeFields(context),
      };
      this.queue.push(entry);
      this.trimQueue();
      if (this.queue.length >= MAX_BATCH) void this.send(false);
    } catch {
      // Never let capture throw into app code.
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Record a thrown value as an `error` entry: its name, message and stack
   * (redacted like every entry), plus the request context when there is one.
   * Category defaults to `exception`.
   */
  captureException(error: unknown, context?: CaptureContext & { category?: string }): void {
    try {
      if (this.alreadyReported(error)) return;
      this.markReported(error);
      const described = describeError(error);
      const { category, ...rest } = context ?? {};
      this.capture('error', category ?? 'exception', described.message, described.stack ? { stack: described.stack } : undefined, { result: 'error', ...rest });
    } catch {
      // Never let capture throw into app code.
    }
  }

  /**
   * Record a render error your own React error boundary caught (#392). React
   * does not pass a caught error to `window.onerror`, so call this from
   * `componentDidCatch(error, info)`: `app.logs.captureReactError(error,
   * info.componentStack)`. Same entry as AppShell's boundary (category
   * `react.error-boundary`, stack with causes, component stack, path).
   */
  captureReactError(error: unknown, componentStack?: string | null): void {
    try {
      if (this.alreadyReported(error)) return;
      this.markReported(error);
      const { message, data } = describeReactError(error, componentStack);
      this.capture('error', REACT_ERROR_CATEGORY, message, data, { result: 'error' });
    } catch {
      // Never let capture throw into app code.
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

  private alreadyReported(error: unknown): boolean {
    return error !== null && typeof error === 'object' && this.reported.has(error);
  }

  private markReported(error: unknown): void {
    if (error !== null && typeof error === 'object') this.reported.add(error);
  }

  /** The newest breadcrumbs that fit the ingest size budget, on an object payload only. */
  private withBreadcrumbs(payload: unknown): unknown {
    if (this.breadcrumbs.length === 0 || (payload !== undefined && !isPlainObject(payload))) return payload;
    const recent = this.breadcrumbs.slice(-ATTACHED_BREADCRUMBS);
    while (recent.length) {
      const candidate = { ...(payload as Record<string, unknown> | undefined), breadcrumbs: recent };
      if (JSON.stringify(candidate).length <= DATA_BUDGET) return candidate;
      recent.shift();
    }
    return payload;
  }

  /** Drop the OLDEST on overflow: during a loop the newest entries are all the
   *  same fault, while the first entries include what preceded it. */
  private trimQueue(): void {
    if (this.queue.length <= MAX_QUEUE) return;
    const excess = this.queue.length - MAX_QUEUE;
    this.queue.splice(0, excess);
    this.stats.dropped += excess;
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
    // Offline: keep the queue; the `online` listener resumes.
    if (isOffline()) return;
    // The unload path goes regardless: it is the last chance.
    if (!keepalive && (this.sending || Date.now() < this.retryAt)) return;

    const batch = this.queue.slice(0, MAX_BATCH);
    this.queue = this.queue.slice(batch.length);

    const body = JSON.stringify({
      entries: batch,
      ...(this.clientId ? { clientId: this.clientId } : {}),
    });

    if (!keepalive) this.sending = true;
    try {
      const result = await sendTelemetry(this.auth, this.apiBase, `/v1/apps/${this.appId}/logs`, body, {
        keepalive,
        // A beacon cannot carry the bearer token, so only use it where the
        // same-origin cookie speaks for us. In legacy-bearer mode a keepalive
        // fetch still attaches the token and still survives unload in practice.
        beacon: this.auth.usesPlatformCookie === true,
      });
      this.settle(batch, result, keepalive);
    } finally {
      if (!keepalive) this.sending = false;
    }
  }

  private settle(batch: QueuedEntry[], result: TelemetryResult, keepalive: boolean): void {
    if (result.kind === 'beacon') {
      this.stats.sent += batch.length;
      return;
    }
    if (result.kind === 'failed' || result.response.status >= 500) {
      this.retryLater(batch, keepalive);
      return;
    }
    const { status } = result.response;
    if (status === 404) {
      // Unknown app id — a misconfigured `appId` will never succeed, so stop
      // rather than retry every ten seconds for the life of the page.
      this.disabled = true;
      this.stats.dropped += batch.length + this.queue.length;
      this.queue = [];
      return;
    }
    if (status === 202 || status === 429) {
      // Over budget. Go quiet; the server is still counting the spike, and the
      // batch was not stored.
      this.quietUntil = Date.now() + COOLDOWN_MS;
      this.stats.dropped += batch.length;
      return;
    }
    this.resetRetry();
    if (result.response.ok) this.stats.sent += batch.length;
    else this.stats.dropped += batch.length; // a 4xx will not succeed on retry
  }

  /**
   * A transient failure: put the batch back and retry with backoff, a bounded
   * number of times within {@link RETRY_TTL_MS}. Offline is a pause, not a
   * failed attempt. One timer at most, so a failing endpoint cannot cause a
   * retry storm, and the transport never logs, so it cannot recurse.
   */
  private retryLater(batch: QueuedEntry[], keepalive: boolean): void {
    if (!keepalive && !isOffline()) {
      const now = Date.now();
      if (this.retryAttempt === 0) this.retryStartedAt = now;
      if (this.retryAttempt >= RETRY_DELAYS_MS.length || now - this.retryStartedAt > RETRY_TTL_MS) {
        this.stats.dropped += batch.length;
        this.resetRetry();
        return;
      }
      const delay = RETRY_DELAYS_MS[this.retryAttempt++]!;
      this.retryAt = now + delay;
      if (this.running && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.send(false);
        }, delay);
      }
    }
    this.queue = batch.concat(this.queue);
    this.trimQueue();
  }

  private resetRetry(): void {
    this.retryAttempt = 0;
    this.retryStartedAt = 0;
    this.retryAt = 0;
  }
}
