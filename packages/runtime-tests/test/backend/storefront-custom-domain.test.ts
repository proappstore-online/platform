import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, resetTables, seedApp, seedUser } from './helpers';

// #602 on real D1: GET /v1/storefront/apps/:id names the app's own address, so the storefront
// launches and shows a custom domain instead of the <id>.proappstore.online subdomain.

const env = providedEnv as unknown as Env;
const APP = 'domain-demo';

async function domain(name: string, opts: { status?: string; kind?: string; canonical?: 0 | 1; addedAt?: number } = {}): Promise<void> {
  const { status = 'active', kind = 'exact', canonical = 0, addedAt = 1 } = opts;
  await env.DB.prepare('INSERT INTO app_custom_domains (app_id, domain, status, kind, canonical, added_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(APP, name, status, kind, canonical, addedAt).run();
}
const customDomain = async () => ((await (await SELF.fetch(`${BASE}/v1/storefront/apps/${APP}`)).json()) as { customDomain: string | null }).customDomain;

beforeEach(async () => {
  await resetTables();
  for (const t of ['app_custom_domains', 'app_visibility']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
});

describe('storefront listing carries the custom domain (#602)', () => {
  it('is null for an app with no domain, or only pending and failed ones', async () => {
    expect(await customDomain()).toBeNull();
    await domain('pending.example', { status: 'pending' });
    await domain('failed.example', { status: 'failed' });
    expect(await customDomain()).toBeNull();
  });

  it('names an active wildcard base domain', async () => {
    await domain('clubs.example', { kind: 'wildcard' });
    expect(await customDomain()).toBe('clubs.example');
  });

  it('prefers the canonical host, then the earliest active domain', async () => {
    await domain('second.example', { addedAt: 2 });
    await domain('first.example', { addedAt: 1 });
    expect(await customDomain()).toBe('first.example');
    await domain('canonical.example', { canonical: 1, addedAt: 3 });
    expect(await customDomain()).toBe('canonical.example');
  });

  it('still answers 404 for a private app', async () => {
    await domain('clubs.example');
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, created_at) VALUES (?, 'private', 1)").bind(APP).run();
    expect((await SELF.fetch(`${BASE}/v1/storefront/apps/${APP}`)).status).toBe(404);
  });
});
