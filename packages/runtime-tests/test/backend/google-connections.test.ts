import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, resetTables, seedApp, seedUser } from './helpers';

const env = providedEnv as unknown as Env;

// #537: a person inspects and revokes one app's Google access, and separately disconnects the
// shared account, on workerd and real D1. Other apps keep working until the explicit global step.

const USER = 'gh:7';
const TABLES = ['google_calendar_grants', 'google_calendar_oauth_states', 'google_calendar_app_authorizations', 'google_calendar_accounts', 'app_connectors'];
const clear = async () => { for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run(); await resetTables(); };
const token = (cred: ReturnType<typeof credentialContext> | null = credentialContext('first_party_session'), authTime = Math.floor(Date.now() / 1000)) =>
  mintSession({ uid: USER, roles: ['user'], auth_time: authTime, auth_method: 'github', ...(cred ? { cred } : {}) }, env.SESSION_SIGNING_KEY);
async function send(path: string, body?: unknown, bearer?: string) {
  return SELF.fetch(`${BASE}/v1/connectors/google-calendar/connections${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${bearer ?? await token()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const authorized = async () => (await env.DB.prepare('SELECT app_id FROM google_calendar_app_authorizations ORDER BY app_id').all<{ app_id: string }>()).results.map(r => r.app_id);

beforeEach(async () => {
  await clear();
  await seedUser(USER, 'person');
  await env.DB.prepare("INSERT INTO google_calendar_accounts (user_id, version, status, google_subject, email, credential_ct, updated_at) VALUES (?, 1, 'connected', '123456', 'person@example.test', ?, 1)").bind(USER, new Uint8Array([1])).run();
  for (const appId of ['alpha', 'beta']) {
    await seedApp(appId, USER);
    await env.DB.prepare("INSERT INTO app_connectors (app_id, name, kind, modes, events, created_at) VALUES (?, 'calendar', 'google_calendar', '[\"oauth\"]', '[]', 1)").bind(appId).run();
    await env.DB.prepare('INSERT INTO google_calendar_app_authorizations (app_id, user_id, account_version) VALUES (?, ?, 1)').bind(appId, USER).run();
    await env.DB.prepare('INSERT INTO google_calendar_grants (id, app_id, user_id, account_version, calendar_id, calendar_name, created_at) VALUES (?, ?, ?, 1, ?, ?, 1)').bind(`grant-${appId}`, appId, USER, 'team@example.test', 'Team').run();
  }
});
afterEach(clear);

describe('Google connection management on workerd and real D1 (#537)', () => {
  it('lists the apps, revokes one without touching the other, then needs the app count to disconnect the account', async () => {
    const listed = await (await send('')).json<{ account: { version: number }; apps: { app_id: string; legacy: boolean; authorization_version: number }[] }>();
    expect(listed.account.version).toBe(1);
    expect(listed.apps.map(a => [a.app_id, a.legacy, a.authorization_version])).toEqual([['alpha', true, 1], ['beta', true, 1]]);

    expect((await send('/apps/beta/revoke', { expected_authorization_version: 2 })).status).toBe(409);
    expect(await (await send('/apps/beta/revoke', { expected_authorization_version: 1 })).json()).toEqual({ disconnected: true });
    expect(await authorized()).toEqual(['alpha']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM google_calendar_grants WHERE app_id = ?').bind('beta').first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM google_calendar_grants WHERE app_id = ?').bind('alpha').first<{ n: number }>())!.n).toBe(1);

    await env.DB.prepare('INSERT INTO google_calendar_app_authorizations (app_id, user_id, account_version) VALUES (?, ?, 1)').bind('beta', USER).run();
    for (const acknowledged_apps of [undefined, 1, 3]) {
      expect(await (await send('/disconnect', { expected_version: 1, acknowledged_apps })).json()).toEqual({ error: 'cross_app_acknowledgement_required' });
    }
    expect(await authorized()).toEqual(['alpha', 'beta']);
    expect(await (await send('/disconnect', { expected_version: 1, acknowledged_apps: 2 })).json()).toEqual({ disconnected: true });
    expect(await authorized()).toEqual([]);
    expect(await env.DB.prepare('SELECT status, credential_ct, version FROM google_calendar_accounts WHERE user_id = ?').bind(USER).first()).toEqual({ status: 'disconnected', credential_ct: null, version: 2 });
  });

  it('refuses an app-bound or unproven credential and a stale sign-in for the global step', async () => {
    for (const cred of [credentialContext('app_session', 'alpha'), credentialContext('workload_session'), null]) {
      const bearer = await token(cred);
      for (const [path, body] of [['', undefined], ['/apps/beta/revoke', { expected_authorization_version: 1 }], ['/disconnect', { expected_version: 1, acknowledged_apps: 2 }]] as const) {
        const response = await send(path, body, bearer);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'personal_sign_in_required' });
      }
    }
    const stale = await token(credentialContext('first_party_session'), Math.floor(Date.now() / 1000) - 86_400);
    expect(await (await send('/disconnect', { expected_version: 1, acknowledged_apps: 2 }, stale)).json()).toEqual({ error: 'recent_sign_in_required' });
    expect(await authorized()).toEqual(['alpha', 'beta']);
  });
});
