/**
 * Server-side error telemetry → Analytics Engine (ADR-008 §1/§2).
 *
 * `app.onError` previously only `console.error`d, which makes a 5xx greppable
 * but not *countable*. One AE data point per server error makes error rate a
 * queryable metric — which is what the console renders and what spike detection
 * evaluates (ADR-008 §6: console-only, no external delivery).
 *
 * Field names follow OpenTelemetry exception conventions (`exception.type`,
 * `exception.message`, `exception.stacktrace`, `service.name`, `trace_id`) so a
 * later Logpush/OTel export is a mapping rather than a migration. Adopting the
 * conventions is deliberately not adopting the OTel stack — no SDK, no
 * collector, no exporter.
 *
 * AE constraints that shape the layout: exactly one index (≤96 bytes), ≤20 blobs
 * totalling ~5 KB, ≤20 doubles. The index is what queries filter and sample on,
 * so it holds the app id — or `platform` for control-plane errors that belong to
 * no app.
 *
 * **No user identity is written here.** AE rows cannot be deleted per-user, so
 * per ADR-008 this tier carries no PII; affected-user counts come from the D1
 * tier instead.
 */

/** Blob layout. AE queries address blobs positionally (`blob1`…`blobN`), so this
 *  order is the schema — append only, never reorder or a query silently reads
 *  the wrong column. Mirrors the drift documented in telemetry-datasets.ts. */
export const ERROR_BLOB_COLUMNS = [
  'service.name',
  'exception.type',
  'exception.message',
  'fingerprint',
  'http.route',
  'http.method',
  'exception.stacktrace',
  'trace_id',
  'cf_ray',
] as const;

const MESSAGE_MAX = 512;
const STACK_MAX = 1024;
const ROUTE_MAX = 256;
const INDEX_MAX = 96;
const STACK_FRAMES = 3;

/** Index value for errors with no owning app (auth, provisioning, cron, …). */
export const PLATFORM_INDEX = 'platform';

export interface ServerErrorFields {
  /** Owning app, when the route has one. Falsy → indexed as `platform`. */
  appId?: string | null;
  /** Which Worker produced this — `backend`, `host`, `data-worker`, … */
  service: string;
  method: string;
  /** Hono route *pattern* (`/v1/apps/:appId/logs`), not the concrete path —
   *  patterns group, concrete paths fragment into one group per app. */
  routePath: string;
  status: number;
  errorType: string;
  message: string;
  stack?: string | null;
  traceId?: string | null;
  cfRay?: string | null;
}

/**
 * Redact secret-shaped substrings before an error message is persisted.
 *
 * Defence in depth, not the primary control: messages are constructed by our
 * own code, but a thrown error can carry an upstream response body or a
 * stringified request. ADR-008 §4 requires scrubbing at the sink because a
 * deployed caller cannot be trusted or patched on demand.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w\-._~+/]+=*/gi, 'Bearer [redacted]'],
  // Matches `password=x`, `api_key: x`, and the JSON form `"client_secret": "x"`
  // — hence the optional quote after the key name, which would otherwise sit
  // between the key and its separator and defeat the match.
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|client[_-]?secret)\b("?\s*[:=]\s*)("?)[^\s,;"}&]+\3/gi,
    '$1$2[redacted]',
  ],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, '[email]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]'],
];

export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Reduce a stack to a stable grouping basis: the top few frames with `:line:col`
 * stripped.
 *
 * Line and column numbers shift on every bundle even when the failing code is
 * untouched, so keeping them would mint a fresh error group per deploy — the
 * opposite of grouping. Frame *order and identity* is what identifies the fault.
 */
export function normalizeStack(stack: string | null | undefined, frames = STACK_FRAMES): string {
  if (!stack) return '';
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, frames)
    .map((line) => line.replace(/:\d+:\d+/g, '').replace(/\?[^\s)]*/g, ''))
    .join('|');
}

/**
 * Stable grouping key for an error: 16 hex chars of SHA-256 over
 * type + normalized stack + route.
 *
 * This is the `error_groups` join key — the unit humans and spike detection
 * reason about ("*this* error, 400 times, since the 14:02 deploy"), rather than
 * an undifferentiated error count. WebCrypto rather than a hand-rolled hash;
 * `onError` is already async so there is no reason to invent one.
 */
export async function fingerprint(
  errorType: string,
  normalizedStack: string,
  routePath: string,
): Promise<string> {
  return hash16([errorType, normalizedStack, routePath]);
}

/**
 * 16 hex chars of SHA-256 over newline-joined parts. The shared grouping-key
 * primitive — client log ingestion (lib/log-ingest.ts) fingerprints on different
 * parts but must produce the same *kind* of key, so both sides share this.
 */
export async function hash16(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\n')));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Write one error data point. Returns the fingerprint so a caller can surface it
 * as a support reference, or null if telemetry itself failed.
 *
 * Never throws and never rejects: an error in the error path must not replace the
 * response the user was about to get.
 */
export async function recordServerError(
  env: { ERRORS?: AnalyticsEngineDataset },
  fields: ServerErrorFields,
): Promise<string | null> {
  try {
    const stack = normalizeStack(fields.stack);
    const route = fields.routePath.slice(0, ROUTE_MAX);
    const fp = await fingerprint(fields.errorType, stack, route);

    // No binding (tests, local dev, a Worker without the dataset) — still hand
    // back the fingerprint so callers behave identically either way.
    const dataset = env.ERRORS;
    if (!dataset) return fp;

    dataset.writeDataPoint({
      indexes: [(fields.appId || PLATFORM_INDEX).slice(0, INDEX_MAX)],
      blobs: [
        fields.service,
        fields.errorType,
        redact(fields.message).slice(0, MESSAGE_MAX),
        fp,
        route,
        fields.method,
        redact(stack).slice(0, STACK_MAX),
        fields.traceId ?? '',
        fields.cfRay ?? '',
      ],
      doubles: [1, fields.status],
    });
    return fp;
  } catch {
    return null;
  }
}
