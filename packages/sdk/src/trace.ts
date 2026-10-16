/**
 * W3C trace context for SDK platform calls (#390).
 *
 * One {@link RequestContext} per call: its trace id travels in the request's
 * `traceparent` and on the client log entry for the same operation, so an owner
 * can line up the SDK's view of a failure with the server's (`trace_id` in
 * `GET /v1/apps/:appId/logs`). The client's span id is the request's parent span;
 * the server records its own span, so the two are told apart.
 *
 * Correlation only. These ids are random, carry no identity, and nothing on the
 * platform authorizes on them.
 */

export interface RequestContext {
  /** 32 lowercase hex, never all zeros. */
  traceId: string;
  /** 16 lowercase hex, never all zeros: this client call's span. */
  spanId: string;
  /** What the call was, e.g. `action.save_lead`. Never a URL, params or a body. */
  operation: string;
  /** Epoch ms when the call started, for `durationMs`. */
  startedAt: number;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  try {
    crypto.getRandomValues(out);
  } catch {
    // Correlation-only, never security material.
    for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
  // An all-zero id is invalid in W3C trace context; one in 2^64 is still worth a retry.
  return /^0+$/.test(hex) ? randomHex(bytes) : hex;
}

export function generateTraceId(): string {
  return randomHex(16);
}

export function generateSpanId(): string {
  return randomHex(8);
}

export function makeTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** A version-00 `traceparent`, or null when malformed or carrying an all-zero id. */
export function parseTraceparent(header: string | null | undefined): { traceId: string; spanId: string; flags: string } | null {
  if (typeof header !== 'string') return null;
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, traceId, spanId, flags] = m as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, flags };
}

/**
 * Whether a request may carry `traceparent`: only the platform's own endpoints —
 * same-origin `/.pas/` mediation, the PAS API, and this app's data worker. A
 * third-party URL never receives it.
 */
export function isAllowedTracePropagationTarget(url: string | URL, apiBase: string, dataOrigin: string): boolean {
  const raw = url.toString();
  if (raw.startsWith('/.pas/')) return true;
  try {
    const origin = new URL(raw).origin;
    return origin === new URL(apiBase).origin || origin === new URL(dataOrigin).origin;
  } catch {
    return false;
  }
}

export function createRequestContext(operation: string): RequestContext {
  return { traceId: generateTraceId(), spanId: generateSpanId(), operation, startedAt: Date.now() };
}

/**
 * Request context for one entry (#390): the fields of the versioned diagnostic
 * envelope an app or SDK primitive may set. Each is validated and anything
 * malformed is dropped, so a URL, body or credential can never ride along.
 */
export interface CaptureContext {
  /** 32 hex: the trace id sent in the operation's `traceparent`. Default: a fresh one per entry. */
  traceId?: string;
  /** 16 hex: the client span of that request. */
  spanId?: string;
  /** What failed, e.g. `action.save_lead`. Letters, digits and `._:-`, up to 64. */
  operation?: string;
  result?: 'ok' | 'error';
  /** A machine code such as the server's `errorCode`, never a free-text message. Same charset as `operation`. */
  errorCode?: string;
  durationMs?: number;
}

/**
 * Why a call never got a response (#392): `cancelled` (expected — the caller
 * aborted), `timeout`, or `network` (the browser could not reach the API, so no
 * server ever logs it). Null for anything else, e.g. signed out before sending.
 */
export function classifyTransportError(error: unknown, signal: AbortSignal | null | undefined): 'cancelled' | 'timeout' | 'network' | null {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') {
    return (signal?.reason as { name?: unknown } | undefined)?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  }
  if (error instanceof TypeError) return 'network';
  return null;
}

/**
 * A platform call's operation for diagnostics (#392): `platform.db` for the data
 * plane, `platform.<family>` for `/v1/apps/<id>/<family>/…`, else `platform` —
 * a bounded label, never the path, ids or query of the request.
 */
export function platformOperation(url: string): string {
  if (url.startsWith('/.pas/data') || /^https?:\/\/data-[a-z0-9-]+\./.test(url)) return 'platform.db';
  const family = /\/v1\/apps\/[^/?#]+\/([a-z][a-z-]{0,31})(?:[/?#]|$)/.exec(url)?.[1];
  return family ? `platform.${family}` : 'platform';
}

/** What `Auth` reports when a platform call it made never got a response (#392). */
export interface TransportFailure {
  kind: 'cancelled' | 'timeout' | 'network';
  operation: string;
  durationMs: number;
  error: unknown;
}
