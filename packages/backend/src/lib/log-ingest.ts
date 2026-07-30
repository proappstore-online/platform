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
}

export interface NormalizedEntry {
  ts: number;
  level: Level;
  category: string;
  message: string;
  data: string | null;
  buildMeta: string | null;
  traceId: string | null;
  fingerprint: string;
}

/** A client-supplied install id, or null if absent/malformed. Untrusted — it is
 *  a grouping label, never an authorization input. */
export function normalizeClientId(value: unknown): string | null {
  return typeof value === 'string' && CLIENT_ID_RE.test(value) ? value : null;
}

/**
 * W3C traceparent → trace-id, or null.
 *
 * Format: `00-<32 hex trace-id>-<16 hex span-id>-<flags>`. We keep only the
 * trace-id, which is the part that correlates this row with the backend and
 * data-worker lines for the same logical request.
 */
export function traceIdFromTraceparent(header: string | null | undefined): string | null {
  if (!header) return null;
  const parts = header.trim().split('-');
  if (parts.length < 4) return null;
  const traceId = parts[1];
  if (!/^[0-9a-f]{32}$/i.test(traceId) || /^0+$/.test(traceId)) return null;
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
      buildMeta = redact(JSON.stringify(raw.build) ?? '').slice(0, MAX_ENTRY_SIZE) || null;
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
    traceId: traceIdFromTraceparent(typeof raw.traceId === 'string' ? raw.traceId : null),
    fingerprint: await fingerprintEntry(level, category, rawMessage),
  };
}

/** Normalize a whole batch, dropping unusable entries and capping the count. */
export async function normalizeBatch(
  entries: RawLogEntry[],
  nowMs: number,
): Promise<NormalizedEntry[]> {
  const capped = entries.slice(0, MAX_BATCH_SIZE);
  const normalized = await Promise.all(capped.map((e) => normalizeEntry(e, nowMs)));
  return normalized.filter((e): e is NormalizedEntry => e !== null);
}
