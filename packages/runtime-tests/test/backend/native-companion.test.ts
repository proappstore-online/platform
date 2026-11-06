import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { beforeEach, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

const env = providedEnv as unknown as Env;
const deviceToken = `ndev_${'a'.repeat(64)}`;
const deviceId = 'device-fixture';
const call = (path: string, method = 'GET', body?: unknown, token = deviceToken) => SELF.fetch(`${BASE}/v1${path}`, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(async () => {
  mockNetwork();
  await env.DB.prepare('DELETE FROM native_devices').run();
  await env.DB.prepare('DELETE FROM native_pairings').run();
  await resetTables(); await seedUser('gh:1'); await seedUser('gh:2'); await seedApp('ski', 'gh:1');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceToken));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(deviceId, 'gh:1', 'Test Android', hash, Date.now(), Date.now() + 60_000).run();
});

it('D1 enforces native grant isolation, idempotent delivery and cascading revocation', async () => {
  const catalog = await (await call('/native/me')).json<{ apps: { version: string }[] }>();
  const enabled = await call('/native/apps/ski/location', 'PUT', { enabled: true, version: catalog.apps[0].version });
  expect(enabled.status).toBe(200);
  const { grant } = await enabled.json<{ grant: { id: string; consent_at: number } }>();
  const payload = { points: [{ id: 'sample', at: grant.consent_at, lat: 1, lng: 2, accuracy: 5, grants: [grant.id] }] };
  for (let i = 0; i < 2; i++) {
    const response = await call('/native/locations', 'POST', payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acknowledged: ['sample'] });
  }
  const ownToken = await mintSession({ uid: 'gh:1', roles: ['user'], cred: credentialContext('app_bound', 'ski') }, env.SESSION_SIGNING_KEY);
  const otherToken = await mintSession({ uid: 'gh:2', roles: ['user'], cred: credentialContext('app_bound', 'ski') }, env.SESSION_SIGNING_KEY);
  expect((await (await call('/apps/ski/native/locations', 'GET', undefined, ownToken)).json<{ points: unknown[] }>()).points).toHaveLength(1);
  expect((await (await call('/apps/ski/native/locations', 'GET', undefined, otherToken)).json<{ points: unknown[] }>()).points).toHaveLength(0);
  expect((await call('/native/apps/ski/location', 'DELETE')).status).toBe(200);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM native_locations').first('n')).toBe(0);
  await call('/native/locations', 'POST', payload);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM native_locations').first('n')).toBe(0);
});
