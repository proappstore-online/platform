import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for project-tools helper logic. Since registerProjectTools registers
 * tools on an McpServer instance (which we can't easily instantiate in unit
 * tests), we test the extracted helper functions by importing them indirectly
 * through the tool registration.
 *
 * Strategy: mock makeGitHub + verifyAppOwnership + fetch, call
 * registerProjectTools with a fake McpServer that captures handlers,
 * then invoke the handlers directly.
 */

// Mock build-core
const mockGh = {
  api: vi.fn(),
  createRepoFromTemplate: vi.fn(),
  repoExists: vi.fn(),
  getFile: vi.fn(),
  putFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
  searchCode: vi.fn(),
  pushFiles: vi.fn(),
  pullText: vi.fn(),
  getDeployStatus: vi.fn(),
  setRepoVariable: vi.fn(),
};
vi.mock('@proappstore/build-core', async (importOriginal) => ({
  // #178: keep the real template catalogue + selection contract; mock only the
  // GitHub client and the ownership check.
  ...(await importOriginal<typeof import('@proappstore/build-core')>()),
  makeGitHub: () => mockGh,
  verifyAppOwnership: vi.fn(),
}));

const { verifyAppOwnership } = await import('@proappstore/build-core');
const mockOwnership = vi.mocked(verifyAppOwnership);

// Mock fetch for provision calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/**
 * Keep receipt traffic separate from the provision mock. Existing unit tests
 * deliberately mock only /v1/provision; this small in-memory service models
 * the durable backend contract while the route tests cover its D1 SQL.
 */
type Operation = {
  receipt: string;
  appId: string;
  status: 'pending' | 'completed' | 'failed' | 'exhausted';
  steps: any[];
  attemptId: string;
  joined?: boolean;
  /** Synthetic failed-receipt recovery for adversarial retry tests. */
  retryOnPost?: boolean;
};
const operations = new Map<string, Operation>();
let nextReceipt = 1;
async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const match = url.match(/\/v1\/provision-operations(?:\/([^/?]+))?$/);
  if (!match) return globalThis.fetch(input, init);
  const appId = match[1] ? decodeURIComponent(match[1]) : JSON.parse(String(init?.body ?? '{}')).appId;
  if (init?.method === 'POST') {
    const existing = operations.get(appId);
    if (existing?.retryOnPost) {
      existing.retryOnPost = false;
      existing.status = 'pending';
      existing.attemptId = `attempt-retry-${nextReceipt++}`;
      return new Response(JSON.stringify({ ...existing, joined: false }), { status: 200 });
    }
    if (existing) return new Response(JSON.stringify({ ...existing, joined: true }), { status: 200 });
    const operation: Operation = { receipt: `receipt-${nextReceipt++}`, appId, status: 'pending', steps: [], attemptId: `attempt-${nextReceipt}`, joined: false };
    operations.set(appId, operation);
    return new Response(JSON.stringify(operation), { status: 201 });
  }
  const operation = operations.get(appId);
  if (!operation) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  if (init?.method === 'PATCH') {
    const body = JSON.parse(String(init.body ?? '{}')) as Partial<Operation>;
    if (body.status) operation.status = body.status;
    if (body.steps) {
      const merged = new Map(operation.steps.map((step: any) => [step.name, step]));
      for (const step of body.steps) merged.set(step.name, step);
      operation.steps = [...merged.values()];
    }
  }
  return new Response(JSON.stringify(operation), { status: 200 });
}

// Fake McpServer that captures tool handlers
type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
const tools = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
    tools.set(name, handler);
  },
};

// Import and register
const { registerProjectTools } = await import('./project-tools.js');

const svc = { fetch: apiFetch } as unknown as Fetcher;

const env = {
  GITHUB_ORG: 'test-org',
  GITHUB_TOKEN: 'gh-tok',
  API_BASE: 'https://api.test.com',
  API: svc,
  ADMIN: svc,
  HOST: svc,
  INTERNAL_TOKEN: 'internal-secret',
};

let userCtx: { userId: string | null; login?: string | null; token: string | null; roles?: string[] } = {
  userId: 'u1',
  login: 'alice',
  token: 'tok-1',
};
registerProjectTools(fakeServer as any, env, () => userCtx);

function getText(result: { content: { type: string; text: string }[] }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  operations.clear();
  nextReceipt = 1;
  userCtx = { userId: 'u1', login: 'alice', token: 'tok-1' };
  mockOwnership.mockResolvedValue(true);
  mockGh.pullText.mockResolvedValue({ ok: true, sha: 'head', files: {} });
});

/**
 * The template-app files that carry APPNAME (#205), including the workflow the
 * old hard-coded allow-list missed. Deliberately includes a file no list named.
 */
const TEMPLATE_FILES: Record<string, string> = {
  '.github/workflows/compliance.yml': 'jobs:\n  build:\n    steps:\n      - run: pnpm --filter @APPNAME/web build\n',
  'CLAUDE.md': '# APPNAME\nSubdomain: APPNAME.proappstore.online',
  'README.md': '# APPNAME',
  'package.json': '{"name":"APPNAME"}',
  'web/index.html': '<title>APPNAME</title>',
  'web/package.json': '{"name":"@APPNAME/web"}',
  'web/src/App.tsx': "initPro({ appId: 'APPNAME' })",
  'web/vite.config.ts': "base: '/APPNAME/'",
  'web/src/some-future-file.ts': "export const id = 'APPNAME';",
  'LICENSE': 'MIT',
};

