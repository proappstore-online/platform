/**
 * App log ingestion — validation, scrubbing, and grouping (ADR-008 §3/§4).
 *
 * Pure functions only, so the rules are testable without D1 or a Worker. The
 * route (routes/logs.ts) owns auth, quota, and persistence.
 *
 * Everything here treats the entry as hostile input. Not because app authors are
 * adversarial, but because these entries are assembled by *deployed* app code we
 * cannot patch on demand: a well-meaning app that stringifies a failed request
 * into a log message will ship us a bearer token. Scrubbing at the sink is the
 * only layer we still control after an app ships.
 */

import { hash16, redact } from './error-telemetry.js';

export const MAX_BATCH_SIZE = 100;
export const MAX_ENTRY_SIZE = 4096;
/** Whole-request cap, checked before parsing. 100 entries × 4 KB + envelope. */
export const MAX_BODY_BYTES = 512 * 1024;
/** Per-app entries per UTC day. Generous for real use, ruinous for a loop. */
export const DAILY_ENTRY_LIMIT = 50_000;
/**
 * Per-isolate burst ceiling, per (app, client). Cheap first line of defence.
 *
 * MUST stay >= MAX_BATCH_SIZE, or a single legal full batch is throttled on
 * arrival and no app can ever flush one — which is exactly what happened at 50.
 * At 200 a client may flush two full batches per second before it is capped.
 */
export const BURST_ENTRIES_PER_SECOND = 200;

/** Accepted levels. Anything else is dropped rather than stored verbatim, so a
 *  caller cannot invent levels that the console's filters can never show. */
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

/** Levels that also get counted as metrics in Analytics Engine. Info/debug are
 *  narrative, not signal — counting them would drown the error rate. */
export const METRIC_LEVELS: readonly string[] = ['warn', 'error'];

const CATEGORY_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Accept timestamps within a day either side of now; clamp anything else. A
 *  forged far-future `ts` would otherwise sort above every real row forever. */
const TS_SKEW_MS = 24 * 60 * 60 * 1000;

export interface RawLogEntry {
  ts?: unknown;
  level?: unknown;
  category?: unknown;
  message?: unknown;
  data?: unknown;
  build?: unknown;
  traceId?: unknown;
  // #390 versioned diagnostic envelope (SDK 1.16.81+). Absent on older SDKs.
  v?: unknown;
  sdkVersion?: unknown;
  operation?: unknown;
  spanId?: unknown;
  result?: unknown;
  errorCode?: unknown;
  durationMs?: unknown;
}

/**
 * The stored request context of a row (`app_logs.context`, #390): only these
 * fields, each validated, so a URL, body, credential or child data cannot be
 * smuggled in through it. Client rows carry the SDK's span; server rows the
 * server's span and the client span as parent.
 */
export interface LogContext {
  v: 1;
  sdkVersion?: string;
  operation?: string;
  spanId?: string;
  parentSpanId?: string;
  result?: 'ok' | 'error';
  errorCode?: string;
  durationMs?: number;
}

export interface NormalizedEntry {
  ts: number;
  level: Level;
  category: string;
  message: string;
  data: string | null;
  buildMeta: string | null;
  traceId: string | null;
  /** JSON {@link LogContext}, or null for an entry without the envelope. */
  context: string | null;
  fingerprint: string;
}

/** A client-supplied install id, or null if absent/malformed. Untrusted — it is
 *  a grouping label, never an authorization input. */
export function normalizeClientId(value: unknown): string | null {
  return typeof value === 'string' && CLIENT_ID_RE.test(value) ? value : null;
}

/**
 * A version-00 W3C traceparent (`00-<32 hex trace-id>-<16 hex span-id>-<2 hex
 * flags>`), or null when malformed or carrying an all-zero id. Untrusted input:
 * correlation only, never an authorization input. Vendored in the SDK
 * (sdk/src/trace.ts) and the host (platform-mediation.ts).
 */
export function parseTraceparent(header: string | null | undefined): { traceId: string; spanId: string } | null {
  if (typeof header !== 'string') return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header.trim().toLowerCase());
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!, spanId: m[2]! };
}

/** W3C traceparent → trace-id, or null. The trace-id correlates this row with the
 *  client and data-worker lines for the same logical request. */
