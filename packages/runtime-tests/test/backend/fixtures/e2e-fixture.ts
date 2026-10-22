import { SELF, env as providedEnv } from 'cloudflare:test';
import type { Env } from '../../../../backend/src/types';
import { BASE, seedApp, seedUser } from '../helpers';

/**
 * #396: the dedicated, synthetic identities of the diagnostics conformance suite.
 * Two fixture apps with different synthetic owners — never a real app, user or
 * student — so every scenario also proves app B cannot see app A.
 */
export const env = providedEnv as unknown as Env;
export const E2E_APP_ID = 'diag-e2e';
export const E2E_OTHER_APP_ID = 'diag-e2e-other';
export const E2E_USER = 'gh:diag-synthetic';
export const E2E_OTHER_USER = 'gh:diag-synthetic-2';

const FIXTURE_APPS = [E2E_APP_ID, E2E_OTHER_APP_ID];
const PER_APP_TABLES = ['app_logs', 'app_log_usage', 'app_metric_buckets', 'app_alerts', 'app_incidents', 'app_reliability_objectives', 'release_sourcemap_manifests', 'app_webhooks', 'app_tools'];

/** Both fixture apps and their synthetic owners exist. */
export async function seedFixtureApp(): Promise<void> {
  await seedUser(E2E_USER); await seedApp(E2E_APP_ID, E2E_USER);
  await seedUser(E2E_OTHER_USER); await seedApp(E2E_OTHER_APP_ID, E2E_OTHER_USER);
}

/** Remove everything the suite wrote for the fixture apps (and only for them). */
export async function cleanFixtureApp(): Promise<void> {
  for (const t of PER_APP_TABLES) {
    for (const app of FIXTURE_APPS) await env.DB.prepare(`DELETE FROM ${t} WHERE app_id = ?`).bind(app).run();
  }
  await env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id LIKE 'diag-%'").run();
  await env.DB.prepare("DELETE FROM telemetry_health WHERE app_id IN (?, ?)").bind(...FIXTURE_APPS).run();
  for (const app of FIXTURE_APPS) {
    const listed = await env.STORAGE.list({ prefix: `_sourcemaps/${app}/` });
    await Promise.all(listed.objects.map((o) => env.STORAGE.delete(o.key)));
  }
}

// #438: the client_error counter admits one add per (app, client) per minute and that limiter outlives a
// test, so by default every call is a client of its own, like separate browsers.
let clientSeq = 0;

/** POST log entries to the public ingest route, as a direct (non-mediated) client would. */
export function ingestLog(appId: string, entries: object[], clientId = `client-${Date.now()}-${clientSeq++}-xxxx`): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/apps/${appId}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries, clientId }),
  });
}

/** Counter sums per signal for one app (the #391 aggregates). */
export async function counters(appId: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare('SELECT signal, SUM(n) AS n FROM app_metric_buckets WHERE app_id = ? GROUP BY signal').bind(appId).all<{ signal: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.signal, r.n]));
}

export async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 50 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}

/** A GitHub Actions OIDC token for the fixture app's own repository, signed by a test key. */
export async function oidcToken(priv: CryptoKey, sha: string, repository = `proappstore-online/${E2E_APP_ID}`): Promise<string> {
  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson({ iss: 'https://token.actions.githubusercontent.com', aud: 'https://api.proappstore.online', sub: `repo:${repository}:ref:refs/heads/main`, repository, repository_owner: 'proappstore-online', ref: 'refs/heads/main', sha, iat: now, nbf: now, exp: now + 300 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