/** A stateful app repo: pullText reads what pushFiles last wrote. */
function fakeRepo(initial: Record<string, string> = TEMPLATE_FILES, opts: { dropWrites?: boolean } = {}) {
  const files = { ...initial };
  mockGh.pullText.mockImplementation(async () => ({ ok: true, sha: 'head', files: { ...files } }));
  mockGh.pushFiles.mockImplementation(async (_id: string, changed: { path: string; content: string }[]) => {
    if (!opts.dropWrites) for (const f of changed) files[f.path] = f.content;
    return { ok: true, commitSha: 'abcdef1234567890' };
  });
  return files;
}
const withPlaceholder = (files: Record<string, string>) => Object.keys(files).filter((path) => files[path]!.includes('APPNAME'));

describe('provision_pas_app — template selection contract (#178)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const args = { app_id: 'school-clubs', name: 'School Clubs', description: 'Coordinate school clubs.' };
  const run = async (extra: Record<string, unknown> = {}) => {
    const p = tools.get('provision_pas_app')!({ confirm: true, verify: false, ...args, ...extra });
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  };
  const okProvision = () => mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ success: true, steps: [] })) });

  it('refuses an unknown template before any GitHub or provisioning call, even in dry_run', async () => {
    const out = getText(await tools.get('provision_pas_app')!({ ...args, template_repo: 'evil-template', dry_run: true }));
    expect(out).toContain('Refused: unknown template "evil-template"');
    expect(out).toContain('template-app');
    expect(out).toContain('list_templates');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a non-admin override of an unknown template', async () => {
    const out = getText(await run({ template_repo: 'evil-template', allow_unapproved_template: true }));
    expect(out).toContain('Refused');
    expect(out).toContain('requires a platform admin session');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  it('shows the template, its status and reviewed commit in the dry-run plan', async () => {
    const out = getText(await tools.get('provision_pas_app')!({ ...args, dry_run: true }));
    expect(out).toMatch(/template: template-app \(test-org\/template-app@main, approved, reviewed commit [0-9a-f]{7}\)/);
  });

  it('records the copied template revision and forwards template + rev to /v1/provision', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.api.mockResolvedValue({ ok: true, status: 200, data: { sha: 'd8c2e08f32b8e30847b27c7092fd4b0e64341d2f' } });
    okProvision();
    const out = getText(await run());
    expect(mockGh.api).toHaveBeenCalledWith('/repos/test-org/template-app/commits/main');
    expect(out).toContain('+ Template revision: template-app@d8c2e08f32b8');
    const body = JSON.parse((mockFetch.mock.calls.find((c) => String(c[0]).includes('/v1/provision'))![1] as RequestInit).body as string);
    expect(body).toMatchObject({ template: 'template-app', templateRev: 'd8c2e08f32b8e30847b27c7092fd4b0e64341d2f' });
    expect(body).toMatchObject({ provisionReceipt: expect.stringMatching(/^receipt-/), provisionAttemptId: expect.stringMatching(/^attempt-/) });
    expect(body.allowUnapprovedTemplate).toBeUndefined();
  });

  it('never invents a revision: an unresolved head is reported as unknown and omitted from the payload', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.api.mockResolvedValue({ ok: false, status: 500, data: {} });
    okProvision();
    const out = getText(await run());
    expect(out).toContain('~ Template revision: could not resolve');
    const body = JSON.parse((mockFetch.mock.calls.find((c) => String(c[0]).includes('/v1/provision'))![1] as RequestInit).body as string);
    expect(body.template).toBe('template-app');
    expect(body.templateRev).toBeUndefined();
  });

  it('scaffold_app forwards the default template and its revision too', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.api.mockResolvedValue({ ok: true, status: 200, data: { sha: 'abc1234' } });
    okProvision();
    const p = tools.get('scaffold_app')!({ ...args, confirm: true });
    await vi.advanceTimersByTimeAsync(10000);
    await p;
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/v1/provision'));
    expect(call).toBeDefined();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ template: 'template-app', templateRev: 'abc1234' });
  });
});

