import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end evaluations for the create-proappstore-app skill (#170): each
 * fixture in skills/create-proappstore-app/evals/cases.json drives the REAL
 * provision_pas_app tool through the fake-McpServer harness with the listed
 * mocks and asserts on the text the skill tells the agent to read.
 */
const mockGh = {
  api: vi.fn(), createRepoFromTemplate: vi.fn(), repoExists: vi.fn(), getFile: vi.fn(), putFile: vi.fn(),
  deleteFile: vi.fn(), listFiles: vi.fn(), searchCode: vi.fn(), pushFiles: vi.fn(), getDeployStatus: vi.fn(), setRepoVariable: vi.fn(),
};
vi.mock('@proappstore/build-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@proappstore/build-core')>()),
  makeGitHub: () => mockGh,
  verifyAppOwnership: vi.fn(),
}));
const { verifyAppOwnership } = await import('@proappstore/build-core');
const mockOwnership = vi.mocked(verifyAppOwnership);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const { registerProjectTools } = await import('./project-tools.js');
const svc = { fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a) } as unknown as Fetcher;

function register(readOnly: boolean, session: { userId: string | null; login: string | null; token: string | null; roles?: string[] }) {
  const tools = new Map<string, Handler>();
  const env = { GITHUB_ORG: 'test-org', GITHUB_TOKEN: 'gh-tok', API_BASE: 'https://api.test.com', API: svc, ADMIN: svc, HOST: svc,
    INTERNAL_TOKEN: 'internal-secret', R2_ACCESS_KEY_ID: 'r2-ak', R2_SECRET_ACCESS_KEY: 'r2-sk', R2_ACCOUNT_ID: 'r2-acct',
    ...(readOnly ? { MCP_READ_ONLY: '1' } : {}) };
  registerProjectTools({ tool: (n: string, _d: string, _s: unknown, h: Handler) => { tools.set(n, h); } } as never, env as never, () => session);
  return tools.get('provision_pas_app')!;
}

interface Case {
  id: string; class: string; blocker?: string; title: string; args: Record<string, unknown>;
  mocks: { createRepo?: { ok: boolean; status: number }; repoExists?: boolean; ownsApp?: boolean; listingStatus?: number;
    templateHeadSha?: string | null; provision?: { status: number; body: unknown }; session?: null; readOnly?: boolean };
  expect: { contains?: string[]; containsRegex?: string[]; notContains?: string[]; createCalled?: boolean; provisionCalled?: boolean;
    provisionBody?: Record<string, unknown>; provisionBodyLacks?: string[]; throwsContaining?: string; dryRunStillWorks?: boolean };
}
const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../skills/create-proappstore-app/evals/cases.json'), 'utf8')) as { input: Record<string, unknown>; cases: Case[] };

function applyMocks(m: Case['mocks']) {
  mockGh.createRepoFromTemplate.mockResolvedValue({ ...(m.createRepo ?? { ok: true, status: 200 }), data: {} });
  mockGh.repoExists.mockResolvedValue(m.repoExists ?? false);
  mockGh.setRepoVariable.mockResolvedValue({ ok: true, status: 200, data: {} });
  mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
  mockGh.pushFiles.mockResolvedValue({ ok: true, commitSha: 'abcdef1234567890' });
  mockGh.api.mockResolvedValue(m.templateHeadSha === null ? { ok: false, status: 500, data: {} } : { ok: true, status: 200, data: { sha: m.templateHeadSha ?? 'd8c2e08f32b8e30847b27c7092fd4b0e64341d2f' } });
  mockOwnership.mockResolvedValue(m.ownsApp ?? true);
  mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/listing')) return { ok: m.listingStatus === undefined, status: m.listingStatus ?? 200, text: async () => '{}', json: async () => ({}) };
    if (u.includes('/v1/provision')) {
      const p = m.provision ?? { status: 200, body: { success: true, steps: [] } };
      return { ok: p.status < 400, status: p.status, text: async () => JSON.stringify(p.body), json: async () => p.body, headers: new Headers(), _init: init };
    }
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  });
}

describe('create-proappstore-app — end-to-end evaluations', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  for (const c of fixture.cases) {
    it(`${c.id}: ${c.title}`, async () => {
      applyMocks(c.mocks);
      const session = c.mocks.session === null ? { userId: null, login: null, token: null } : { userId: 'u1', login: 'alice', token: 'tok-1', roles: ['user'] };
      const tool = register(c.mocks.readOnly === true, session);
      const run = async (args: Record<string, unknown>) => {
        const p = tool({ ...fixture.input, ...args });
        // A rejection may land while the fake timers advance; keep it observed so
        // vitest does not report an unhandled error before `await p` sees it.
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(5000);
        return p;
      };
      if (c.expect.throwsContaining) {
        // The read-only gate throws before any timer is scheduled.
        await expect(tool({ ...fixture.input, ...c.args })).rejects.toThrow(c.expect.throwsContaining);
        if (c.expect.dryRunStillWorks) expect((await run({ dry_run: true })).content[0]!.text).toContain('create GitHub repo');
      } else {
        const out = (await run(c.args)).content[0]!.text;
        for (const s of c.expect.contains ?? []) expect(out, c.id).toContain(s);
        for (const r of c.expect.containsRegex ?? []) expect(out, c.id).toMatch(new RegExp(r));
        for (const s of c.expect.notContains ?? []) expect(out, c.id).not.toContain(s);
      }
      if (c.expect.createCalled !== undefined) expect(mockGh.createRepoFromTemplate.mock.calls.length > 0, `${c.id}: createCalled`).toBe(c.expect.createCalled);
      const provCall = mockFetch.mock.calls.find((call) => String(call[0]).includes('/v1/provision'));
      if (c.expect.provisionCalled !== undefined) expect(Boolean(provCall), `${c.id}: provisionCalled`).toBe(c.expect.provisionCalled);
      if (c.expect.provisionBody || c.expect.provisionBodyLacks) {
        const body = JSON.parse((provCall![1] as RequestInit).body as string);
        if (c.expect.provisionBody) expect(body).toMatchObject(c.expect.provisionBody);
        for (const k of c.expect.provisionBodyLacks ?? []) expect(body[k], `${c.id}: body.${k}`).toBeUndefined();
      }
    });
  }

  it('the fixture covers every blocker class the skill documents', () => {
    const blockers = new Set(fixture.cases.filter((c) => c.class === 'blocker').map((c) => c.blocker));
    for (const b of ['credentials', 'ownership', 'template', 'compliance']) expect(blockers.has(b), b).toBe(true);
  });
});