export function traceIdFromTraceparent(header: string | null | undefined): string | null {
  return parseTraceparent(header)?.traceId ?? null;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Response header naming an error's trace id (also `traceId` in its JSON body). */
export const TRACE_ID_HEADER = 'X-PAS-Trace-Id';

/** A fresh 32-hex trace id, for a request that arrived without a valid traceparent. */
function newTraceId(): string {
  return randomHex(16);
}

/** A fresh 16-hex span id: the server's own span for a request. */
function newSpanId(): string {
  return randomHex(8);
}

export interface RequestTrace {
  traceId: string;
  /** This server's span for the request. */
  spanId: string;
  /** The caller's span, from a valid traceparent; null when the trace was minted here. */
  parentSpanId: string | null;
}

const requestTraces = new WeakMap<Request, RequestTrace>();

/**
 * #394: one trace and one server span per request, however many places ask —
 * the data-worker hop an action forwards and the error handler's row must name
 * the same span, or the hop cannot be followed.
 */
export function requestTrace(request: Request): RequestTrace {
  let trace = requestTraces.get(request);
  if (!trace) {
    const incoming = parseTraceparent(request.headers.get('traceparent'));
    trace = { traceId: incoming?.traceId ?? newTraceId(), spanId: newSpanId(), parentSpanId: incoming?.spanId ?? null };
    requestTraces.set(request, trace);
  }
  return trace;
}

/** The traceparent this server sends on a downstream hop: its own span as the parent. */
export function downstreamTraceparent(trace: RequestTrace): string {
  return `00-${trace.traceId}-${trace.spanId}-00`;
}

const CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SPAN_RE = /^[0-9a-f]{16}$/i;
const SDK_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,24})?$/;
const MAX_DURATION_MS = 60 * 60 * 1000;

/** The allowlisted {@link LogContext} of a client entry; null when it has none of it. */
function normalizeContext(raw: RawLogEntry): LogContext | null {
  if (raw.v !== 1) return null;
  const ctx: LogContext = { v: 1 };
  if (typeof raw.sdkVersion === 'string' && SDK_VERSION_RE.test(raw.sdkVersion)) ctx.sdkVersion = raw.sdkVersion;
  if (typeof raw.operation === 'string' && CODE_RE.test(raw.operation)) ctx.operation = raw.operation;
  if (typeof raw.spanId === 'string' && SPAN_RE.test(raw.spanId) && !/^0+$/.test(raw.spanId)) ctx.spanId = raw.spanId.toLowerCase();
  if (raw.result === 'ok' || raw.result === 'error') ctx.result = raw.result;
  if (typeof raw.errorCode === 'string' && CODE_RE.test(raw.errorCode)) ctx.errorCode = raw.errorCode;
  if (typeof raw.durationMs === 'number' && Number.isInteger(raw.durationMs) && raw.durationMs >= 0 && raw.durationMs <= MAX_DURATION_MS) ctx.durationMs = raw.durationMs;
  return ctx;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict',
  410: 'gone', 413: 'payload_too_large', 415: 'unsupported_media_type', 422: 'unprocessable', 428: 'precondition_required', 429: 'rate_limited',
};

/**
 * A safe machine code for an error response (#390): the thrown message only when
 * it is already a snake_case code (`step_up_required`), else one derived from the
 * status. Never free text, so it cannot carry ids, paths or internal detail.
 */
export function safeErrorCode(status: number, message: string | null): string {
  if (status < 500 && message && /^[a-z][a-z0-9_]{2,63}$/.test(message)) return message;
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : `http_${status}`);
}

/**
 * Trace ids on a log entry may be a W3C traceparent or the SDK's anonymous
 * 32-hex correlation id. Request headers remain traceparent-only above: an
 * entry is application telemetry, not an HTTP propagation header.
 */
function traceIdFromEntry(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9a-f]{32}$/i.test(trimmed) && !/^0+$/.test(trimmed)) return trimmed.toLowerCase();

  // Entry traceparents are legacy application payloads, not request headers.
  // Keep their accepted W3C v00 shape exact so a URL/query fragment or other
  // arbitrary string cannot turn into a searchable correlation id.
  const legacy = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(trimmed);
  if (!legacy) return null;
  const traceId = legacy[1]!;
  const spanId = legacy[2]!;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return traceId.toLowerCase();
}