describe('provision_pas_app', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const args = {
    app_id: 'school-clubs',
    name: 'School Clubs',
    description: 'Coordinate school clubs.',
  };

  async function runProvisionPas(extra: Record<string, unknown> = {}) {
    const p = tools.get('provision_pas_app')!({ confirm: true, verify: false, ...args, ...extra });
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }

  it('previews the full operator workflow without mutating', async () => {
    const result = await tools.get('provision_pas_app')!({ ...args, dry_run: true });
    const out = getText(result);

    expect(out).toContain('create GitHub repo test-org/school-clubs');
    expect(out).toContain('call /v1/provision');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requires confirm before creating repo or infra', async () => {
    const result = await tools.get('provision_pas_app')!(args);
    expect(getText(result)).toContain('Refused');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  it('creates a private template repo, patches placeholders, provisions infra, and reports links', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: { id: 1 } });
    const repo = fakeRepo({ 'package.json': '{"name":"APPNAME"}', 'web/src/App.tsx': "initPro({ appId: 'APPNAME' })" });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        success: true,
        appUrl: 'https://school-clubs.proappstore.online',
        dataWorkerUrl: 'https://data-school-clubs.proappstore.online',
        steps: [
          { name: 'route', status: 'ok', detail: 'school-clubs.proappstore.online -> apps/school-clubs/' },
          { name: 'create_d1', status: 'ok', detail: 'pas-data-school-clubs (db-1)' },
        ],
      }),
    });

    const result = await runProvisionPas();
    const out = getText(result);

    expect(mockGh.createRepoFromTemplate).toHaveBeenCalledWith('school-clubs', {
      template: 'template-app',
      description: 'Coordinate school clubs.',
      private: true,
    });
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
    expect(mockGh.pushFiles).toHaveBeenCalledWith(
      'school-clubs',
      [
        { path: 'package.json', content: '{"name":"school-clubs"}' },
        { path: 'web/src/App.tsx', content: "initPro({ appId: 'school-clubs' })" },
      ],
      'chore: configure school-clubs template',
      { initIfEmpty: false },
    );
    expect(withPlaceholder(repo)).toEqual([]);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      appId: 'school-clubs',
      skipCompliance: false,
      repoOwner: 'test-org',
      repoName: 'school-clubs',
    });
    expect(out).toContain('PAS app provisioned');
    expect(out).toContain('Provisioning receipt: receipt-1');
    expect(out).toContain('Repo: https://github.com/test-org/school-clubs');
    expect(out).toContain('+ Template placeholders: replaced APPNAME in 2 file(s)');
    expect(out).toContain('+ route');
  });

  it('joins an interrupted in-progress bootstrap and exposes one eventual durable receipt (#358)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: { id: 1 } });
    fakeRepo({ 'package.json': '{"name":"APPNAME"}' });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, steps: [{ name: 'compliance', status: 'ok', detail: 'passed' }] }),
    });

    // The first client disconnects while GitHub's template copy is still in
    // progress. Its server task continues; a retry must not attempt a second
    // create or turn the first configuration commit into an "edited orphan".
    const first = tools.get('provision_pas_app')!({ confirm: true, verify: false, ...args });
    await vi.advanceTimersByTimeAsync(0);
    const retry = await tools.get('provision_pas_app')!({ confirm: true, verify: false, ...args });
    expect(getText(retry)).toContain('no second GitHub bootstrap was started');
    expect(getText(retry)).toContain('Receipt: receipt-1');
    expect(getText(retry)).toContain('Provisioning status: pending');
    expect(mockGh.createRepoFromTemplate).toHaveBeenCalledTimes(1);
    expect(operations).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    await first;
    expect(operations.get('school-clubs')?.status).toBe('completed');
    const status = await tools.get('provisioning_status')!({ app_id: 'school-clubs' });
    expect(getText(status)).toContain('Provisioning status: completed');
    expect(getText(status)).toContain('config_committed');
  });

  it('reports an exhausted receipt as terminal with no active worker (#358)', async () => {
    operations.set('school-clubs', {
      receipt: 'receipt-exhausted',
      appId: 'school-clubs',
      status: 'exhausted',
      steps: [],
      attemptId: 'attempt-exhausted',
      joined: true,
    });

    const out = getText(await tools.get('provision_pas_app')!({ confirm: true, verify: false, ...args }));

    expect(out).toContain('Provisioning status: exhausted');
    expect(out).toContain('exhausted its retry budget');
    expect(out).toContain('no worker is still making progress');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  describe('template placeholders (#205)', () => {
    const provisionOk = () => {
      mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: { id: 1 } });
      mockGh.setRepoVariable.mockResolvedValue({ ok: true, status: 200, data: {} });
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true, steps: [] }) });
    };

    it('leaves no APPNAME anywhere in the provisioned repo, the compliance workflow included', async () => {
      provisionOk();
      const repo = fakeRepo();

      const out = getText(await runProvisionPas());

      expect(withPlaceholder(repo)).toEqual([]);
      expect(repo['.github/workflows/compliance.yml']).toContain('pnpm --filter @school-clubs/web build');
      expect(repo['web/src/some-future-file.ts']).toBe("export const id = 'school-clubs';");
      expect(repo['LICENSE']).toBe('MIT');
      // Only files that carried the placeholder are rewritten.
      const pushed = (mockGh.pushFiles.mock.calls[0]![1] as { path: string }[]).map((f) => f.path);
      expect(pushed).not.toContain('LICENSE');
      expect(out).toContain('+ Template placeholders: replaced APPNAME in 9 file(s)');
      expect(out).toContain('PAS app provisioned');
    });

    it('fails the provision loudly when APPNAME survives the patch commit', async () => {
      provisionOk();
      fakeRepo(TEMPLATE_FILES, { dropWrites: true });

      const out = getText(await runProvisionPas());

      expect(out).toContain('! Template placeholders: APPNAME is still present in .github/workflows/compliance.yml');
      expect(out).toContain('PAS app provisioning finished with issues');
      expect(out).not.toContain('PAS app provisioned:');
    });

    it('fails the provision when the repo cannot be read to find placeholders', async () => {
      provisionOk();
      mockGh.pullText.mockResolvedValue({ ok: false, error: 'repo has no commits or is unreachable' });

      const out = getText(await runProvisionPas());

      expect(out).toContain('! Template placeholders: repo has no commits or is unreachable');
      expect(out).toContain('PAS app provisioning finished with issues');
      expect(mockGh.pushFiles).not.toHaveBeenCalled();
    });

    it('treats a truncated read as unverifiable rather than clean', async () => {
      provisionOk();
      mockGh.pullText.mockResolvedValue({ ok: true, sha: 'head', files: {}, truncated: true });

      const out = getText(await runProvisionPas());

      expect(out).toContain('! Template placeholders: the repo is too large to check every file');
      expect(out).toContain('PAS app provisioning finished with issues');
    });
  });

  it('blocks reuse of a repo whose app record belongs to another account', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'exists' } });
    mockGh.repoExists.mockResolvedValue(true);
    mockOwnership.mockResolvedValue(false);
    // #144: the record-state probe answers 403 → someone else's app.
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('not the app owner') });

    const result = await runProvisionPas({ app_id: 'manual-repo' });
    const out = getText(result);

    expect(out).toContain('already exists');
    expect(out).toContain('owned by another account');
    expect(out).toContain('choose a different app id');
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining('/v1/provision'));
  });

  it('adopts an orphaned repo (no app record, untouched template scaffold) for its non-admin caller (#144)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'exists' } });
    mockGh.repoExists.mockResolvedValue(true);
    mockOwnership.mockResolvedValue(false);
    mockGh.api.mockResolvedValue({ ok: true, status: 200, data: [{ sha: '0572725' }] }); // one commit
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/listing')) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('app not found') });
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ success: true, steps: [{ name: 'record_app', status: 'ok', detail: 'creator: alice' }] })),
        json: () => Promise.resolve({ success: true, steps: [] }),
      });
    });

    const result = await runProvisionPas({ app_id: 'school-clubs' });
    const out = getText(result);

    expect(out).toContain('no PAS app record (untouched template scaffold) — adopting it');
    expect(out).toContain('PAS app provisioned');
    expect(mockGh.api).toHaveBeenCalledWith('/repos/test-org/school-clubs/commits?per_page=2');
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('/v1/provision'));
  });

  it('refuses to adopt an orphaned repo that has commits beyond the scaffold (#144)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'exists' } });
    mockGh.repoExists.mockResolvedValue(true);
    mockOwnership.mockResolvedValue(false);
    mockGh.api.mockResolvedValue({ ok: true, status: 200, data: [{ sha: 'a' }, { sha: 'b' }] }); // two commits
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('app not found') });

    const result = await runProvisionPas({ app_id: 'school-clubs' });
    const out = getText(result);

    expect(out).toContain('commits beyond the template scaffold');
    expect(out).toContain('platform admin');
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining('/v1/provision'));
  });

  it('does not let forged repo_created receipt evidence adopt an edited orphan (#358)', async () => {
    // A receipt owner can PATCH progress evidence. Model a failed receipt that
    // is retried with attacker-controlled `repo_created: ok` evidence already
    // present; that evidence must not authorize repo adoption.
    operations.set('school-clubs', {
      receipt: 'receipt-forged',
      appId: 'school-clubs',
      status: 'failed',
      steps: [{ name: 'repo_created', status: 'ok', detail: 'forged progress evidence' }],
      attemptId: 'attempt-forged',
      retryOnPost: true,
    });
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'exists' } });
    mockGh.repoExists.mockResolvedValue(true);
    mockOwnership.mockResolvedValue(false);
    mockGh.api.mockResolvedValue({ ok: true, status: 200, data: [{ sha: 'a' }, { sha: 'b' }] });
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('app not found') });

    const result = await runProvisionPas({ app_id: 'school-clubs' });
    const out = getText(result);

    expect(out).toContain('commits beyond the template scaffold');
    expect(mockGh.api).toHaveBeenCalledWith('/repos/test-org/school-clubs/commits?per_page=2');
    // Refusal happens before configuration or downstream provisioning.
    expect(mockGh.pullText).not.toHaveBeenCalled();
    expect(mockGh.pushFiles).not.toHaveBeenCalled();
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining('/v1/provision'));
  });

  it('allows admins to reuse an existing unowned repo', async () => {
    userCtx = { userId: 'admin-1', token: 'tok-admin', roles: ['user', 'admin'] };
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'exists' } });
    mockGh.repoExists.mockResolvedValue(true);
    mockOwnership.mockResolvedValue(false);
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, steps: [{ name: 'route', status: 'skip', detail: 'already routed' }] }),
    });

    const result = await runProvisionPas({ app_id: 'manual-repo' });
    const out = getText(result);

    expect(out).toContain('GitHub repo: test-org/manual-repo already exists');
    expect(out).toContain('PAS app provisioned');
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('reports best-effort verification when requested', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: { id: 1 } });
    mockGh.repoExists.mockResolvedValue(true);
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.getDeployStatus.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        workflow_runs: [
          { name: 'Deploy to R2', status: 'in_progress', conclusion: null, updated_at: '2026-08-15T06:12:42Z' },
        ],
      },
    });
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          success: true,
          appUrl: 'https://school-clubs.proappstore.online',
          dataWorkerUrl: 'https://data-school-clubs.proappstore.online',
          steps: [],
        }),
      };
    });

    const result = await runProvisionPas({ verify: true });
    const out = getText(result);

    expect(out).toContain('+ Verify repo: https://github.com/test-org/school-clubs exists');
    expect(out).toContain('+ Verify provision: backend reported success');
    expect(out).toContain('~ Verify deploy: Deploy to R2 is in_progress');
    expect(out).toContain('~ Verify host: https://school-clubs.proappstore.online returned 404');
  });
});

