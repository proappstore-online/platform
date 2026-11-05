import { beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import { seedReferralReady } from '../promoter-test-helpers.js';
import type { Env } from '../types.js';

vi.mock('../lib/github-oidc.js', () => ({ verifyGithubOidc: async (token: string) => {
  if (token === 'invalid') throw new Error('invalid signature');
  return { repository: token === 'other' ? 'proappstore-online/other' : 'proappstore-online/shop',
    ref: token === 'branch' ? 'refs/heads/feature' : 'refs/heads/main', sha: token === 'old-sha' ? 'old' : 'current' };
} }));

let db: ReturnType<typeof sqliteD1>, env: Env, deployId: number;
const attestation = () => ({ protocol_version: 1, deploy_id: deployId, sdk_version: '1.16.104', auth_mode: 'platform-cookie', synthetic_verified: true });
const report = (body: unknown = attestation(), token = 'valid') => app.request('/v1/apps/shop/referral-readiness/oidc', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}, env);
const readiness = (appId = 'shop') => app.request(`/v1/storefront/promoters/apps/${appId}/readiness`, {}, env);
const discovery = async () => (await (await app.request('/v1/storefront/promoters/apps', {}, env)).json()) as { apps: { appId: string }[] };
async function enroll(uid = 'gh:2') {
  const token = await mintSession({ uid, roles: ['user'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  return app.request('/v1/apps/shop/promoters/enroll', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"consent":true}' }, env);
}
function mint(sha = 'current') {
  db.sql.prepare(`INSERT INTO deploy_audit (app_id, repository, ref, sha, prefix, minted_at)
    VALUES ('shop','proappstore-online/shop','refs/heads/main',?,'apps/shop/',1)`).run(sha);
  return Number((db.sql.prepare('SELECT MAX(id) AS id FROM deploy_audit').get() as { id: number }).id);
}
beforeEach(() => {
  db = sqliteD1();
  db.sql.exec(`INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
    ('gh:1','github','1','owner',0,0),('gh:2','github','2','promoter',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',1),('other','gh:1',1),('private','gh:1',1);
    INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('private','private','[]',1);`);
  env = makeEnv({ DB: db }) as Env;
  deployId = mint();
});

describe('deployed referral readiness (#553)', () => {
  it('defaults unknown deployments to unavailable despite public visibility, open enrollment and issued credentials', async () => {
    expect(await (await readiness()).json()).toEqual({ enrollment_open: true,
      referral_tracking: { ready: false, reason: 'deployment_unverified', protocol_version: 1 } });
    expect((await discovery()).apps).toEqual([]);
    const r = await enroll();
    expect([r.status, await r.text()]).toEqual([403, 'referral_tracking_not_ready']);
    expect(db.sql.prepare('SELECT * FROM app_promoters').all()).toEqual([]);
  });

  it.each([
    ['1.16.101', 'platform-cookie', true, 'sdk_unsupported'],
    ['1.16.104-beta.1', 'platform-cookie', true, 'sdk_unsupported'],
    ['1.16.103', 'legacy-bearer', true, 'legacy_auth'],
    ['1.16.104', 'platform-cookie', false, 'synthetic_check_required'],
  ])('explains unavailable %s / %s / verified=%s', async (sdk_version, auth_mode, synthetic_verified, reason) => {
    expect((await report({ ...attestation(), sdk_version, auth_mode, synthetic_verified })).status).toBe(200);
    expect(await (await readiness()).json()).toMatchObject({ referral_tracking: { ready: false, reason } });
    expect((await discovery()).apps).toEqual([]);
    expect((await enroll()).status).toBe(403);
  });

  it('lists and enrolls only the attested app; enrollment availability remains independent', async () => {
    expect((await report()).status).toBe(200);
    expect((await discovery()).apps.map((a) => a.appId)).toEqual(['shop']);
    expect((await enroll()).status).toBe(201);
    db.sql.exec("INSERT INTO app_promoter_settings (app_id,enrollment_open,updated_by,updated_at) VALUES ('shop',0,'gh:1',1)");
    expect(await (await readiness()).json()).toMatchObject({ enrollment_open: false, referral_tracking: { ready: true } });
    expect((await discovery()).apps).toEqual([]);
    const r = await enroll(); expect([r.status, await r.text()]).toEqual([403, 'enrollment_closed']);
  });

  it('never discloses a private or missing app, even with a ready deployment', async () => {
    await seedReferralReady(db, 'private');
    for (const id of ['private', 'missing']) {
      const r = await readiness(id); expect([r.status, await r.text()]).toEqual([404, 'not found']);
    }
    expect((await discovery()).apps).toEqual([]);
  });

  it.each([['invalid', 401], ['other', 403], ['branch', 403], ['old-sha', 409]] as const)('rejects %s workflow identities', async (token, status) => {
    expect((await report(attestation(), token)).status).toBe(status);
    expect((await discovery()).apps).toEqual([]);
  });

  it('invalidates before another upload, including same-SHA retries, and refuses stale reports without erasing relationships', async () => {
    await report(); await enroll();
    const before = db.sql.prepare('SELECT * FROM app_promoters').all();
    const stale = attestation();
    deployId = mint();
    expect((await report(stale)).status).toBe(409);
    expect((await enroll()).status).toBe(403);
    expect((await discovery()).apps).toEqual([]);
    expect(db.sql.prepare('SELECT * FROM app_promoters').all()).toEqual(before);
    expect((await report()).status).toBe(200);
    expect((await enroll()).status).toBe(200);
    expect(db.sql.prepare('SELECT * FROM app_promoters').all()).toEqual(before);
  });

  it.each([{}, null, { protocol_version: 2 }, { ...attestation(), deploy_id: -1 }, { ...attestation(), synthetic_verified: 'true' }])('rejects malformed/unknown reports', async (body) => {
    expect([400, 409]).toContain((await report(body)).status);
    expect((await discovery()).apps).toEqual([]);
  });
});
