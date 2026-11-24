import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock deploy-worker since it also calls fetch — we want to test provision-data's
// orchestration logic, not the deploy internals (those have their own test).
vi.mock('./deploy-worker.js', () => ({
  deployDataWorker: vi.fn().mockResolvedValue({
    ok: true, url: 'https://data-test.proappstore.online',
    workersDevUrl: 'https://pas-data-test.workers.dev',
    detail: 'Deployed pas-data-test',
  }),
}));

const { provisionData } = await import('./provision-data.js');
const { deployDataWorker } = await import('./deploy-worker.js');

/** `recorded`: the app row's d1_database_id; `owner`: another app already recording the resolved uuid. */
function fakeDb({ recorded, owner }: { recorded?: string; owner?: string } = {}) {
  const runs: { sql: string; args: unknown[] }[] = [];
  return {
    runs,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        runs.push({ sql, args });
        return {
          run: async () => {},
          // The creator-existence guard (#81) expects a real user; return a row
          // for that lookup, null otherwise.
          first: async () => {
            if (/FROM users\b/i.test(sql)) return { 1: 1 };
            if (/^SELECT d1_database_id FROM apps/i.test(sql)) return recorded ? { d1_database_id: recorded } : null;
            if (/^SELECT id FROM apps WHERE d1_database_id/i.test(sql)) return owner ? { id: owner } : null;
            return null;
          },
        };
      },
    }),
  } as unknown as D1Database;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(deployDataWorker).mockClear();
});