describe('auth helpers', () => {
  it('returns auth error when no token', async () => {
    userCtx = { userId: null, token: null };
    const result = await tools.get('write_file')!({ app_id: 'x', path: 'a.txt', content: 'hi' });
    expect(getText(result)).toContain('authentication required');
  });

  it('returns ownership error when user does not own app', async () => {
    mockOwnership.mockResolvedValue(false);
    const result = await tools.get('read_file')!({ app_id: 'not-mine', path: 'a.txt' });
    expect(getText(result)).toContain("don't own");
    expect(getText(result)).toContain('not-mine');
  });

  it('caches ownership checks per user/app for 60 seconds', async () => {
    const cachedTools = new Map<string, Handler>();
    const cachedServer = { tool: (n: string, _d: string, _s: unknown, h: Handler) => { cachedTools.set(n, h); } };
    registerProjectTools(cachedServer as any, env, () => userCtx);
    mockGh.getFile.mockResolvedValue({ ok: true, status: 200, content: 'file body', sha: 'abc' });

    await cachedTools.get('read_file')!({ app_id: 'cached-app', path: 'README.md' });
    await cachedTools.get('read_file')!({ app_id: 'cached-app', path: 'README.md' });

    expect(mockOwnership).toHaveBeenCalledTimes(1);
  });
});

