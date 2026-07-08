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

function fakeDb() {
  const runs: { sql: string; args: unknown[] }[] = [];
  return {
    runs,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        runs.push({ sql, args });
        return {
          run: async () => {},
          first: async () => null,
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

    expect(deployDataWorker).toHaveBeenCalledWith('test-app', 'db-uuid-1', 'tok', 'acct', 'sk', 'internal-secret');
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
});
