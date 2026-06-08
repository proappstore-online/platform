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
  createRepoFromTemplate: vi.fn(),
  repoExists: vi.fn(),
  getFile: vi.fn(),
  putFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
  searchCode: vi.fn(),
  pushFiles: vi.fn(),
  getDeployStatus: vi.fn(),
  setRepoVariable: vi.fn(),
};
vi.mock('@proappstore/build-core', () => ({
  makeGitHub: () => mockGh,
  verifyAppOwnership: vi.fn(),
}));

const { verifyAppOwnership } = await import('@proappstore/build-core');
const mockOwnership = vi.mocked(verifyAppOwnership);

// Mock fetch for provision calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Fake McpServer that captures tool handlers
type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const tools = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
    tools.set(name, handler);
  },
};

// Import and register
const { registerProjectTools } = await import('./project-tools.js');

const env = {
  GITHUB_ORG: 'test-org',
  GITHUB_TOKEN: 'gh-tok',
  API_BASE: 'https://api.test.com',
  R2_ACCESS_KEY_ID: 'r2-ak',
  R2_SECRET_ACCESS_KEY: 'r2-sk',
  R2_ACCOUNT_ID: 'r2-acct',
};

let userCtx: { userId: string | null; token: string | null } = { userId: 'u1', token: 'tok-1' };
registerProjectTools(fakeServer as any, env, () => userCtx);

function getText(result: { content: { type: string; text: string }[] }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'u1', token: 'tok-1' };
  mockOwnership.mockResolvedValue(true);
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
});

describe('scaffold_app', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function runScaffold(args: Record<string, unknown>) {
    const p = tools.get('scaffold_app')!(args);
    await vi.advanceTimersByTimeAsync(5000);
    return p;
  }

  it('creates repo, sets R2 vars, provisions', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.setRepoVariable.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ steps: [{ name: 'route', status: 'ok', detail: 'done' }] }),
    });

    const result = await runScaffold({ app_id: 'my-app', name: 'My App', description: 'test' });
    const out = getText(result);

    expect(out).toContain('my-app');
    expect(out).toContain('Repo created from template');
    expect(out).toContain('R2 deploy credentials set');
    expect(out).toContain('+ route: done');
    expect(mockGh.setRepoVariable).toHaveBeenCalledTimes(3);
  });

  it('replaces APPNAME in template files', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockImplementation(async (_id: string, path: string) => {
      if (path === 'CLAUDE.md') return { ok: true, status: 200, content: '# APPNAME\nSubdomain: APPNAME.proappstore.online', sha: 'sha1' };
      return { ok: false, status: 404 };
    });
    mockGh.putFile.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.setRepoVariable.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ steps: [] }) });

    await runScaffold({ app_id: 'chess', name: 'Chess', description: 'test' });

    expect(mockGh.putFile).toHaveBeenCalledWith(
      'chess', 'CLAUDE.md',
      '# chess\nSubdomain: chess.proappstore.online',
      expect.stringContaining('replace APPNAME'),
      'sha1',
    );
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

  it('reports R2 credential errors', async () => {
    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockGh.setRepoVariable.mockResolvedValue({ ok: false, status: 403, data: {} });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ steps: [] }),
    });

    const result = await runScaffold({ app_id: 'r2fail', name: 'R2 Fail', description: 'test' });
    expect(getText(result)).toContain('Failed to set R2_ACCESS_KEY_ID');
  });

  it('requires auth', async () => {
    userCtx = { userId: null, token: null };
    const result = await runScaffold({ app_id: 'x', name: 'X', description: 'test' });
    expect(getText(result)).toContain('authentication required');
  });
});

describe('setR2Variables (via scaffold_app)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('skips when all R2 env vars are missing', async () => {
    const noR2Tools = new Map<string, Handler>();
    const noR2Server = { tool: (n: string, _d: string, _s: unknown, h: Handler) => { noR2Tools.set(n, h); } };
    registerProjectTools(noR2Server as any, { ...env, R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined, R2_ACCOUNT_ID: undefined }, () => userCtx);

    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ steps: [] }) });

    const p = noR2Tools.get('scaffold_app')!({ app_id: 'no-r2', name: 'No R2', description: 'test' });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await p;
    expect(getText(result)).toContain('R2 credentials not configured');
    expect(mockGh.setRepoVariable).not.toHaveBeenCalled();
  });

  it('reports partial config when only some R2 vars are set', async () => {
    const partialTools = new Map<string, Handler>();
    const partialServer = { tool: (n: string, _d: string, _s: unknown, h: Handler) => { partialTools.set(n, h); } };
    registerProjectTools(partialServer as any, { ...env, R2_SECRET_ACCESS_KEY: undefined }, () => userCtx);

    mockGh.createRepoFromTemplate.mockResolvedValue({ ok: true, status: 200, data: {} });
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ steps: [] }) });

    const p = partialTools.get('scaffold_app')!({ app_id: 'partial', name: 'P', description: 'test' });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await p;
    expect(getText(result)).toContain('partially configured');
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
    const result = await tools.get('delete_file')!({ app_id: 'app', path: 'old.ts' });
    expect(getText(result)).toBe('Deleted old.ts');
  });

  it('returns not found when file does not exist', async () => {
    mockGh.getFile.mockResolvedValue({ ok: false, status: 404 });
    const result = await tools.get('delete_file')!({ app_id: 'app', path: 'gone.ts' });
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
    const result = await tools.get('provision_app')!({ app_id: 'app' });
    const out = getText(result);
    expect(out).toContain('+ route');
    expect(out).toContain('+ create_d1');
  });

  it('handles provision network error', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const result = await tools.get('provision_app')!({ app_id: 'app' });
    expect(getText(result)).toContain('provision error');
    expect(getText(result)).toContain('network down');
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