describe('scaffold_app', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function runScaffold(args: Record<string, unknown>) {
    // scaffold_app is a destructive tool — gated behind confirm: true.
    const p = tools.get('scaffold_app')!({ confirm: true, ...args });
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }

  it('creates repo and provisions', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ steps: [{ name: 'route', status: 'ok', detail: 'done' }] }),
    });

    const result = await runScaffold({ app_id: 'my-app', name: 'My App', description: 'test' });
    const out = getText(result);

    expect(out).toContain('my-app');
    expect(out).toContain('Repo created from template');
    expect(out).toContain('+ route: done');
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
  });

  it('replaces APPNAME in every template file, workflows included (#205)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ steps: [] }) });
    const repo = fakeRepo();

    const out = getText(await runScaffold({ app_id: 'chess', name: 'Chess', description: 'test' }));

    expect(withPlaceholder(repo)).toEqual([]);
    expect(repo['CLAUDE.md']).toBe('# chess\nSubdomain: chess.proappstore.online');
    expect(repo['.github/workflows/compliance.yml']).toContain('pnpm --filter @chess/web build');
    expect(out).toContain('+ Template placeholders: replaced APPNAME in 9 file(s)');
  });

  it('handles existing repo (422 + repoExists=true)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'exists' } });
    mockGh.repoExists.mockResolvedValue(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ steps: [] }),
    });

    const result = await runScaffold({ app_id: 'existing', name: 'Existing', description: 'test' });
    expect(getText(result)).toContain('already existed');
    // Should NOT set R2 vars on existing repos
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
  });

  it('returns error on real 422 (not exists)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 422, data: { message: 'validation' } });
    mockGh.repoExists.mockResolvedValue(false);

    const result = await runScaffold({ app_id: 'bad', name: 'Bad', description: 'test' });
    expect(getText(result)).toContain('Error creating repo');
  });

  it('returns error on non-422 failure', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 500, data: { message: 'server error' } });

    const result = await runScaffold({ app_id: 'fail', name: 'Fail', description: 'test' });
    expect(getText(result)).toContain('Error creating repo');
  });

  it('gives an actionable error on 404 (template repo not flagged as a template)', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: false, status: 404, data: { message: 'Not Found' } });

    const result = await runScaffold({ app_id: 'notmpl', name: 'NoTmpl', description: 'test' });
    const txt = getText(result);
    expect(txt).toContain('template');
    expect(txt).toContain('is_template=true');
  });

  it('requires auth', async () => {
    userCtx = { userId: null, token: null };
    const result = await runScaffold({ app_id: 'x', name: 'X', description: 'test' });
    expect(getText(result)).toContain('authentication required');
  });
});

describe('write_file', () => {
  it('creates a new file', async () => {
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.putFile.mockResolvedValue({ ok: true, status: 201, data: {} });

    const result = await tools.get('write_file')!({ app_id: 'app', path: 'src/App.tsx', content: 'hello' });
    expect(getText(result)).toBe('Created src/App.tsx');
  });

  it('updates an existing file', async () => {
    mockGh.getFile.mockResolvedValue({ ok: true, status: 200, sha: 'abc123' });
    mockGh.putFile.mockResolvedValue({ ok: true, status: 200, data: {} });

    const result = await tools.get('write_file')!({ app_id: 'app', path: 'src/App.tsx', content: 'updated' });
    expect(getText(result)).toBe('Updated src/App.tsx');
  });

  it('returns error on write failure', async () => {
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.putFile.mockResolvedValue({ ok: false, status: 409, data: { message: 'conflict' } });

    const result = await tools.get('write_file')!({ app_id: 'app', path: 'x.ts', content: 'y' });
    expect(getText(result)).toContain('Error writing x.ts');
  });
});

describe('read_file', () => {
  it('returns file content', async () => {
    mockGh.getFile.mockResolvedValue({ ok: true, status: 200, content: 'file body', sha: 'abc' });
    const result = await tools.get('read_file')!({ app_id: 'app', path: 'README.md' });
    expect(getText(result)).toBe('file body');
  });

  it('returns not found', async () => {
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    const result = await tools.get('read_file')!({ app_id: 'app', path: 'missing.txt' });
    expect(getText(result)).toContain('File not found');
  });
});

describe('delete_file', () => {
  it('deletes an existing file', async () => {
    mockGh.getFile.mockResolvedValue({ ok: true, status: 200, sha: 'sha1' });
    mockGh.deleteFile.mockResolvedValue({ ok: true, status: 200, data: {} });
    const result = await tools.get('delete_file')!({ app_id: 'app', path: 'old.ts', confirm: true });
    expect(getText(result)).toBe('Deleted old.ts');
  });

  it('returns not found when file does not exist', async () => {
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    const result = await tools.get('delete_file')!({ app_id: 'app', path: 'gone.ts', confirm: true });
    expect(getText(result)).toContain('File not found');
  });
});

describe('batch_write_files', () => {
  it('commits multiple files', async () => {
    mockGh.pushFiles.mockResolvedValue({ ok: true, commitSha: 'abc' });
    const result = await tools.get('batch_write_files')!({
      app_id: 'app',
      files: [{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }],
      message: 'add files',
    });
    const out = getText(result);
    expect(out).toContain('Committed 2 file(s)');
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
  });

  it('returns error on push failure', async () => {
    mockGh.pushFiles.mockResolvedValue({ ok: false, error: 'ref conflict' });
    const result = await tools.get('batch_write_files')!({
      app_id: 'app', files: [{ path: 'x', content: 'y' }], message: 'test',
    });
    expect(getText(result)).toContain('ref conflict');
  });
});