/**
 * Mask the variable parts of a message so occurrences of one fault collapse to
 * one group: ids, numbers, and quoted values become placeholders.
 *
 * Without this, "failed for user 123" and "failed for user 456" are two issues
 * and every alert threshold is meaningless.
 */
export function messageShape(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[A-Fa-f0-9]{16,}\b/g, '<hex>')
    .replace(/"[^"]*"/g, '"<s>"')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Grouping key for a client log entry. Mirrors the server-side fingerprint in
 *  error-telemetry.ts — same kind of key, different basis. */
export function fingerprintEntry(level: string, category: string, message: string): Promise<string> {
  return hash16([level, category, messageShape(message)]);
}

/**
 * Validate, scrub, and normalize one entry. Returns null when the entry is
 * unusable.
 *
 * Dropping silently (rather than 400-ing the batch) is deliberate: one malformed
 * entry must not cost an app the other 99, and the SDK cannot retry usefully.
 * The response reports the accepted count so a caller can still notice.
 */
export async function normalizeEntry(
  raw: RawLogEntry,
  nowMs: number,
): Promise<NormalizedEntry | null> {
  if (!raw || typeof raw !== 'object') return null;

  const level = String(raw.level ?? '').toLowerCase();
  if (!(LEVELS as readonly string[]).includes(level)) return null;

  const rawMessage = typeof raw.message === 'string' ? raw.message : '';
  if (!rawMessage.trim()) return null;

  const tsRaw = Number(raw.ts);
  const ts =
    Number.isFinite(tsRaw) && Math.abs(tsRaw - nowMs) <= TS_SKEW_MS ? Math.trunc(tsRaw) : nowMs;

  const categoryRaw = typeof raw.category === 'string' ? raw.category : 'app';
  const category = CATEGORY_RE.test(categoryRaw) ? categoryRaw : 'app';

  const message = redact(rawMessage).slice(0, MAX_ENTRY_SIZE);

  let data: string | null = null;
  if (raw.data !== undefined && raw.data !== null) {
    try {
      data = redact(JSON.stringify(raw.data) ?? '').slice(0, MAX_ENTRY_SIZE) || null;
    } catch {
      // Unserializable (cycles, BigInt) — drop the payload, keep the message.
      data = null;
    }
  }

  let buildMeta: string | null = null;
  if (raw.build && typeof raw.build === 'object') {
    try {
      buildMeta = normalizeBuildMeta(raw.build as Record<string, unknown>);
    } catch {
      buildMeta = null;
    }
  }

  return {
    ts,
    level: level as Level,
    category,
    message,
    data,
    buildMeta,
    traceId: traceIdFromEntry(typeof raw.traceId === 'string' ? raw.traceId : null),
    context: (() => { const ctx = normalizeContext(raw); return ctx ? JSON.stringify(ctx) : null; })(),
    fingerprint: await fingerprintEntry(level, category, rawMessage),
  };
}

/** Normalize a whole batch, dropping unusable entries and capping the count. */
/**
 * Build metadata, redacted like everything else — except a `sha` that is a pure
 * git commit id (7–40 hex). The redactor masks any 32+ hex run as a possible
 * token, which turned a full 40-hex commit SHA into `[hex]`; #393 resolves a
 * crash's source maps by that exact `build.sha`, so it must survive ingest
 * (found by the #396 conformance suite). A commit id is not a secret.
 */
function normalizeBuildMeta(build: Record<string, unknown>): string | null {
  const { sha, ...rest } = build;
  const commit = typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
  const redacted = redact(JSON.stringify(commit ? rest : build) ?? '');
  if (!commit) return redacted.slice(0, MAX_ENTRY_SIZE) || null;
  let others: Record<string, unknown> = {};
  try { others = JSON.parse(redacted) as Record<string, unknown>; } catch { /* keep the commit alone */ }
  return JSON.stringify({ ...others, sha: commit }).slice(0, MAX_ENTRY_SIZE);
}

export async function normalizeBatch(
  entries: RawLogEntry[],
  nowMs: number,
): Promise<NormalizedEntry[]> {
  const capped = entries.slice(0, MAX_BATCH_SIZE);
  const normalized = await Promise.all(capped.map((e) => normalizeEntry(e, nowMs)));
  return normalized.filter((e): e is NormalizedEntry => e !== null);
}
