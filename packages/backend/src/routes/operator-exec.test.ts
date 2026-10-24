import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type { FasUser } from '../lib/auth.js';

const m = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  enforceActionAuth: vi.fn(),
  forwardToDataWorker: vi.fn(),
  recordActionSuccess: vi.fn(),
  requireRecentAuth: vi.fn(),
  prepareActionQuery: vi.fn(),
  prepareActionBatch: vi.fn(),
  actionCallers: vi.fn(),
  gatedTool: vi.fn(),
  unguardedStatements: vi.fn(),
  markAudited: vi.fn(),
}));

vi.mock('./actions.js', () => ({
  loadManifest: m.loadManifest,
  enforceActionAuth: m.enforceActionAuth,
  forwardToDataWorker: m.forwardToDataWorker,
  recordActionSuccess: m.recordActionSuccess,
}));
vi.mock('../lib/auth.js', async (orig) => ({ ...(await orig<typeof import('../lib/auth.js')>()), requireRecentAuth: m.requireRecentAuth }));
vi.mock('../lib/action-sql.js', () => ({
  actionCallers: m.actionCallers,
  prepareActionBatch: m.prepareActionBatch,
  prepareActionQuery: m.prepareActionQuery,
}));
vi.mock('../lib/operator-contract-shared.js', () => ({ gatedTool: m.gatedTool }));
vi.mock('../lib/operator-contract.js', () => ({ unguardedStatements: m.unguardedStatements }));
vi.mock('../lib/operator-audit-marks.js', () => ({ markAudited: m.markAudited }));

import { runOperatorQuery, runOperatorWrite, startOperatorQuery } from './operator-exec.js';

const env = { DB: {} } as unknown as Env;
const user = { id: 'gh:1' } as FasUser;
const request = new Request('https://api.test/v1/apps/a/operator');
const audit = { operatorAction: 'list', target: null, request };

const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const manifest = (over: Record<string, unknown> = {}) => ({ name: 'act', operation: 'query', ...over });

beforeEach(() => {
  vi.resetAllMocks();
  m.loadManifest.mockResolvedValue(manifest());
  m.actionCallers.mockReturnValue(['user']);
  m.gatedTool.mockReturnValue(undefined);
  m.unguardedStatements.mockReturnValue([]);
  m.enforceActionAuth.mockResolvedValue('reviewer');
  m.prepareActionQuery.mockReturnValue({ sql: 'select 1' });
  m.prepareActionBatch.mockReturnValue([{ sql: 'update 1' }]);
  m.forwardToDataWorker.mockResolvedValue(json({ rows: [{ id: 1 }] }));
});

const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message: string }) => e);

describe('runOperatorQuery / startOperatorQuery', () => {
  it('returns the rows and audits the role-granted success with the operator context', async () => {
    expect(await runOperatorQuery(env, 'a', 'act', { x: 1 }, user, 'tok', audit)).toEqual([{ id: 1 }]);
    expect(m.forwardToDataWorker).toHaveBeenCalledWith(env, 'a', 'query', { sql: 'select 1' }, 'tok');
    expect(m.recordActionSuccess).toHaveBeenCalledWith(env.DB, 'a', 'act', { actorId: 'gh:1', role: 'reviewer' }, 200, audit);
    expect(m.markAudited).toHaveBeenCalledWith(request);
  });

  it('returns no rows when the data worker sends a non-array rows field', async () => {
    m.forwardToDataWorker.mockResolvedValue(json({ rows: 'nope' }));
    expect(await runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit)).toEqual([]);
  });

  it('writes no audit row when the action was admitted without a role', async () => {
    m.enforceActionAuth.mockResolvedValue(null);
    await runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit);
    expect(m.recordActionSuccess).not.toHaveBeenCalled();
    expect(m.markAudited).not.toHaveBeenCalled();
  });

  it('records the final status only when finish() is called', async () => {
    const read = await startOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit);
    expect(m.recordActionSuccess).not.toHaveBeenCalled();
    await read.finish(404);
    expect(m.recordActionSuccess).toHaveBeenCalledWith(env.DB, 'a', 'act', { actorId: 'gh:1', role: 'reviewer' }, 404, audit);
  });

  it('requires recent auth on the console relying party when the action is step_up', async () => {
    m.loadManifest.mockResolvedValue(manifest({ step_up: true }));
    await runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit);
    expect(m.requireRecentAuth).toHaveBeenCalledWith(user, env, expect.objectContaining({ rpId: expect.any(String) }));
  });

  it('does not require recent auth for an action without step_up', async () => {
    await runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit);
    expect(m.requireRecentAuth).not.toHaveBeenCalled();
  });
});