describe('.github/ is platform-managed (#280)', () => {
  const REFUSAL = '.github/ is platform-managed; workflows are generated by the publish flow';
  const noGitHubWrites = () => {
    expect(mockGh.getFile).not.toHaveBeenCalled();
    expect(mockGh.putFile).not.toHaveBeenCalled();
    expect(mockGh.deleteFile).not.toHaveBeenCalled();
    expect(mockGh.pushFiles).not.toHaveBeenCalled();
  };

  it.each([
    '.github/workflows/x.yml',
    './.github/workflows/x.yml',
    '/.github/workflows/x.yml',
    '.GITHUB/workflows/x.yml',
    '.github\\workflows\\x.yml',
    '.github//workflows/x.yml',
    '.github/actions/setup/action.yml',
  ])('write_file refuses %s as a tool error, with no GitHub call', async (path) => {
    const result = await tools.get('write_file')!({ app_id: 'app', path, content: 'on: push' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(REFUSAL);
    noGitHubWrites();
  });

  it('write_file refuses a ".." segment (src/../.github/workflows/x.yml), with no GitHub call', async () => {
    const result = await tools.get('write_file')!({ app_id: 'app', path: 'src/../.github/workflows/x.yml', content: 'x' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('".." segments');
    noGitHubWrites();
  });

  // Review of #283: spellings the URL parser or GitHub rewrites into
  // `.github/…` AFTER the check has looked at them. Each passed the first
  // version of refusedRepoPath and reached .github/workflows/x.yml.
  const BYPASSES: [string, string][] = [
    ['%2e/.github/workflows/x.yml', '"%"'],
    ['src/%2e%2e/.github/workflows/x.yml', '"%"'],
    ['src/%2E%2E/.github/workflows/x.yml', '"%"'],
    ['src/.%2e/.github/workflows/x.yml', '"%"'],
    ['%2egithub/workflows/x.yml', '"%"'],
    ['.github%2Fworkflows%2Fx.yml', '"%"'],
    ['src/..\t/.github/workflows/x.yml', 'control characters'],
    ['src/..\n/.github/workflows/x.yml', 'control characters'],
    ['src/..\r/.github/workflows/x.yml', 'control characters'],
  ];

  it.each(BYPASSES)('write_file refuses the encoded/control spelling %j, with no GitHub call', async (path, why) => {
    const result = await tools.get('write_file')!({ app_id: 'app', path, content: 'on: push' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(why);
    noGitHubWrites();
  });

  it.each(BYPASSES)('delete_file and batch_write_files refuse %j too', async (path, why) => {
    const del = await tools.get('delete_file')!({ app_id: 'app', path, confirm: true });
    expect(del.isError).toBe(true);
    expect(getText(del)).toContain(why);
    const batch = await tools.get('batch_write_files')!({
      app_id: 'app', files: [{ path: 'src/a.ts', content: 'a' }, { path, content: 'on: push' }], message: 'm',
    });
    expect(batch.isError).toBe(true);
    expect(getText(batch)).toContain(why);
    noGitHubWrites();
  });

  it('delete_file refuses .github/workflows/deploy.yml, even with confirm and dry_run', async () => {
    for (const extra of [{ confirm: true }, { dry_run: true }]) {
      const result = await tools.get('delete_file')!({ app_id: 'app', path: '.github/workflows/deploy.yml', ...extra });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain(REFUSAL);
    }
    noGitHubWrites();
  });

  it('batch_write_files with one .github/ path writes nothing at all', async () => {
    const result = await tools.get('batch_write_files')!({
      app_id: 'app',
      files: [{ path: 'src/a.ts', content: 'a' }, { path: '.github/workflows/x.yml', content: 'on: push' }],
      message: 'sneak a workflow in',
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(REFUSAL);
    expect(getText(result)).toContain('Nothing was written');
    noGitHubWrites();
  });

  it('still writes ordinary paths, including ones that merely contain "github"', async () => {
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.putFile.mockResolvedValue({ ok: true, status: 201, data: {} });
    for (const path of ['src/app.ts', 'docs/.github-notes.md', 'web/.github/not-root.md', 'docs/my notes/café ✓.md']) {
      const result = await tools.get('write_file')!({ app_id: 'app', path, content: 'x' });
      expect(result.isError).toBeUndefined();
      expect(getText(result)).toBe(`Created ${path}`);
    }
    mockGh.pushFiles.mockResolvedValue({ ok: true, commitSha: 'abc' });
    const batch = await tools.get('batch_write_files')!({
      app_id: 'app', files: [{ path: 'src/a.ts', content: 'a' }, { path: 'README.md', content: 'r' }], message: 'm',
    });
    expect(getText(batch)).toContain('Committed 2 file(s)');
  });
});

describe('provision_app', () => {
  it('calls provision API and returns formatted steps', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        steps: [
          { name: 'route', status: 'ok', detail: 'app.proappstore.online → apps/app/' },
          { name: 'create_d1', status: 'ok', detail: 'pas-data-app (uuid)' },
        ],
      }),
    });
    const result = await tools.get('provision_app')!({ app_id: 'app', confirm: true });
    const out = getText(result);
    expect(out).toContain('+ route');
    expect(out).toContain('+ create_d1');
  });

  it('handles provision network error', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const result = await tools.get('provision_app')!({ app_id: 'app', confirm: true });
    expect(getText(result)).toContain('provision error');
    expect(getText(result)).toContain('network down');
  });

  it('refuses to provision an app the caller does not own', async () => {
    mockOwnership.mockResolvedValue(false);
    // Unique app id — requireOwner caches per user/app for 60s across tests.
    const result = await tools.get('provision_app')!({ app_id: 'notown-prov', confirm: true });
    expect(getText(result)).toContain("don't own");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // #132: a live re-provision changes production infrastructure, so an operator
  // agent must get explicit approval, as with provision_pas_app and scaffold_app.
  it('refuses a live run without confirm: true, before calling the provision API', async () => {
    for (const confirm of [undefined, false]) {
      const result = await tools.get('provision_app')!({ app_id: 'app', confirm });
      expect(getText(result)).toContain('Refused: provision_app changes production infrastructure');
      expect(getText(result)).toContain('confirm: true');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checks ownership before the confirm gate, so a stranger learns nothing new', async () => {
    mockOwnership.mockResolvedValue(false);
    const result = await tools.get('provision_app')!({ app_id: 'notown-noconfirm' });
    expect(getText(result)).toContain("don't own");
    expect(getText(result)).not.toContain('Refused: provision_app');
  });

  it('dry_run still previews without confirm', async () => {
    const result = await tools.get('provision_app')!({ app_id: 'app', dry_run: true });
    expect(getText(result)).toContain('DRY RUN');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('publish_app', () => {
  const publishArgs = {
    app_id: 'chess-academy',
    name: 'Chess Academy',
    category: 'education',
    description: 'Online chess teaching platform.',
    confirm: true, // publish_app is destructive (public listing) — gated behind confirm
  };
  /** The admin publish call (the GitHub read of mcp.json precedes it). */
  const adminCall = () => mockFetch.mock.calls.find((c) => String(c[0]).endsWith('/api/publish-app'))!;

  it("#259: sends the repo mcp.json's visibility, so a private app's first publish is never listed", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, steps: [] }) });
    mockGh.getFile.mockResolvedValueOnce({ ok: true, status: 200, content: JSON.stringify({ tools: [], visibility: { mode: 'private', roles: ['viewer'] } }) });
    const out = getText(await tools.get('publish_app')!(publishArgs));
    expect(mockGh.getFile).toHaveBeenCalledWith('chess-academy', 'mcp.json');
    expect(JSON.parse(adminCall()[1].body).visibility).toBe('private');
    expect(out).toContain('Listing: none (private app)');

    mockFetch.mockClear();
    mockGh.getFile.mockResolvedValueOnce({ ok: true, status: 200, content: JSON.stringify({ tools: [] }) });
    await tools.get('publish_app')!(publishArgs);
    expect(JSON.parse(adminCall()[1].body).visibility).toBe('public');

    mockFetch.mockClear();
    mockGh.getFile.mockResolvedValueOnce({ ok: false, status: 502 });
    await tools.get('publish_app')!(publishArgs);
    // Unreadable: omitted, so the admin step reads the repo itself (and fails closed).
    expect(JSON.parse(adminCall()[1].body).visibility).toBeUndefined();
  });

  it('refuses to publish an app the caller does not own (no listing takeover)', async () => {
    mockOwnership.mockResolvedValue(false);
    // Unique app id — requireOwner caches per user/app for 60s, so reusing
    // chess-academy here would poison the other publish_app tests.
    const result = await tools.get('publish_app')!({ ...publishArgs, app_id: 'notown-pub' });
    expect(getText(result)).toContain("don't own");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('publishes successfully and returns formatted steps', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        steps: [
          { name: 'GitHub repo', status: 'ok', detail: 'created' },
          { name: 'R2 route', status: 'ok', detail: 'chess-academy.proappstore.online → apps/chess-academy/' },
          { name: 'Registry', status: 'ok', detail: 'Added Chess Academy' },
        ],
      }),
    });

    const result = await tools.get('publish_app')!(publishArgs);
    const out = getText(result);
    expect(out).toContain('Published: **Chess Academy**');
    expect(out).toContain('chess-academy.proappstore.online');
    expect(out).toContain('https://proappstore.online/app/chess-academy');
    expect(out).toContain('+ GitHub repo: created');
    expect(out).toContain('+ Registry: Added Chess Academy');

    // Verify it called admin.test.com (hostname replaced from api.test.com)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://admin.test.com/api/publish-app',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Internal-Token': 'internal-secret',
          'X-PAS-Login': 'alice',
        }),
      }),
    );
  });

  it('passes all fields to admin API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, steps: [] }),
    });

    await tools.get('publish_app')!({
      ...publishArgs,
      icon: '&#9822;',
      icon_bg: '#fef3c7',
      pro_features: ['Real-time games', 'Swiss tournaments'],
    });

    const body = JSON.parse(adminCall()[1].body);
    expect(body.id).toBe('chess-academy');
    expect(body.name).toBe('Chess Academy');
    expect(body.icon).toBe('&#9822;');
    expect(body.iconBg).toBe('#fef3c7');
    expect(body.proFeatures).toEqual(['Real-time games', 'Swiss tournaments']);
  });

  it('uses default icon and iconBg when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, steps: [] }),
    });

    await tools.get('publish_app')!(publishArgs);

    const body = JSON.parse(adminCall()[1].body);
    expect(body.icon).toBe('📦');
    expect(body.iconBg).toBe('#7c3aed');
    expect(body.proFeatures).toBeUndefined();
  });

  it('shows failure when admin returns success:false', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: false,
        steps: [
          { name: 'Validation', status: 'fail', detail: 'name is required' },
        ],
      }),
    });

    const result = await tools.get('publish_app')!(publishArgs);
    const out = getText(result);
    expect(out).toContain('Publish failed');
    expect(out).toContain('! Validation: name is required');
  });

  it('handles admin error response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'invalid or expired session' }),
    });

    const result = await tools.get('publish_app')!(publishArgs);
    expect(getText(result)).toContain('Error: invalid or expired session');
  });

  it('handles non-OK HTTP response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    const result = await tools.get('publish_app')!(publishArgs);
    expect(getText(result)).toContain('Error: admin API returned 500');
    expect(getText(result)).toContain('Internal Server Error');
  });

  it('handles network error', async () => {
    mockFetch.mockRejectedValue(new Error('DNS resolution failed'));

    const result = await tools.get('publish_app')!(publishArgs);
    expect(getText(result)).toContain('Error: publish failed');
    expect(getText(result)).toContain('DNS resolution failed');
  });

  it('requires auth', async () => {
    userCtx = { userId: null, token: null };
    const result = await tools.get('publish_app')!(publishArgs);
    expect(getText(result)).toContain('authentication required');
  });

  it('shows skip status for already-listed apps', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        steps: [
          { name: 'GitHub repo', status: 'skip', detail: 'already exists' },
          { name: 'R2 route', status: 'skip', detail: 'already routed' },
          { name: 'Registry', status: 'skip', detail: 'Already listed' },
        ],
      }),
    });

    const result = await tools.get('publish_app')!(publishArgs);
    const out = getText(result);
    expect(out).toContain('Published: **Chess Academy**');
    expect(out).toContain('~ Registry: Already listed');
  });
});