describe('provisionData', () => {
  const base = { appId: 'test-app', creatorId: 'u-1', cfToken: 'tok', cfAccount: 'acct', sessionSigningKey: 'sk', internalToken: 'internal-secret' };

  it('refuses a canonical alias before any external allocation', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ creator_id: null, alias_reserved: 1 }) }) }) } as unknown as D1Database;
    expect(await provisionData({ ...base, db })).toMatchObject({ dbId: '', dataWorkerUrl: '', steps: [{ name: 'reserve_id', status: 'fail' }] });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(deployDataWorker).not.toHaveBeenCalled();
  });

  it('creates D1, deploys worker, records app on success', async () => {
    // D1 create succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true, result: { uuid: 'db-uuid-1' } }),
    } as Response);

    const db = fakeDb();
    const result = await provisionData({ ...base, db });

    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.name).toBe('create_d1');
    expect(result.steps[0]!.status).toBe('ok');
    expect(result.steps[1]!.name).toBe('deploy_worker');
    expect(result.steps[1]!.status).toBe('ok');
    expect(result.steps[2]!.name).toBe('record_app');
    expect(result.steps[2]!.status).toBe('ok');
    expect(result.dbId).toBe('db-uuid-1');
    expect(result.dataWorkerUrl).toBe('https://data-test.proappstore.online');

    expect(deployDataWorker).toHaveBeenCalledWith('test-app', 'db-uuid-1', 'tok', 'acct', 'sk', 'internal-secret', { dataWorkerHost: undefined });
  });

  it('skips D1 creation when database already exists', async () => {
    // D1 create returns "already exists"
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, errors: [{ message: 'already exists' }] }),
    } as Response);
    // D1 list returns the existing db
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ result: [{ uuid: 'existing-db', name: 'pas-data-test-app' }] }),
    } as Response);

    const db = fakeDb();
    const result = await provisionData({ ...base, db });

    expect(result.steps[0]!.status).toBe('skip');
    expect(result.dbId).toBe('existing-db');
    // #394: an existing app is still redeployed, bound to its existing database —
    // the path redeploy-data-workers.yml takes, so a fleet rollout gives every
    // existing worker the same upload (and observability policy) as a new one.
    expect(deployDataWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deployDataWorker).mock.calls[0]![1]).toBe('existing-db');
    expect(result.steps.find((s) => s.name === 'deploy_worker')?.status).toBe('ok');
  });

  it('skips worker deploy and app record when D1 creation fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, errors: [{ message: 'quota exceeded' }] }),
    } as Response);

    const db = fakeDb();
    const result = await provisionData({ ...base, db });

    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[0]!.detail).toContain('quota exceeded');
    expect(result.steps[1]!.status).toBe('skip');
    expect(result.steps[2]!.status).toBe('skip');
    expect(result.dbId).toBe('');
    expect(deployDataWorker).not.toHaveBeenCalled();
  });

  it('handles D1 create network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const db = fakeDb();
    const result = await provisionData({ ...base, db });

    expect(result.steps[0]!.status).toBe('fail');
    expect(result.steps[0]!.detail).toContain('network down');
  });

  describe('the recorded d1_database_id is the authority (#688)', () => {
    const d1Get = (status: number, body: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
    const named = (uuid?: string) => d1Get(200, { success: true, result: uuid ? [{ uuid, name: 'pas-data-test-app' }] : [] });
    const urls = () => mockFetch.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`);
    const appWrites = (db: ReturnType<typeof fakeDb>) => db.runs.filter((r) => /INSERT INTO apps/i.test(r.sql));

    it('binds the recorded database without creating one when the name agrees', async () => {
      mockFetch.mockResolvedValueOnce(d1Get(200, { success: true, result: { uuid: 'rec-db' } })).mockResolvedValueOnce(named('rec-db'));
      const db = fakeDb({ recorded: 'rec-db' });
      const result = await provisionData({ ...base, db });
      expect(urls()).toEqual([
        'GET https://api.cloudflare.com/client/v4/accounts/acct/d1/database/rec-db',
        'GET https://api.cloudflare.com/client/v4/accounts/acct/d1/database?name=pas-data-test-app',
      ]);
      expect(result.steps[0]).toEqual({ name: 'create_d1', status: 'skip', detail: 'pas-data-test-app already exists (rec-db)' });
      expect(vi.mocked(deployDataWorker).mock.calls[0]![1]).toBe('rec-db');
      expect(result.dbId).toBe('rec-db');
    });

    it('refuses to bind either database when the named one is not the recorded one', async () => {
      mockFetch.mockResolvedValueOnce(d1Get(200, { success: true, result: { uuid: 'rec-db' } })).mockResolvedValueOnce(named('name-db'));
      const db = fakeDb({ recorded: 'rec-db' });
      const result = await provisionData({ ...base, db });
      expect(result.steps[0]!).toMatchObject({ name: 'create_d1', status: 'fail' });
      expect(result.steps[0]!.detail).toContain('rec-db');
      expect(result.steps[0]!.detail).toContain('name-db');
      expect(result.steps.slice(1).map((s) => s.status)).toEqual(['skip', 'skip']);
      expect(deployDataWorker).not.toHaveBeenCalled();
      expect(appWrites(db)).toEqual([]);
      expect(urls().some((u) => u.startsWith('POST'))).toBe(false);
    });

    it('binds the recorded database when no database carries the app name (a renamed app)', async () => {
      mockFetch.mockResolvedValueOnce(d1Get(200, { success: true, result: { uuid: 'rec-db' } })).mockResolvedValueOnce(named());
      const result = await provisionData({ ...base, db: fakeDb({ recorded: 'rec-db' }) });
      expect(urls().some((u) => u.startsWith('POST'))).toBe(false);
      expect(vi.mocked(deployDataWorker).mock.calls[0]![1]).toBe('rec-db');
      expect(result.steps.map((s) => s.status)).toEqual(['skip', 'ok', 'ok']);
    });

    it('refuses to create an empty replacement when the recorded database is gone', async () => {
      mockFetch.mockResolvedValueOnce(d1Get(404, { success: false, errors: [{ message: 'not found' }] }));
      const db = fakeDb({ recorded: 'gone-db' });
      const result = await provisionData({ ...base, db });
      expect(result.steps[0]).toEqual({ name: 'create_d1', status: 'fail', detail: 'recorded D1 gone-db not found; refusing to create an empty replacement' });
      expect(urls()).toEqual(['GET https://api.cloudflare.com/client/v4/accounts/acct/d1/database/gone-db']);
      expect(deployDataWorker).not.toHaveBeenCalled();
      expect(appWrites(db)).toEqual([]);
    });

    it('refuses a database found by name that another app records as its own', async () => {
      mockFetch
        .mockResolvedValueOnce(d1Get(200, { success: false, errors: [{ message: 'already exists' }] }))
        .mockResolvedValueOnce(named('rideshare-db'));
      const db = fakeDb({ owner: 'rideshare' });
      const result = await provisionData({ ...base, db });
      expect(result.steps[0]).toEqual({ name: 'create_d1', status: 'fail', detail: 'D1 rideshare-db belongs to app rideshare' });
      expect(deployDataWorker).not.toHaveBeenCalled();
      expect(appWrites(db)).toEqual([]);
    });
  });
});
