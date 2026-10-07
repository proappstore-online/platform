import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerCallError, workerConnectorToken } from './app-worker-calls.js';
import * as ghApp from './github-app.js';
import { sealSecret } from './encryption.js';
import type { Env } from '../types.js';

// #258 §4: which credential PAS.connectors.token hands a worker.

const KEK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
let connector: Record<string, unknown> | null;
let installations: { installation_id: number; account_login: string }[];
let pat: string | null;
let owners: unknown[];

async function makeEnv(): Promise<Env> {
  const sealed = pat === null ? null : await sealSecret(pat, KEK);
  const db = {
    prepare: (sql: string) => {
      const s = sql.replace(/\s+/g, ' ');
      return { bind: (...args: unknown[]) => ({
        first: async () => {
          if (s.startsWith('SELECT modes, pat_secret FROM app_connectors')) return connector;
          if (s.startsWith('SELECT installation_id FROM app_connector_installations')) {
            const owner = s.includes('lower(account_login)') ? String(args[1]) : null;
            owners.push(owner);
            return installations.find((i) => owner === null || i.account_login.toLowerCase() === owner) ?? null;
          }
          if (s.startsWith('SELECT key_ciphertext')) return sealed ? { key_ciphertext: sealed.keyCiphertext, dek_wrapped: sealed.dekWrapped, iv: sealed.iv } : null;
          throw new Error(`unexpected SQL: ${s}`);
        },
        run: async () => ({ meta: { changes: 1 } }),
      }) };
    },
  } as unknown as D1Database;
  return {
    DB: db, APP_SECRET_KEK: KEK, SESSION_SIGNING_KEY: 'sk', GH_APP_ID: '1', GH_APP_CLIENT_ID: 'c', GH_APP_SLUG: 's',
    GH_APP_PRIVATE_KEY: 'k', GH_APP_WEBHOOK_SECRET: 'w', GH_APP_CLIENT_SECRET: 's',
  } as unknown as Env;
}

let token: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  connector = { modes: '["app","pat"]', pat_secret: 'GITHUB_TOKEN' };
  installations = [{ installation_id: 7, account_login: 'Acme' }];
  pat = 'ghp_pat';
  owners = [];
  token = vi.spyOn(ghApp, 'installationToken').mockImplementation(async (_env, id, repo) => `ghs_${id}_${repo ?? 'all'}`);
});
afterEach(() => vi.restoreAllMocks());

describe('workerConnectorToken (#258)', () => {
  it('an installation covering the owner → a token scoped to that repo', async () => {
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'acme/x' })).toBe('ghs_7_acme/x');
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'acme/y' })).toBe('ghs_7_acme/y');
    expect(token.mock.calls.map((c) => c[2])).toEqual(['acme/x', 'acme/y']);
  });
  it('no repo → an unscoped token of the app\'s installation', async () => {
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', undefined)).toBe('ghs_7_all');
  });
  it('mode "pat" returns the PAT even when an installation covers the owner', async () => {
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'acme/x', mode: 'pat' })).toBe('ghp_pat');
    expect(token).not.toHaveBeenCalled();
  });
  it('no installation covers the owner → the PAT; with no PAT set → null', async () => {
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'other/x' })).toBe('ghp_pat');
    pat = null;
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'other/x' })).toBeNull();
  });
  it('a failed mint falls back to the PAT; mode "app" does not', async () => {
    token.mockResolvedValue(null);
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'acme/x' })).toBe('ghp_pat');
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'acme/x', mode: 'app' })).toBeNull();
  });
  it('a connector without the "pat" mode never yields the PAT; one without "app" never mints', async () => {
    connector = { modes: '["app"]', pat_secret: null };
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'other/x' })).toBeNull();
    connector = { modes: '["pat"]', pat_secret: 'GITHUB_TOKEN' };
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', { repo: 'acme/x' })).toBe('ghp_pat');
    expect(token).not.toHaveBeenCalled();
  });
  it('skips the App when it is not configured (the PAT still works)', async () => {
    const env = await makeEnv();
    env.GH_APP_PRIVATE_KEY = undefined;
    expect(await workerConnectorToken(env, 'a', 'github', { repo: 'acme/x' })).toBe('ghp_pat');
  });
  it('null for a connector the manifest does not declare', async () => {
    connector = null;
    expect(await workerConnectorToken(await makeEnv(), 'a', 'github', {})).toBeNull();
  });
  it('rejects malformed input', async () => {
    const env = await makeEnv();
    for (const opts of [{ repo: 'no-slash' }, { repo: 'a/b/c' }, { mode: 'user' }, [], 'x']) {
      await expect(workerConnectorToken(env, 'a', 'github', opts)).rejects.toBeInstanceOf(WorkerCallError);
    }
    await expect(workerConnectorToken(env, 'a', '', {})).rejects.toBeInstanceOf(WorkerCallError);
  });
});