describe('search_files', () => {
  it('returns matching files', async () => {
    mockGh.searchCode.mockResolvedValue({
      ok: true, status: 200,
      data: { items: [{ path: 'src/App.tsx', text_matches: [{ fragment: 'const app = initPro' }] }] },
    });
    const result = await tools.get('search_files')!({ app_id: 'app', query: 'initPro' });
    const out = getText(result);
    expect(out).toContain('1 result(s)');
    expect(out).toContain('src/App.tsx');
    expect(out).toContain('initPro');
  });

  it('returns empty message when no matches', async () => {
    mockGh.searchCode.mockResolvedValue({ ok: true, status: 200, data: { items: [] } });
    const result = await tools.get('search_files')!({ app_id: 'app', query: 'notfound' });
    expect(getText(result)).toContain('No results');
  });
});

describe('get_deploy_status', () => {
  it('returns formatted workflow runs', async () => {
    mockGh.getDeployStatus.mockResolvedValue({
      ok: true, status: 200,
      data: { workflow_runs: [
        { name: 'Deploy to R2', conclusion: 'success', status: 'completed', updated_at: '2026-06-07' },
        { name: 'CI', conclusion: 'failure', status: 'completed', updated_at: '2026-06-07' },
      ] },
    });
    const result = await tools.get('get_deploy_status')!({ app_id: 'app' });
    const out = getText(result);
    expect(out).toContain('+ Deploy to R2');
    expect(out).toContain('! CI: failure');
  });

  it('returns message when no runs', async () => {
    mockGh.getDeployStatus.mockResolvedValue({ ok: true, status: 200, data: { workflow_runs: [] } });
    const result = await tools.get('get_deploy_status')!({ app_id: 'app' });
    expect(getText(result)).toContain('No workflow runs');
  });
});

