import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { beforeEach, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

const env = providedEnv as unknown as Env;
let owner: string, stranger: string;
const endpoint = `${BASE}/v1/apps/recruit/team/recruitment`;
const form = () => SELF.fetch(`${BASE}/v1/storefront/apps/recruit/enquiries/team-join`, {
  method: 'POST', redirect: 'manual', headers: { Origin: 'https://about-recruit.proappstore.online', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ name: 'Synthetic applicant', email: 'synthetic@example.com', message: 'Fixture only' }).toString(),
});
beforeEach(async () => {
  mockNetwork();
  for (const table of ['app_team_recruitment', 'app_enquiries', 'app_visibility']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await resetTables(); await seedUser('gh:1'); await seedUser('gh:2'); await seedApp('recruit', 'gh:1');
  await env.DB.prepare("INSERT INTO app_storefront_publication(app_id,listed,updated_at) VALUES('recruit',1,0)").run();
  owner = await mintSession({ uid: 'gh:1', roles: ['user'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  stranger = await mintSession({ uid: 'gh:2', roles: ['user'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
});

it('persists owner recruitment controls and admits native forms without duplicates or membership on real D1', async () => {
  const initial = await SELF.fetch(endpoint, json('GET', undefined, owner));
  expect(initial.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await initial.json()).toEqual({ appId: 'recruit', accepting_requests: true, updated_at: null });
  for (let i = 0; i < 2; i++) {
    const sent = await form();
    expect(sent.status).toBe(303);
    expect(sent.headers.get('Location')).toBe('https://about-recruit.proappstore.online/?team_join=sent#team-join-sent');
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_enquiries').first('n')).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM team_members').first('n')).toBe(0);
  const closed = await SELF.fetch(endpoint, json('PUT', { accepting_requests: false }, owner));
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({ accepting_requests: false });
  expect((await form()).headers.get('Location')).toContain('team_join=unavailable#team-join-unavailable');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_enquiries').first('n')).toBe(1);
});

it('refuses nonowners and app credentials and rechecks the current owner after transfer', async () => {
  expect((await SELF.fetch(endpoint, json('PUT', { accepting_requests: false }, stranger))).status).toBe(403);
  const appToken = await mintSession({ uid: 'gh:1', roles: ['user'], cred: credentialContext('app_origin_session', 'recruit') }, env.SESSION_SIGNING_KEY);
  expect((await SELF.fetch(endpoint, json('GET', undefined, appToken))).status).toBe(403);
  await env.DB.prepare("UPDATE apps SET creator_id='gh:2' WHERE id='recruit'").run();
  expect((await SELF.fetch(endpoint, json('PUT', { accepting_requests: false }, owner))).status).toBe(403);
  expect((await SELF.fetch(endpoint, json('PUT', { accepting_requests: false }, stranger))).status).toBe(200);
});

it('gives private and missing apps the same unavailable native form outcome', async () => {
  await env.DB.prepare("INSERT INTO app_visibility(app_id,mode,roles,created_at) VALUES ('recruit','private','[]',0)").run();
  const privateResponse = await form();
  await env.DB.prepare("DELETE FROM apps WHERE id='recruit'").run();
  const missingResponse = await form();
  expect(privateResponse.status).toBe(303);
  expect(missingResponse.headers.get('Location')).toBe(privateResponse.headers.get('Location'));
});

it('refuses delisted and unpublished apps despite an open recruitment setting', async () => {
  await env.DB.prepare("UPDATE app_storefront_publication SET listed=0 WHERE app_id='recruit'").run();
  expect((await form()).headers.get('Location')).toContain('team_join=unavailable');
  await env.DB.prepare("DELETE FROM app_storefront_publication WHERE app_id='recruit'").run();
  expect((await form()).headers.get('Location')).toContain('team_join=unavailable');
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_enquiries').first('n')).toBe(0);
});
