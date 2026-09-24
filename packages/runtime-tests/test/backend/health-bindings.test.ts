import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, mockNetwork, resetTables } from './helpers';

beforeEach(async () => { mockNetwork(); await resetTables(); });

describe('backend in workerd: request/response and service bindings', () => {
  it('serves /health through the real fetch handler', async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers 404 JSON for an unknown route and CORS preflight for a first-party origin', async () => {
    const missing = await SELF.fetch(`${BASE}/v1/nope`);
    expect(missing.status).toBe(404);
    const preflight = await SELF.fetch(`${BASE}/v1/auth/me`, { method: 'OPTIONS', headers: { Origin: 'https://dashboard.proappstore.online', 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://dashboard.proappstore.online');
  });

  it('the SELF service binding reaches this worker (the drift-cron re-entry path)', async () => {
    const res = await env.SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('the QA_WORKER service binding is wired to a worker that accepts a run nudge', async () => {
    const res = await env.QA_WORKER.fetch('https://qa/qa/runs', { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: true });
  });

  it('R2 and the Durable Object namespace are real bindings', async () => {
    await env.STORAGE.put('runtime/probe.txt', 'hello');
    expect(await (await env.STORAGE.get('runtime/probe.txt'))!.text()).toBe('hello');
    expect(typeof env.ROOM.idFromName('probe').toString()).toBe('string');
  });
});