describe('safety: destructive confirm gate', () => {
  it('delete_file refuses without confirm: true', async () => {
    const result = await tools.get('delete_file')!({ app_id: 'app', path: 'old.ts' });
    expect(getText(result)).toContain('Refused');
    expect(mockGh.deleteFile).not.toHaveBeenCalled();
  });

  it('scaffold_app refuses without confirm: true', async () => {
    const result = await tools.get('scaffold_app')!({ app_id: 'x', name: 'X', description: 't' });
    expect(getText(result)).toContain('Refused');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  it('publish_app refuses without confirm: true', async () => {
    const result = await tools.get('publish_app')!({ app_id: 'x', name: 'X', category: 'c', description: 'd' });
    expect(getText(result)).toContain('Refused');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('safety: dry-run', () => {
  it('scaffold_app dry_run previews without creating a repo or requiring confirm', async () => {
    const result = await tools.get('scaffold_app')!({ app_id: 'preview-app', name: 'Preview', description: 't', dry_run: true });
    const out = getText(result);
    expect(out).toContain('DRY RUN');
    expect(out).toContain('preview-app');
    expect(out).toContain('No changes were made');
    expect(mockGh.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  it('delete_file dry_run previews without deleting', async () => {
    const result = await tools.get('delete_file')!({ app_id: 'app', path: 'old.ts', dry_run: true });
    const out = getText(result);
    expect(out).toContain('DRY RUN');
    expect(out).toContain('old.ts');
    expect(mockGh.deleteFile).not.toHaveBeenCalled();
  });

  it('provision_app dry_run previews without calling the provision API', async () => {
    const result = await tools.get('provision_app')!({ app_id: 'app', dry_run: true });
    expect(getText(result)).toContain('DRY RUN');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('publish_app dry_run previews without calling the admin API', async () => {
    const result = await tools.get('publish_app')!({ app_id: 'chess-academy', name: 'Chess Academy', category: 'education', description: 'd', dry_run: true });
    const out = getText(result);
    expect(out).toContain('DRY RUN');
    expect(out).toContain('storefront registry');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('safety: read-only mode', () => {
  // Separate registration with MCP_READ_ONLY enabled.
  const roTools = new Map<string, Handler>();
  const roServer = { tool: (n: string, _d: string, _s: unknown, h: Handler) => { roTools.set(n, h); } };
  registerProjectTools(roServer as any, { ...env, MCP_READ_ONLY: '1' }, () => ({ userId: 'u1', token: 'tok-1' }));

  it('blocks a mutating tool (write_file) by throwing', async () => {
    mockOwnership.mockResolvedValue(true);
    await expect(roTools.get('write_file')!({ app_id: 'app', path: 'a.ts', content: 'x' }))
      .rejects.toThrow(/read-only/i);
    expect(mockGh.putFile).not.toHaveBeenCalled();
  });

  it('still allows a read tool (read_file)', async () => {
    mockOwnership.mockResolvedValue(true);
    mockGh.getFile.mockResolvedValue({ ok: true, status: 200, content: 'hello' });
    const result = await roTools.get('read_file')!({ app_id: 'app', path: 'README.md' });
    expect(getText(result)).toBe('hello');
  });
});
