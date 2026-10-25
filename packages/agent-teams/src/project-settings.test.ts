import { describe, expect, it } from 'vitest';
import { getAgents, getProject, getRoles, initProject, setBudget, setRoles } from './project-settings.ts';
import { clearActivity, getActivity, getCostSummary, getTestHistory, ingestTestResults, triggerTestRun } from './project-reports.ts';
import { loadFiles } from './project-store.ts';
import { OWNER, fakeHost, req, seedProject } from './project-test-host.ts';

const init = (body: unknown, userId = OWNER) => req('/project', { method: 'PUT', body, headers: { 'X-User-Id': userId } });

describe('initProject', () => {
  it('creates the project with default roles and a seeded working tree', async () => {
    const { host, db, broadcasts } = fakeHost();
    const res = await initProject(host, init({ name: 'Demo', slug: 'demo', ownerId: OWNER, idea: ' a todo app ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: 'demo', seededTicket: false });
    expect(db.prepare('SELECT name, owner_id, app_idea, cost_cap_monthly_usd AS cap FROM project').get()).toEqual({ name: 'Demo', owner_id: OWNER, app_idea: 'a todo app', cap: 50 });
    expect((db.prepare('SELECT role FROM role_configs ORDER BY role').all() as { role: string }[]).map((r) => r.role)).toEqual(['Architect', 'BA', 'Dev', 'QA']);
    expect(loadFiles(host.state.storage.sql).size).toBeGreaterThan(0);
    expect(broadcasts.map((b) => b.type)).toEqual(['project-created']);
  });

  it('requires a name, slug and owner', async () => {
    const { host } = fakeHost();
    expect((await initProject(host, init({ name: 'x' }))).status).toBe(400);
  });

  it('lets only the owner re-init, and keeps the cost tracking when they do', async () => {
    const { host, db } = fakeHost();
    await initProject(host, init({ name: 'Demo', slug: 'demo', ownerId: OWNER }));
    db.prepare('UPDATE project SET cost_spent_monthly_usd = 7').run();
    expect((await initProject(host, init({ name: 'Takeover', slug: 'demo', ownerId: 'gh:evil' }, 'gh:evil'))).status).toBe(404);
    expect((await initProject(host, init({ name: 'Renamed', slug: 'demo', ownerId: OWNER, costCapMonthlyUsd: 80 }))).status).toBe(200);
    expect(db.prepare('SELECT name, owner_id, cost_cap_monthly_usd AS cap, cost_spent_monthly_usd AS spent FROM project').get()).toEqual({ name: 'Renamed', owner_id: OWNER, cap: 80, spent: 7 });
  });
});

describe('getProject', () => {
  it('404s before init', () => {
    expect(getProject(fakeHost().host).status).toBe(404);
  });

  it('reports last month\'s spend as 0', async () => {
    const { host, db } = fakeHost();
    seedProject(db, { cost_spent_monthly_usd: 9, cost_month: '2001-01' });
    expect(await getProject(host).json()).toMatchObject({ slug: 'demo', status: 'paused', costSpentMonthlyUsd: 0, costCapMonthlyUsd: 50, maxRunMinutes: 10 });
    db.prepare('UPDATE project SET cost_month = ?').run(new Date().toISOString().slice(0, 7));
    expect(await getProject(host).json()).toMatchObject({ costSpentMonthlyUsd: 9 });
  });
});

describe('setBudget', () => {
  it('validates the cap and the run timeout', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    const put = (body: unknown) => setBudget(host, req('/budget', { method: 'PUT', body }));
    expect((await put({ costCapMonthlyUsd: 0 })).status).toBe(400);
    expect((await put({ costCapMonthlyUsd: 1001 })).status).toBe(400);
    expect((await put({ maxRunMinutes: 61 })).status).toBe(400);
    expect((await put({ maxRunMinutes: 1.5 })).status).toBe(400);
    expect(db.prepare('SELECT cost_cap_monthly_usd AS c, max_run_minutes AS m FROM project').get()).toEqual({ c: 50, m: 10 });
  });

  it('persists a valid cap and timeout and logs them', async () => {
    const { host, db, activity } = fakeHost();
    seedProject(db);
    const res = await setBudget(host, req('/budget', { method: 'PUT', body: { costCapMonthlyUsd: 120, maxRunMinutes: 30 } }));
    expect(await res.json()).toEqual({ ok: true, costCapMonthlyUsd: 120, maxRunMinutes: 30 });
    expect(db.prepare('SELECT cost_cap_monthly_usd AS c, max_run_minutes AS m FROM project').get()).toEqual({ c: 120, m: 30 });
    expect(activity.map((a) => a.detail)).toEqual(['Monthly budget set to $120.00', 'Agent run timeout set to 30 min']);
  });
});

describe('roles and agents', () => {
  it('round-trips role configs and resolves the agent catalog', async () => {
    const { host } = fakeHost();
    await initProject(host, init({ name: 'Demo', slug: 'demo', ownerId: OWNER }));
    const { roles } = (await getRoles(host).json()) as { roles: { role: string }[] };
    expect(roles.map((r) => r.role)).toEqual(['Architect', 'BA', 'Dev', 'QA']);
    const dev = { role: 'Dev', runtime: 'cf-native', model: 'claude-sonnet-4-6', spineTools: ['read_file'], vendorTools: [], persona: 'terse' };
    expect((await setRoles(host, req('/roles', { method: 'PUT', body: { roles: [dev] } }))).status).toBe(200);
    expect(((await getRoles(host).json()) as { roles: { role: string; persona?: string }[] }).roles.find((r) => r.role === 'Dev')?.persona).toBe('terse');
    const { agents } = (await getAgents(host).json()) as { agents: unknown[] };
    expect(agents.length).toBeGreaterThan(0);
  });
});

describe('reports', () => {
  it('ingests a CI run and reports history, per-spec trending and overall stats', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    const ingest = (body: unknown) => ingestTestResults(host, req('/test-history', { method: 'POST', body }));
    await ingest({ runId: 'r1', status: 'passed', passed: 2, results: [
      { specFile: 'a.spec.ts', testName: 'one', status: 'pass' }, { specFile: 'a.spec.ts', testName: 'two', status: 'fail' }, { specFile: '', testName: 'bad', status: 'pass' },
    ] });
    await ingest({ runId: 'r2', failed: 1 });
    expect(broadcasts.filter((b) => b.type === 'test-run-completed')).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM test_results').get()).toEqual({ n: 2 }); // the malformed entry is skipped
    const history = (await getTestHistory(host).json()) as { runs: { id: string; status: string }[]; specTrending: Record<string, { pct: number; total: number }>; stats: unknown };
    expect(history.runs.map((r) => [r.id, r.status]).sort()).toEqual([['r1', 'passed'], ['r2', 'failed']]);
    expect(history.specTrending['a.spec.ts']).toMatchObject({ pass: 1, fail: 1, total: 2, pct: 50 });
    expect(history.stats).toEqual({ totalRuns: 2, passedRuns: 1, overallPct: 50 });
  });

  it('refuses to trigger a test run with no project, no admin binding or no specs', async () => {
    expect((await triggerTestRun(fakeHost().host)).status).toBe(404);
    const noAdmin = fakeHost();
    seedProject(noAdmin.db);
    expect((await triggerTestRun(noAdmin.host)).status).toBe(500);
    const noSpecs = fakeHost({ ADMIN: { fetch: async () => Response.json({}) }, INTERNAL_TOKEN: 't' });
    seedProject(noSpecs.db);
    const res = await triggerTestRun(noSpecs.host);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No test specs found/);
  });

  it('serves the activity trail and clears it', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    expect(await getActivity(host).json()).toEqual({ activity: [] });
    expect(await clearActivity(host).json()).toEqual({ ok: true });
    expect(broadcasts).toContainEqual({ type: 'activity-cleared' });
    expect(await getCostSummary(host).json()).toBeTypeOf('object');
  });
});
