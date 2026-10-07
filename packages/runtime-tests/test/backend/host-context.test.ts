import { SELF, env as providedEnv } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session, viaHostApi } from './helpers';

const env = providedEnv as unknown as Env;

// #315 (#303 C1): X-PAS-App and X-PAS-Host are the host's word. api.proappstore.online
// routes straight to this worker, so a direct caller — SELF here, the default export —
// sends them past the host. The default export strips them; only the host's binding
// to the HostApi entrypoint keeps them. Each consumer is checked both ways: the forged
// direct request, and the same headers as the host sends them.

const RP = 'demo.proappstore.online';
const forged = { 'X-PAS-App': 'demo', 'X-PAS-Host': RP };
type Send = (url: string, init: RequestInit) => Promise<Response>;
const direct: Send = (url, init) => SELF.fetch(url, init);

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['passkey_credentials', 'passkey_challenges']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedApp('demo', 'gh:1');
});

describe('host context headers reach routes only through HostApi (#315)', () => {
  it('passkeys: forged X-PAS-App + X-PAS-Host on a direct call select no relying party', async () => {
    const token = await mintSession({ uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github' } as never, env.SESSION_SIGNING_KEY);
    const options = (send: Send) => send(`${BASE}/v1/auth/passkey/register/options`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...forged }, body: '{}',
    });
    const forgedRes = await options(direct);
    expect(forgedRes.status, await forgedRes.clone().text()).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey_challenges').first<{ n: number }>()).toEqual({ n: 0 });

    const mediated = await options(viaHostApi);
    expect(mediated.status, await mediated.clone().text()).toBe(200);
    expect((await mediated.json<{ rp: { id: string } }>()).rp.id).toBe(RP);
  });

  it("secrets proxy: a forged X-PAS-App on a direct call is no app origin, so no app's secrets are spent", async () => {
    const send = async (via: Send) => via(`${BASE}/v1/apps/demo/proxy/api.example.com/v1/x`, {
      method: 'GET', headers: { Authorization: `Bearer ${await session('gh:1')}`, 'X-PAS-App': 'demo' },
    });
    const forgedRes = await send(direct);
    expect(forgedRes.status).toBe(403);
    expect(await forgedRes.text()).toContain("only callable from the app's own origin");

    const mediated = await (await send(viaHostApi)).text();
    expect(mediated).not.toContain("only callable from the app's own origin");
    expect(mediated).not.toContain('app context mismatch');
  });

  it('app-worker browser route: a forged X-PAS-App on a direct call is not the app origin', async () => {
    const send = async (via: Send) => via(`${BASE}/v1/apps/demo/worker/http`, {
      method: 'POST', headers: { Authorization: `Bearer ${await session('gh:1')}`, 'X-PAS-App': 'demo', 'X-PAS-Worker-Method': 'GET', 'X-PAS-Worker-Path': '/' },
    });
    const forgedRes = await send(direct);
    expect(forgedRes.status).toBe(403);
    expect(await forgedRes.text()).toContain('reached through the app origin');

    expect(await (await send(viaHostApi)).text()).not.toContain('reached through the app origin');
  });

  it("logs: a forged X-PAS-App on a direct call is stored as 'direct', not 'mediated'", async () => {
    const send = (via: Send, message: string) => via(`${BASE}/v1/apps/demo/logs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PAS-App': 'demo' }, body: JSON.stringify({ entries: [{ level: 'info', message }] }),
    });
    expect((await send(direct, 'forged')).status).toBe(200);
    expect((await send(viaHostApi, 'mediated')).status).toBe(200);
    const rows = await env.DB.prepare("SELECT message, source FROM app_logs WHERE app_id = 'demo' AND source IN ('direct', 'mediated') ORDER BY id").all();
    expect(rows.results).toEqual([{ message: 'forged', source: 'direct' }, { message: 'mediated', source: 'mediated' }]);
  });

  it('a forged X-PAS-App on a direct call is no app-page context either: the console Bearer path is unchanged', async () => {
    // The operator view refuses app-mediated requests (#300). A direct Bearer call is the console's, forged header or not.
    const res = await direct(`${BASE}/v1/apps/demo/operator`, { headers: { Authorization: `Bearer ${await session('gh:1')}`, 'X-PAS-App': 'demo' } });
    expect(await res.text()).not.toContain('not reachable from an app page');
    const mediated = await viaHostApi(`${BASE}/v1/apps/demo/operator`, { headers: { Authorization: `Bearer ${await session('gh:1')}`, 'X-PAS-App': 'demo' } });
    expect(mediated.status).toBe(403);
    expect(await mediated.text()).toContain('not reachable from an app page');
  });
});
