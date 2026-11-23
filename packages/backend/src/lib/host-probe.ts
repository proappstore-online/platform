/**
 * Concurrent-burst probe of live app roots (#656, #653).
 *
 * The 1101s of #616 needed overlapping requests in one host isolate; every
 * monitor sent one request at a time and stayed green. So on each five-minute
 * cron tick (a Worker cron, which Cloudflare runs on time, unlike a GitHub
 * `schedule:`) this sends BURST concurrent GETs to the root of `run` and of a
 * rotating sample of apps from the public catalogue. Any 5xx or failed fetch is
 * a failure.
 *
 * The result is the `host_probe` row of telemetry_health (platform-wide), read
 * publicly at GET /health/host-probe. When the probe starts failing after a
 * healthy spell, it dispatches host-probe-alert.yml (GITHUB_TOKEN, actions:write),
 * which opens or comments on one `host-probe` issue. That workflow also runs on
 * an hourly schedule as a backstop.
 */

import type { Env } from '../types.js';
import { recordHealth } from './metric-aggregates.js';
import { dispatchPlatformWorkflow } from './session-key-drift.js';

const CATALOGUE_URL = 'https://proappstore.online/catalogue.json';
export const BURST = 8;
export const SAMPLE = 3;
/** Always probed: the app the #616 outage was first seen on. */
export const ALWAYS = 'run';
const TICK_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
/** A failure within this long of the previous one is the same episode: no new dispatch. */
export const REALERT_MS = 60 * 60_000;
const ALERT_WORKFLOW = 'host-probe-alert.yml';

interface CatalogueApp { id: string; appUrl: string }

/** `run` plus SAMPLE other apps, rotating through the catalogue one window per tick. */
export function pickTargets(apps: CatalogueApp[], now: number): CatalogueApp[] {
  const always = apps.find((a) => a.id === ALWAYS) ?? { id: ALWAYS, appUrl: `https://${ALWAYS}.proappstore.online` };
  const rest = apps.filter((a) => a.id !== ALWAYS);
  const start = rest.length ? (Math.floor(now / TICK_MS) * SAMPLE) % rest.length : 0;
  const sample = Array.from({ length: Math.min(SAMPLE, rest.length) }, (_, i) => rest[(start + i) % rest.length]!);
  return [always, ...sample];
}

/** BURST concurrent GETs of one root; how many were a 5xx or failed outright. */
async function burst(fetchImpl: typeof fetch, url: string): Promise<number> {
  const results = await Promise.all(Array.from({ length: BURST }, async () => {
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'proappstore-api host-probe' } });
      await res.body?.cancel();
      return res.status >= 500;
    } catch {
      return true;
    }
  }));
  return results.filter(Boolean).length;
}

export interface HostProbeResult { ok: boolean; error: string | null; dispatched: boolean }

export async function runHostProbe(opts: { env: Env; now: number; fetchImpl?: typeof fetch }): Promise<HostProbeResult> {
  const { env, now } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const failed: string[] = [];

  let apps: CatalogueApp[] = [];
  try {
    const res = await fetchImpl(CATALOGUE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { apps?: unknown };
    apps = (Array.isArray(data.apps) ? data.apps : []).filter(
      (a): a is CatalogueApp => !!a && typeof a.id === 'string' && typeof a.appUrl === 'string' && a.appUrl.startsWith('https://'),
    );
  } catch {
    failed.push('catalogue');
  }

  // One app at a time, so each burst overlaps as much as the Worker's open-connection limit allows.
  for (const app of pickTargets(apps, now)) {
    const n = await burst(fetchImpl, new URL('/', app.appUrl).href);
    if (n) failed.push(`${app.id}=${n}/${BURST}`);
  }

  const ok = failed.length === 0;
  // A short code naming public app ids only: `5xx:run=4/8,meet=1/8`.
  const error = ok ? null : `5xx:${failed.join(',')}`.slice(0, 200);
  const prev = await env.DB.prepare("SELECT last_failure_at FROM telemetry_health WHERE component = 'host_probe' AND app_id = ''")
    .first<{ last_failure_at: number | null }>()
    .catch(() => null);
  await recordHealth(env.DB, 'host_probe', '', ok, error, now);
  console.log(JSON.stringify({ kind: 'host-probe', ok, error }));

  let dispatched = false;
  const newEpisode = !prev?.last_failure_at || now - prev.last_failure_at >= REALERT_MS;
  if (!ok && newEpisode && env.GITHUB_TOKEN) {
    dispatched = await dispatchPlatformWorkflow(fetchImpl, env.GITHUB_TOKEN, ALERT_WORKFLOW, {});
    if (!dispatched) console.error('[host-probe] could not dispatch host-probe-alert.yml (GITHUB_TOKEN needs actions:write on proappstore-online/platform)');
  }
  return { ok, error, dispatched };
}

/** The public view of the latest probe, for GET /health/host-probe and host-probe-alert.yml. */
export async function hostProbeStatus(db: D1Database) {
  const row = await db.prepare("SELECT last_ok_at, last_failure_at, last_error, updated_at FROM telemetry_health WHERE component = 'host_probe' AND app_id = ''")
    .first<{ last_ok_at: number | null; last_failure_at: number | null; last_error: string | null; updated_at: number }>();
  if (!row) return { ok: null, lastOkAt: null, lastFailureAt: null, lastError: null, updatedAt: null };
  const ok = row.last_failure_at === null || (row.last_ok_at ?? 0) > row.last_failure_at;
  return { ok, lastOkAt: row.last_ok_at, lastFailureAt: row.last_failure_at, lastError: row.last_error, updatedAt: row.updated_at };
}
