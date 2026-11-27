import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { beforeEach, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

const env = providedEnv as unknown as Env;
beforeEach(async () => {
  mockNetwork();
  for (const table of ['project_commits', 'project_contribution_sync', 'project_repositories']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await resetTables();
  await seedUser('gh:1'); await seedUser('gh:2');
  await seedApp('mine', 'gh:1'); await seedApp('hidden', 'gh:2');
});

it('serves only the first-party caller’s verified evidence and removes credit after a rewrite on real D1', async () => {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO project_repositories(app_id,github_repo_id,full_name,source,status,verified_at,created_at,updated_at) VALUES ('mine',101,'org/mine','convention','verified',?1,?1,?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO project_contribution_sync(app_id,github_repo_id,policy_version,state,backfill_complete,last_attempt_at,last_success_at,updated_at) VALUES ('mine',101,1,'complete',1,?1,?1,?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO project_commits(github_repo_id,sha,app_id,author_github_id,author_kind,authored_at,parent_count,counted,additions,deletions,files_counted,policy_version,ingested_at) VALUES (101,'sha','mine',1,'user',?1,1,1,5,2,1,1,?1)").bind(now).run();
  const token = await mintSession({ uid: 'gh:1', roles: ['admin'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  const read = () => SELF.fetch(`${BASE}/v1/me/developer-reputation?user_id=gh:2`, json('GET', undefined, token));
  const res = await read();
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  const body = await res.json() as { apps: { app_id: string; counts: { commits: number } }[]; badges: { id: string }[] };
  expect(body.apps.map((a) => a.app_id)).toEqual(['mine']);
  expect(body.apps[0]!.counts.commits).toBe(1);
  expect(body.badges.map((b) => b.id)).toEqual(['code-contributor']);
  await env.DB.prepare("UPDATE project_commits SET reachable=0 WHERE app_id='mine'").run();
  expect(await (await read()).json()).toMatchObject({ badges: [], apps: [{ state: 'empty', counts: { commits: 0 } }] });
});

it('refuses anonymous, legacy, and app-origin credentials before returning any profile', async () => {
  expect((await SELF.fetch(`${BASE}/v1/me/developer-reputation`)).status).toBe(401);
  for (const cred of [undefined, credentialContext('app_origin_session', 'mine')]) {
    const token = await mintSession({ uid: 'gh:1', roles: ['user'], ...(cred ? { cred } : {}) }, env.SESSION_SIGNING_KEY);
    expect((await SELF.fetch(`${BASE}/v1/me/developer-reputation`, json('GET', undefined, token))).status).toBe(403);
  }
});
