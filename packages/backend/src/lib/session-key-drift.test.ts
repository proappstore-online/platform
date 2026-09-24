import { describe, expect, it, vi } from 'vitest';
import { verifySession } from '@proappstore/build-core';
import { TEST_SK, mockStmt, makeEnv } from '../test-helpers.js';
import { checkSessionKeyDrift, DRIFT_PROBE_SUBJECT, REDEPLOY_WORKFLOW } from './session-key-drift.js';

// #70: a data worker holding a rotated-away SESSION_SIGNING_KEY answers 401 to a
// session the backend just minted. The check must call that drift, and only that.

function dbWithApps(ids: string[]) {
  const prepare = vi.fn(() => mockStmt({ all: { results: ids.map((id) => ({ id })) } }));
  return { prepare } as never;
}

function fetchStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const status = (code: number) => new Response(code === 401 ? '{"error":"invalid session"}' : '{}', { status: code });
const env = (over: Record<string, unknown> = {}) => makeEnv({ INTERNAL_TOKEN: 'internal-secret', ...over }, dbWithApps(['alpha', 'beta', 'gamma']) as never);

describe('checkSessionKeyDrift', () => {
  it('probes each sampled data worker on its direct host with a fresh session signed by the CURRENT key', async () => {
    const { impl, calls } = fetchStub(() => status(403));
    const report = await checkSessionKeyDrift({ env: env(), fetchImpl: impl });
    expect(report.ok).toBe(true);
    expect(report.sampled).toBe(3);
    expect(calls.map((c) => c.url)).toEqual([
      'https://pas-data-alpha.serge-the-dev.workers.dev/tables',
      'https://pas-data-beta.serge-the-dev.workers.dev/tables',
      'https://pas-data-gamma.serge-the-dev.workers.dev/tables',
    ]);
    const bearer = String((calls[0]!.init!.headers as Record<string, string>).Authorization).replace(/^Bearer /, '');
    const claims = await verifySession(bearer, TEST_SK);
    expect(claims?.uid).toBe(DRIFT_PROBE_SUBJECT);
    expect(claims?.roles).toEqual(['user']);
    // Short-lived: one round trip, not a 30-day token lying around.
    expect(claims!.exp - claims!.iat).toBeLessThanOrEqual(300);
  });

  it('reads 403 (not a member) and 200 as "key ok", 401 as drift, 5xx/throw as unreachable', async () => {
    const { impl } = fetchStub((url) => {
      if (url.includes('alpha')) return status(403);
      if (url.includes('beta')) return status(401);
      throw new Error('connect timeout');
    });
    const report = await checkSessionKeyDrift({ env: env(), fetchImpl: impl });
    expect(report.ok).toBe(false);
    expect(report.probes.map((p) => [p.appId, p.verdict])).toEqual([['alpha', 'ok'], ['beta', 'drift'], ['gamma', 'unreachable']]);
    expect(report.drifted).toEqual(['beta']);
    expect(report.unreachable).toEqual(['gamma']);
  });

  it('dispatches redeploy-data-workers.yml for each drifted app when a GitHub token is configured', async () => {
    const { impl, calls } = fetchStub((url) => {
      if (url.includes('api.github.com')) return new Response(null, { status: 204 });
      return status(url.includes('gamma') ? 403 : 401);
    });
    const report = await checkSessionKeyDrift({ env: env({ GITHUB_TOKEN: 'ghp_x' }), fetchImpl: impl });
    expect(report.drifted).toEqual(['alpha', 'beta']);
    expect(report.dispatched).toEqual(['alpha', 'beta']);
    expect(report.dispatchSkipped).toBeUndefined();
    const dispatches = calls.filter((c) => c.url.includes('api.github.com'));
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]!.url).toBe(
      `https://api.github.com/repos/${REDEPLOY_WORKFLOW.owner}/${REDEPLOY_WORKFLOW.repo}/actions/workflows/${REDEPLOY_WORKFLOW.file}/dispatches`,
    );
    expect(JSON.parse(String(dispatches[0]!.init!.body))).toEqual({ ref: 'main', inputs: { app_id: 'alpha' } });
    expect((dispatches[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer ghp_x');
  });

  it('reports drift but skips the dispatch, saying why, without a token or when GitHub refuses', async () => {
    const drift = fetchStub(() => status(401));
    const noToken = await checkSessionKeyDrift({ env: env({ GITHUB_TOKEN: undefined }), fetchImpl: drift.impl });
    expect(noToken.ok).toBe(false);
    expect(noToken.dispatched).toEqual([]);
    expect(noToken.dispatchSkipped).toContain('GITHUB_TOKEN');
    expect(drift.calls.some((c) => c.url.includes('api.github.com'))).toBe(false);

    const refused = fetchStub((url) => (url.includes('api.github.com') ? new Response('forbidden', { status: 403 }) : status(401)));
    const report = await checkSessionKeyDrift({ env: env({ GITHUB_TOKEN: 'ghp_x' }), fetchImpl: refused.impl });
    expect(report.dispatched).toEqual([]);
    expect(report.dispatchSkipped).toContain('actions:write');
  });

  it('never dispatches for an unreachable worker — that is not key drift', async () => {
    const { impl, calls } = fetchStub(() => {
      throw new Error('down');
    });
    const report = await checkSessionKeyDrift({ env: env({ GITHUB_TOKEN: 'ghp_x' }), fetchImpl: impl });
    expect(report.ok).toBe(true);
    expect(report.unreachable).toEqual(['alpha', 'beta', 'gamma']);
    expect(calls.some((c) => c.url.includes('api.github.com'))).toBe(false);
  });

  it('samples only apps that have a data plane', async () => {
    const prepare = vi.fn(() => mockStmt({ all: { results: [] } }));
    const e = makeEnv({}, { prepare } as never);
    const { impl } = fetchStub(() => status(403));
    const report = await checkSessionKeyDrift({ env: e, fetchImpl: impl, sampleSize: 5 });
    expect(report.sampled).toBe(0);
    expect(report.ok).toBe(true);
    const sql = String((prepare.mock.calls[0] as unknown[])[0]);
    expect(sql).toMatch(/FROM apps WHERE d1_database_id IS NOT NULL/);
    expect(sql).toMatch(/LIMIT \?/);
  });
});
