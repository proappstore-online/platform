// Event ingest — first-party page-view + custom-event beacons from the
// platform loader. Writes one row per event into Workers Analytics Engine.
// No PII recorded (no IP, no full UA, no full referrer URL). Extracted
// verbatim from analytics.ts.

import type { Hono } from 'hono';
import { APP_ID_RE, EVENT_KIND_RE } from './analytics-shared.js';
import type { Env } from '../types.js';

const PATH_MAX = 256;
const REFERRER_HOST_MAX = 120;
const PROPS_MAX = 8;

interface EventBody {
  app?: string;
  kind?: string;
  path?: string;
  referrer?: string;
  props?: Record<string, unknown>;
  /** Client-recorded event time (epoch ms). Lets offline-replayed events
   *  land on the day they actually happened, not the flush day. */
  t?: number;
  /** Batch wrapper: each entry is treated as a single EventBody (with `t`).
   *  Used by the loader to drain its IndexedDB outbox in one POST. */
  events?: EventBody[];
}

const MAX_BATCH = 100;
const T_WINDOW_MS = 72 * 60 * 60 * 1000; // accept replays up to 72h old

function effectiveTimestamp(t: number | undefined, nowMs: number): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return nowMs;
  if (t > nowMs + 5 * 60 * 1000) return nowMs;
  if (t < nowMs - T_WINDOW_MS) return nowMs;
  return t;
}

function classifyUA(ua: string | null): 'bot' | 'mobile' | 'desktop' {
  if (!ua) return 'desktop';
  if (/bot|crawler|spider|curl|wget|python|node/i.test(ua)) return 'bot';
  if (/iphone|android|mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function safeReferrerHost(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.hostname.slice(0, REFERRER_HOST_MAX);
  } catch {
    return '';
  }
}

function flattenProps(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const entries = Object.entries(props).slice(0, PROPS_MAX);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length > 32) continue;
    out[k] = String(v).slice(0, 64);
  }
  return JSON.stringify(out);
}

// Per-(app, IP, kind) sampling cap (in-isolate, ~50 events/10s).
const SAMPLE_BUCKET_SECONDS = 10;
const SAMPLE_MAX_PER_BUCKET = 50;
const sampleBuckets = new Map<string, { windowStart: number; count: number }>();

function shouldAccept(key: string, now: number): boolean {
  const windowStart = Math.floor(now / 1000 / SAMPLE_BUCKET_SECONDS) * SAMPLE_BUCKET_SECONDS;
  const cur = sampleBuckets.get(key);
  if (!cur || cur.windowStart !== windowStart) {
    sampleBuckets.set(key, { windowStart, count: 1 });
    if (sampleBuckets.size > 1024) sampleBuckets.clear();
    return true;
  }
  cur.count += 1;
  return cur.count <= SAMPLE_MAX_PER_BUCKET;
}

export function registerEventIngestRoute(routes: Hono<{ Bindings: Env }>) {
  routes.post('/analytics/event', async (c) => {
    let body: EventBody;
    try {
      body = await c.req.json();
    } catch {
      return c.text('invalid json', 400);
    }

    const ua = c.req.header('user-agent') ?? null;
    const uaClass = classifyUA(ua);
    if (uaClass === 'bot') return new Response(null, { status: 204 });

    const ip = c.req.header('cf-connecting-ip') ?? '';
    const country =
      (c.req.raw as Request & { cf?: { country?: string } }).cf?.country?.slice(0, 2) ?? '';
    const dataset = (c.env as Env & { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;

    // Body can be a single event or { events: [...] } — the loader drains its
    // IndexedDB outbox by POSTing the batched form when it reconnects.
    const items: EventBody[] = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [body];
    const nowMs = Date.now();
    let accepted = 0;
    for (const item of items) {
      const appId = (item.app ?? '').trim();
      if (!APP_ID_RE.test(appId)) continue;
      const kind = (item.kind ?? 'pageview').trim().toLowerCase();
      if (!EVENT_KIND_RE.test(kind)) continue;
      if (!shouldAccept(`${appId}:${ip}:${kind}`, nowMs)) continue;
      if (!dataset) {
        accepted++;
        continue;
      }
      const path = (item.path ?? '/').slice(0, PATH_MAX);
      const referrerHost = safeReferrerHost(item.referrer);
      const t = effectiveTimestamp(item.t, nowMs);
      dataset.writeDataPoint({
        indexes: [appId],
        blobs: [appId, kind, path, referrerHost, country, uaClass, flattenProps(item.props)],
        doubles: [1, t],
      });
      accepted++;
    }
    return new Response(null, { status: 204, headers: { 'x-events-accepted': String(accepted) } });
  });
}
