import { SELF, env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, mockNetwork, resetTables, viaHostApi } from './helpers';
import { Authenticator } from './webauthn';
import { ActionError } from '../../../sdk/src/actions';

// #231 (part of #228): an action declaring `step_up: true` runs only for a
// session whose auth_time is within STEP_UP_MAX_AGE_SECONDS (default 300). A
// stale caller gets a distinct 403 `step_up_required` — never 401, which the
// host would treat as a dead session and sign the user out. Real D1; the
// data-worker hop is intercepted and must not be reached on a refusal.

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'op');
  await seedApp('ops', 'gh:1');
});

const SQL = 'SELECT id FROM documents WHERE owner_id = :__user_id AND id = :doc_id LIMIT 1';
const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: name, operation: 'query', sql: SQL, params: { doc_id: { type: 'string' } }, requires_auth: true, ...extra,
});

async function registerTools(...tools: ReturnType<typeof tool>[]): Promise<void> {
  const now = Date.now();
  for (const t of tools) {
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES ('ops', ?, ?, ?, ?, 'code')")
      .bind(t.name, JSON.stringify(t), now, now).run();
  }
}

/** A session whose last active authentication was `ageSeconds` ago (none when null). */
function sessionAged(ageSeconds: number | null, rpId = 'ops.proappstore.online'): Promise<string> {
  return mintSession(
    { uid: 'gh:2', login: 'op', avatarUrl: null, roles: ['user'], ...(ageSeconds === null ? {} : { auth_time: Math.floor(Date.now() / 1000) - ageSeconds, auth_method: 'passkey', step_up_rp_id: rpId }) },
    env.SESSION_SIGNING_KEY,
  );
}

const call = (name: string, token: string, host = 'ops.proappstore.online') => viaHostApi(`${BASE}/v1/apps/ops/actions/${name}`, {
  ...json('POST', { params: { doc_id: 'd1' } }, token),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-PAS-App': 'ops', 'X-PAS-Host': host },
});
const dataWorkerAnswers = () =>
  fetchMock.get(`https://pas-data-ops.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ id: 'd1' }], meta: {} });

describe('step_up actions (#231)', () => {
  it('a fresh auth_time passes', async () => {
    await registerTools(tool('view_id_document', { step_up: true }));
    dataWorkerAnswers();
    const res = await call('view_id_document', await sessionAged(30));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ rows: [{ id: 'd1' }] });
  });

  it('a stale auth_time is refused with 403 step_up_required, before the data worker', async () => {
    await registerTools(tool('view_id_document', { step_up: true }));
    const res = await call('view_id_document', await sessionAged(301));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', message: 'Recent passkey verification required', max_age: 300, method: 'passkey' });
  });

  // #337: since #331 a step_up action is bound to the app's relying party, which
  // only a passkey step-up there satisfies. The refusal must say so, or the SDK
  // sends the user to sign in again and the retry is refused again.
  it('a fresh OAuth sign-in is refused with method passkey (needsPasskey), and a passkey step-up on the same relying party then passes (#337)', async () => {
    await registerTools(tool('view_id_document', { step_up: true }));
    for (const t of ['passkey_credentials', 'passkey_challenges']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    const RP = 'ops.proappstore.online';
    const oauth = await mintSession({ uid: 'gh:2', login: 'op', avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'github' }, env.SESSION_SIGNING_KEY);

    const refused = await call('view_id_document', oauth);
    expect(refused.status).toBe(403);
    const text = await refused.text();
    expect(JSON.parse(text)).toEqual({ error: 'step_up_required', message: 'Recent passkey verification required', max_age: 300, method: 'passkey' });
    const err = new ActionError('view_id_document', 403, text);
    expect([err.stepUpRequired, err.needsPasskey, err.forbidden]).toEqual([true, true, false]);

    // The flow the SDK points to: register a passkey on this origin (fresh sign-in), step up with it, retry.
    const passkey = (path: string, token: string, body: unknown = {}) => viaHostApi(`${BASE}/v1/auth/passkey/${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PAS-App': 'ops', 'X-PAS-Host': RP },
    });
    const challenge = async (path: string, token: string) => {
      const res = await passkey(path, token);
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { challenge: string }).challenge;
    };
    const auth = await Authenticator.create(RP);
    const reg = await passkey('register', oauth, await auth.attest(await challenge('register/options', oauth)));
    expect(reg.status, await reg.clone().text()).toBe(200);
    const stepped = await passkey('step-up', oauth, await auth.assert(await challenge('step-up/options', oauth)));
    expect(stepped.status, await stepped.clone().text()).toBe(200);
    const { token } = (await stepped.json()) as { token: string };

    dataWorkerAnswers();
    const ok = await call('view_id_document', token);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ rows: [{ id: 'd1' }] });
  });

  it('refuses a passkey step-up replayed from another app or a direct bearer request (#331)', async () => {
    await registerTools(tool('view_id_document', { step_up: true }));
    const fromAnotherApp = await call('view_id_document', await sessionAged(30, 'other.proappstore.online'));
    expect(fromAnotherApp.status).toBe(403);
    expect(await fromAnotherApp.json()).toMatchObject({ error: 'step_up_required' });

    const direct = await SELF.fetch(`${BASE}/v1/apps/ops/actions/view_id_document`, json('POST', { params: { doc_id: 'd1' } }, await sessionAged(30)));
    expect(direct.status).toBe(403);
  });

  it('a session with no auth_time (minted before #230) is refused the same way', async () => {
    await registerTools(tool('view_id_document', { step_up: true }));
    const res = await call('view_id_document', await sessionAged(null));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'step_up_required' });
  });

  it('actions without step_up are unaffected by a stale or missing auth_time', async () => {
    await registerTools(tool('list_mine'), tool('list_explicit', { step_up: false }));
    for (const [name, age] of [['list_mine', 86_400], ['list_explicit', 86_400], ['list_mine', null]] as const) {
      dataWorkerAnswers();
      const res = await call(name, await sessionAged(age));
      expect(res.status, `${name} ${age}`).toBe(200);
      await res.text();
    }
  });

  it('the role check comes first: a caller without the role is told that, not asked to step up', async () => {
    await registerTools(tool('view_id_document', { step_up: true, auth: { app_roles: ['operator'] } }));
    const res = await call('view_id_document', await sessionAged(3600));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'requires app role' });
  });

  it('a personal app token can never satisfy step_up', async () => {
    await registerTools(tool('view_id_document', { step_up: true }));
    const minted = await SELF.fetch(`${BASE}/v1/apps/ops/tokens`, json('POST', { access: 'read', expires_in: 86_400 }, await sessionAged(10)));
    expect(minted.status, await minted.clone().text()).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    const res = await call('view_id_document', token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('cannot be called with an app token');
  });
});
