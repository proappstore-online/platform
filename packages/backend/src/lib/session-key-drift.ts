/**
 * Session-key drift check (#70) — the recurrence guard for #65/#66.
 *
 * Every `pas-data-<app>` worker holds its own copy of SESSION_SIGNING_KEY, pushed at
 * provision time. Rotate the backend's key and every data worker silently keeps the
 * old one, 401-ing valid sessions until someone remembers the fleet fan-out
 * (`redeploy-data-workers.yml`). Nothing recorded that dependency and nothing
 * detected the drift; #66 made it reconcilable, this makes it self-correcting.
 *
 * How: mint a probe session with the backend's CURRENT key, present it to a sample of
 * data workers on their direct host (lib/data-worker-url.ts), and read the verdict
 * off the status code. The probe subject is not a member of any app, so a worker
 * holding the current key answers **403** (signature verified, membership refused);
 * one holding a stale key answers **401** (`invalid session`). 401 is drift, full stop.
 * Anything else (5xx, timeout, network) is "unreachable" — a different problem, not
 * evidence either way.
 *
 * On drift, when a GitHub token with `actions: write` is configured, the check
 * dispatches `redeploy-data-workers.yml` for each drifted app, which re-runs
 * `/v1/provision-data` and pushes the current key. Without the token it only
 * reports — a structured `session-key-drift` log line either way. Runs from the
 * cron trigger in wrangler.toml and on demand at GET /v1/internal/session-key-drift.
 */

import { mintSession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { dataWorkerUrl } from './data-worker-url.js';

export const DRIFT_PROBE_SUBJECT = 'probe:session-key-drift';
/** Short-lived on purpose: the probe only has to survive one round trip. */
export const DRIFT_PROBE_TTL_SECONDS = 300;
export const DRIFT_SAMPLE_SIZE = 8;
export const DRIFT_PROBE_TIMEOUT_MS = 8_000;

export const REDEPLOY_WORKFLOW = { owner: 'proappstore-online', repo: 'platform', file: 'redeploy-data-workers.yml', ref: 'main' } as const;

export type DriftVerdict = 'ok' | 'drift' | 'unreachable';

export interface DriftProbe {
  appId: string;
  verdict: DriftVerdict;
  status: number | null;
  ms: number;
}

export interface DriftReport {
  ok: boolean;
  checkedAt: string;
  sampled: number;
  probes: DriftProbe[];
  drifted: string[];
  unreachable: string[];
  /** Apps for which the fleet fan-out was dispatched (needs GITHUB_TOKEN with actions:write). */
  dispatched: string[];
  /** Why nothing was dispatched, when drift was found and nothing was. */
  dispatchSkipped?: string;
}

export interface DriftOptions {
  env: Env;
  sampleSize?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function probeOne(fetchImpl: typeof fetch, env: Env, appId: string, token: string, now: () => number): Promise<DriftProbe> {
  const started = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DRIFT_PROBE_TIMEOUT_MS);
  try {
    // `/tables` is the cheapest authenticated route every data worker serves.
    const res = await fetchImpl(dataWorkerUrl(env, appId, '/tables'), {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctl.signal,
    });
    const verdict: DriftVerdict = res.status === 401 ? 'drift' : res.status >= 500 ? 'unreachable' : 'ok';
    return { appId, verdict, status: res.status, ms: now() - started };
  } catch {
    return { appId, verdict: 'unreachable', status: null, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Dispatch the fleet fan-out for one app. Returns false (never throws) when it cannot. */
async function dispatchRedeploy(fetchImpl: typeof fetch, token: string, appId: string): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${REDEPLOY_WORKFLOW.owner}/${REDEPLOY_WORKFLOW.repo}/actions/workflows/${REDEPLOY_WORKFLOW.file}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'proappstore-api session-key-drift',
        },
        body: JSON.stringify({ ref: REDEPLOY_WORKFLOW.ref, inputs: { app_id: appId } }),
      },
    );
    return res.status === 204;
  } catch {
    return false;
  }
}

export async function checkSessionKeyDrift(opts: DriftOptions): Promise<DriftReport> {
  const { env } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sampleSize = opts.sampleSize ?? DRIFT_SAMPLE_SIZE;

  const { results } = await env.DB.prepare(
    `SELECT id FROM apps WHERE d1_database_id IS NOT NULL AND d1_database_id != '' ORDER BY RANDOM() LIMIT ?`,
  ).bind(sampleSize).all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);

  const token = await mintSession({ uid: DRIFT_PROBE_SUBJECT, login: 'session-key-drift', roles: ['user'] }, env.SESSION_SIGNING_KEY, DRIFT_PROBE_TTL_SECONDS);
  const probes = await Promise.all(ids.map((id) => probeOne(fetchImpl, env, id, token, now)));
  const drifted = probes.filter((p) => p.verdict === 'drift').map((p) => p.appId);
  const unreachable = probes.filter((p) => p.verdict === 'unreachable').map((p) => p.appId);

  const dispatched: string[] = [];
  let dispatchSkipped: string | undefined;
  if (drifted.length > 0) {
    if (!env.GITHUB_TOKEN) {
      dispatchSkipped = 'GITHUB_TOKEN is not configured — run redeploy-data-workers.yml by hand';
    } else {
      for (const appId of drifted) if (await dispatchRedeploy(fetchImpl, env.GITHUB_TOKEN, appId)) dispatched.push(appId);
      if (dispatched.length < drifted.length) dispatchSkipped = 'GitHub refused one or more workflow dispatches (token needs actions:write on proappstore-online/platform)';
    }
  }

  const report: DriftReport = {
    ok: drifted.length === 0,
    checkedAt: new Date(now()).toISOString(),
    sampled: ids.length,
    probes,
    drifted,
    unreachable,
    dispatched,
    ...(dispatchSkipped ? { dispatchSkipped } : {}),
  };
  console.log(JSON.stringify({ kind: 'session-key-drift', ...report, probes: undefined }));
  return report;
}
