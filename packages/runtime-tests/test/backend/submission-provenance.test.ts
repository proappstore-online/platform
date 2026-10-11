import { SELF, env as testEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedUser, session } from './helpers';

const env = testEnv as unknown as Env;

// #366 on real D1, through the real routes: the template provenance a submission
// carries (#178 catalogue id + exact source commit) is what approval provisions
// and records on the app row; a submission with none records NULL, never the
// default template. Only Cloudflare's D1-create call is intercepted, so
// provisionData reaches its record_app step; the data-worker deploy that follows
// fails offline, which is beside the point here.

const DEV = 'gh:dev';
const ADMIN = 'gh:admin'; // ADMIN_GITHUB_IDS in vitest.backend.ts
const REV = '4b000c9967dbd7981e4d45cbfdfffba680beb8e7';

const submit = async (appId: string, extra: Record<string, unknown> = {}) =>
  SELF.fetch(`${BASE}/v1/submissions`, json('POST', { appId, name: 'App', category: 'productivity', description: 'desc', ...extra }, await session(DEV)));
async function approve(appId: string) {
  const row = await env.DB.prepare("SELECT id FROM submissions WHERE app_id = ? AND status = 'pending'").bind(appId).first<{ id: string }>();
  fetchMock.get('https://api.cloudflare.com').intercept({ path: `/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database`, method: 'POST' })
    .reply(200, { success: true, result: { uuid: `d1-${appId}` } });
  const res = await SELF.fetch(`${BASE}/v1/submissions/${row!.id}/approve`, json('POST', {}, await session(ADMIN, { roles: ['user', 'creator', 'admin'] })));
  // Offline, provisioning stops at the data-worker deploy (after record_app), so the
  // approval reports the failure and releases the submission for a retry (#383).
  expect(res.status).toBe(500);
  return res.json() as Promise<{ provisionResult: { steps?: { name: string; status: string; detail: string }[] } }>;
}
const provenance = (appId: string) =>
  env.DB.prepare('SELECT template_id, template_rev FROM apps WHERE id = ?').bind(appId).first<{ template_id: string | null; template_rev: string | null }>();

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM submissions').run();
  await env.DB.prepare('DELETE FROM provision_attempts').run();
  await seedUser(DEV);
  await seedUser(ADMIN);
});

describe('submission → approval → provision keeps template provenance (#366)', () => {
  it('a non-default approved template and its pinned revision are recorded exactly', async () => {
    const res = await submit('market-one', { template: 'template-marketplace', templateRev: REV, repoUrl: 'https://github.com/proappstore-online/market-one' });
    expect(res.status).toBe(201);
    expect((await res.json<{ submission: Record<string, unknown> }>()).submission).toMatchObject({
      template_id: 'template-marketplace', template_rev: REV, repo_url: 'https://github.com/proappstore-online/market-one',
    });
    const approved = await approve('market-one');
    expect(approved.provisionResult.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'record_app', status: 'ok', detail: expect.stringContaining(`template: template-marketplace@${REV}`) }),
    ]));
    expect(await provenance('market-one')).toEqual({ template_id: 'template-marketplace', template_rev: REV });
  });

  it('the default template, named explicitly, is recorded as itself', async () => {
    expect((await submit('plain-one', { template: 'template-app', templateRev: 'd8c2e08' })).status).toBe(201);
    await approve('plain-one');
    expect(await provenance('plain-one')).toEqual({ template_id: 'template-app', template_rev: 'd8c2e08' });
  });

  it('a submission without provenance (today\'s console, or a legacy row) records NULL, not template-app', async () => {
    expect((await submit('unknown-one')).status).toBe(201);
    const approved = await approve('unknown-one');
    expect(approved.provisionResult.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'template', detail: expect.stringContaining('provenance unknown') }),
    ]));
    expect(await provenance('unknown-one')).toEqual({ template_id: null, template_rev: null });

    // A row written before migration 0091 looks exactly like this.
    await env.DB.prepare(
      "INSERT INTO submissions (id, app_id, creator_id, status, name, category, description, repo_url, created_at) VALUES ('legacy-sub', 'legacy-one', ?, 'pending', 'L', 'c', 'd', 'https://example.com/someone/else', ?)",
    ).bind(DEV, Date.now()).run();
    await approve('legacy-one');
    expect(await provenance('legacy-one')).toEqual({ template_id: null, template_rev: null });
  });

  it('refuses malformed, unknown and mismatched provenance, and any repository but the pinned one', async () => {
    for (const [extra, message] of [
      [{ template: 'template-nope' }, /unknown template "template-nope"/],
      [{ template: '' }, /template must be a catalogue id/],
      [{ template: 'template-app', templateRev: 'not-hex' }, /templateRev must be a git object id/],
      [{ templateRev: REV }, /templateRev requires template/],
      [{ repoUrl: 'https://github.com/attacker/private-thing' }, /repoUrl must be https:\/\/github.com\/proappstore-online\/bad-one/],
      [{ repoUrl: 'https://github.com/proappstore-online/someone-elses-app' }, /repoUrl must be/],
    ] as [Record<string, unknown>, RegExp][]) {
      const res = await submit('bad-one', extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(await res.text()).toMatch(message);
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE app_id = 'bad-one'").first<{ n: number }>())!.n).toBe(0);
  });

  it('templateUnknown on /v1/provision is admin-only and exclusive with a template', async () => {
    const asDev = await SELF.fetch(`${BASE}/v1/provision`, json('POST', { appId: 'direct-one', templateUnknown: true }, await session(DEV)));
    expect(asDev.status).toBe(403);
    const both = await SELF.fetch(`${BASE}/v1/provision`, json('POST', { appId: 'direct-two', templateUnknown: true, template: 'template-app' }, await session(ADMIN, { roles: ['user', 'admin'] })));
    expect(both.status).toBe(400);
    expect(await both.text()).toMatch(/cannot be combined/);
  });
});
