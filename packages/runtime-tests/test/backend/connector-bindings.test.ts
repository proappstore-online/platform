import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { boundInstallations } from '../../../backend/src/routes/connectors';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #378 on real D1: a GitHub App installation bound to an app routes deliveries
// only while that app exists, and deleting an app removes its connectors and
// their installation bindings.

const INSTALLATION = 42;

async function bind(appId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO app_connectors (app_id, name, kind, modes, events, hook, created_at) VALUES (?, 'gh', 'github', '[\"app\"]', '[\"push\"]', 'github', ?)").bind(appId, now).run();
  await env.DB.prepare("INSERT INTO app_hooks (app_id, name, verify_kind, target, created_at) VALUES (?, 'github', 'github-app', 'worker', ?)").bind(appId, now).run();
  await env.DB.prepare("INSERT INTO app_connector_installations (app_id, connector, installation_id, account_login, account_type, created_by, created_at) VALUES (?, 'gh', ?, 'acme', 'Organization', 'gh:1', ?)").bind(appId, INSTALLATION, now).run();
}
const routed = async () => ((await boundInstallations(env.DB, INSTALLATION)).results ?? []).map((r) => r.app_id).sort();
const rows = async (table: string, appId: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`).bind(appId).first<{ n: number }>())!.n;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_connectors', 'app_connector_installations', 'app_hooks']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1');
  await seedApp('live', 'gh:1');
  await seedApp('gone', 'gh:1');
  await bind('live');
  await bind('gone');
});

describe('connector bindings and deleted apps (#378)', () => {
  it('a binding left behind by a deleted app routes nothing', async () => {
    expect(await routed()).toEqual(['gone', 'live']);
    await env.DB.prepare("DELETE FROM apps WHERE id = 'gone'").run(); // as a delete before this fix left it
    expect(await routed()).toEqual(['live']);
  });

  it('deleting an app removes its connectors and installation bindings, and only its own', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/gone`, json('DELETE', undefined, await session('gh:1')));
    expect(res.status).toBe(200);
    expect(await rows('app_connectors', 'gone')).toBe(0);
    expect(await rows('app_connector_installations', 'gone')).toBe(0);
    expect(await rows('app_connector_installations', 'live')).toBe(1);
    expect(await routed()).toEqual(['live']);
  });
});
