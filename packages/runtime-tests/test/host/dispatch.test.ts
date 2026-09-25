import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

type Echo = { worker: string; method: string; path: string; headers: Record<string, string> };

/** Reserved subdomains reach their Workers over service bindings — no fetch. */
describe('host: reserved-subdomain dispatch over service bindings', () => {
  it('routes api / admin / agents / mcp / kb / docs to the bound worker, path and query intact', async () => {
    for (const [sub, worker] of [['api', 'api-echo'], ['admin', 'admin-echo'], ['agents', 'agents-echo'], ['mcp', 'mcp-echo'], ['kb', 'kb-echo'], ['docs', 'kb-echo']] as const) {
      const res = await SELF.fetch(`https://${sub}.proappstore.online/v1/thing?x=1`, { headers: { Authorization: 'Bearer t' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Stub-Worker')).toBe(worker);
      const echo = (await res.json()) as Echo;
      expect(echo).toMatchObject({ worker, method: 'GET', path: '/v1/thing?x=1' });
      expect(echo.headers.authorization).toBe('Bearer t');
    }
  });

  it('strips a client-supplied X-PAS-App before the API sees it (#80), but not on other bindings', async () => {
    const api = (await (await SELF.fetch('https://api.proappstore.online/v1/proxy', { headers: { 'X-PAS-App': 'forged', 'X-Other': 'kept' } })).json()) as Echo;
    expect(api.worker).toBe('api-echo');
    expect(api.headers['x-pas-app']).toBeUndefined();
    expect(api.headers['x-other']).toBe('kept');
    // (/health is answered by the host itself on every hostname, so use another path.)
    const admin = (await (await SELF.fetch('https://admin.proappstore.online/api/publish-app', { headers: { 'X-PAS-App': 'kept' } })).json()) as Echo;
    expect(admin.worker).toBe('admin-echo');
    expect(admin.headers['x-pas-app']).toBe('kept');
  });

  it('www redirects to the apex; /health answers on any hostname without touching a binding', async () => {
    const www = await SELF.fetch('https://www.proappstore.online/apps?x=1', { redirect: 'manual' });
    expect(www.status).toBe(301);
    expect(www.headers.get('Location')).toBe('https://proappstore.online/apps?x=1');
    await www.text();
    const health = await SELF.fetch('https://anything.proappstore.online/health');
    expect(await health.json()).toEqual({ ok: true, worker: 'proappstore-host', version: '1.0.0' });
  });

  it('data-<app> is proxied by fetch to the workers.dev host from DATA_WORKER_HOST (#153); console/dashboard go to Pages', async () => {
    const data = (await (await SELF.fetch('https://data-demo.proappstore.online/tables?x=1', { headers: { Authorization: 'Bearer t' } })).json()) as Echo & { host: string };
    expect(data).toMatchObject({ worker: 'outbound-echo', host: `pas-data-demo.${env.DATA_WORKER_HOST}`, path: '/tables?x=1' });
    expect(data.headers.authorization).toBe('Bearer t');
    const console_ = (await (await SELF.fetch('https://console.proappstore.online/apps/x?y=1')).json()) as Echo & { host: string };
    expect(console_).toMatchObject({ worker: 'outbound-echo', host: 'proappstore-console.pages.dev', path: '/apps/x?y=1' });
  });
});