describe('refusals before anything runs (409)', () => {
  it.each([
    ['a write action used as a query', { operation: 'execute' }],
    ['an action that does not require auth', { requires_auth: false }],
    ['a scheduled action', { schedule: '0 * * * *' }],
  ])('refuses %s', async (_label, over) => {
    m.loadManifest.mockResolvedValue(manifest(over));
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(409);
    expect(m.forwardToDataWorker).not.toHaveBeenCalled();
  });

  it('refuses a worker/hook-only action', async () => {
    m.actionCallers.mockReturnValue(['worker']);
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(409);
    expect(e?.message).toContain('cannot run from the operator view');
  });

  it('refuses an action re-registered without a role', async () => {
    m.gatedTool.mockReturnValue('act has no role');
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(409);
    expect(e?.message).toContain('act has no role');
    expect(m.enforceActionAuth).not.toHaveBeenCalled();
  });

  it('refuses a guarded write whose statements ignore the status param', async () => {
    m.loadManifest.mockResolvedValue(manifest({ operation: 'execute' }));
    m.unguardedStatements.mockReturnValue([0]);
    const e = await refusal(runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, 'status'));
    expect(e?.status).toBe(409);
    expect(e?.message).toContain(':status');
    expect(m.forwardToDataWorker).not.toHaveBeenCalled();
  });

  it('lets the role check refusal through untouched', async () => {
    m.enforceActionAuth.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(403);
    expect(m.forwardToDataWorker).not.toHaveBeenCalled();
  });
});

describe('upstream and input errors', () => {
  it('maps a statement-preparation error to 400', async () => {
    m.prepareActionQuery.mockImplementation(() => { throw new Error('missing :id'); });
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(400);
    expect(e?.message).toBe('missing :id');
  });

  it('maps a non-Error throw to 400 with its string form', async () => {
    m.prepareActionQuery.mockImplementation(() => { throw 'bad'; });
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(400);
    expect(e?.message).toBe('bad');
  });

  it('passes a 4xx from the data worker through and maps a 5xx to 502', async () => {
    m.forwardToDataWorker.mockResolvedValueOnce(json({}, 422));
    expect((await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit)))?.status).toBe(422);
    m.forwardToDataWorker.mockResolvedValueOnce(json({}, 503));
    expect((await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit)))?.status).toBe(502);
  });

  it('answers 502 for a non-JSON data worker body, with no audit row', async () => {
    m.forwardToDataWorker.mockResolvedValue(json('<html>'));
    const e = await refusal(runOperatorQuery(env, 'a', 'act', {}, user, 'tok', audit));
    expect(e?.status).toBe(502);
    expect(m.recordActionSuccess).not.toHaveBeenCalled();
  });
});

describe('runOperatorWrite', () => {
  const write = (over: Record<string, unknown> = {}) => m.loadManifest.mockResolvedValue(manifest({ operation: 'execute', ...over }));

  it('returns meta.changes for an execute and audits 200', async () => {
    write();
    m.forwardToDataWorker.mockResolvedValue(json({ meta: { changes: 1 } }));
    expect(await runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, null)).toBe(1);
    expect(m.forwardToDataWorker).toHaveBeenCalledWith(env, 'a', 'execute', { sql: 'select 1' }, 'tok');
    expect(m.recordActionSuccess).toHaveBeenCalledWith(env.DB, 'a', 'act', { actorId: 'gh:1', role: 'reviewer' }, 200, audit);
  });

  it('sums changes across a batch', async () => {
    write({ operation: 'batch' });
    m.forwardToDataWorker.mockResolvedValue(json({ results: [{ meta: { changes: 2 } }, { meta: { changes: 1 } }, {}] }));
    expect(await runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, 'status')).toBe(3);
    expect(m.forwardToDataWorker).toHaveBeenCalledWith(env, 'a', 'batch', { statements: [{ sql: 'update 1' }] }, 'tok');
  });

  it('treats a missing meta as zero changes; unguarded, that is not a conflict', async () => {
    write();
    m.forwardToDataWorker.mockResolvedValue(json({}));
    expect(await runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, null)).toBe(0);
    expect(m.recordActionSuccess).toHaveBeenCalledWith(env.DB, 'a', 'act', expect.anything(), 200, audit);
  });

  it('records 409 and refuses when the status guard matched nothing', async () => {
    write();
    m.forwardToDataWorker.mockResolvedValue(json({ meta: { changes: 0 } }));
    const e = await refusal(runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, 'status'));
    expect(e?.status).toBe(409);
    expect(m.recordActionSuccess).toHaveBeenCalledWith(env.DB, 'a', 'act', expect.anything(), 409, audit);
    expect(m.markAudited).toHaveBeenCalledWith(request);
  });

  it('writes no audit row for a role-less admission, even on a guard conflict', async () => {
    write();
    m.enforceActionAuth.mockResolvedValue(null);
    m.forwardToDataWorker.mockResolvedValue(json({ meta: { changes: 0 } }));
    const e = await refusal(runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, 'status'));
    expect(e?.status).toBe(409);
    expect(m.recordActionSuccess).not.toHaveBeenCalled();
  });

  it('refuses a query action used as a write', async () => {
    const e = await refusal(runOperatorWrite(env, 'a', 'act', {}, user, 'tok', audit, null));
    expect(e?.status).toBe(409);
  });
});
