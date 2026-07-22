import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64decode, b64encode, makeGitHub } from './github.ts';
import { verifyAppOwnership } from './ownership.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { status = 200, body = {} } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('b64 (utf-8 safe)', () => {
  it('round-trips unicode', () => {
    const s = 'héllo — 世界 🚀';
    expect(b64decode(b64encode(s))).toBe(s);
  });
});

describe('makeGitHub', () => {
  it('sends auth + org-scoped repo create', async () => {
    let seenUrl = ''; let seenAuth = '';
    mockFetch((url, init) => {
      seenUrl = url; seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      return { status: 201, body: { id: 1 } };
    });
    const gh = makeGitHub('tok123', 'proappstore-online');
    const r = await gh.createRepo('my-app', { description: 'x' });
    expect(r.ok).toBe(true);
    expect(seenUrl).toBe('https://api.github.com/orgs/proappstore-online/repos');
    expect(seenAuth).toBe('Bearer tok123');
  });

  it('getFile decodes content', async () => {
    mockFetch(() => ({ body: { sha: 'abc', content: b64encode('hello world') } }));
    const gh = makeGitHub('t', 'org');
    const f = await gh.getFile('app', 'README.md');
    expect(f.ok).toBe(true);
    expect(f.sha).toBe('abc');
    expect(f.content).toBe('hello world');
  });

  it('pushFiles runs tree(inline content)→commit→ref on an existing repo', async () => {
    const calls: string[] = [];
    let treeBody: unknown;
    mockFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`);
      if (url.endsWith('/git/ref/heads/main')) return { body: { object: { sha: 'parent' } } };
      if (url.endsWith('/git/commits/parent')) return { body: { tree: { sha: 'basetree' } } };
      if (url.endsWith('/git/trees')) { treeBody = init?.body ? JSON.parse(init.body as string) : undefined; return { body: { sha: 'tree1' } }; }
      if (url.endsWith('/git/commits')) return { body: { sha: 'commit1' } };
      if (url.endsWith('/git/refs/heads/main')) return { body: { ref: 'refs/heads/main' } };
      return { body: {} };
    });
    const gh = makeGitHub('t', 'org');
    const res = await gh.pushFiles('app', [{ path: 'a.ts', content: 'x' }], 'msg');
    expect(res.ok).toBe(true);
    expect(res.commitSha).toBe('commit1');
    // No per-file blob POSTs (they trip GitHub's secondary rate limit); content is
    // embedded inline in the tree request instead.
    expect(calls.some((c) => c.endsWith('/git/blobs'))).toBe(false);
    expect((treeBody as { tree: { path: string; content: string }[] }).tree[0]).toMatchObject({ path: 'a.ts', content: 'x' });
    expect(calls.some((c) => c.startsWith('PATCH') && c.endsWith('/git/refs/heads/main'))).toBe(true);
  });

  it('pushFiles refuses an empty repo unless initIfEmpty', async () => {
    mockFetch((url) => (url.endsWith('/git/ref/heads/main') ? { status: 404, body: {} } : { body: {} }));
    const gh = makeGitHub('t', 'org');
    const res = await gh.pushFiles('app', [{ path: 'a.ts', content: 'x' }], 'msg');
    expect(res.ok).toBe(false);
  });

  it('pushFiles seeds an empty repo with initIfEmpty, then commits on the seeded ref', async () => {
    let refReads = 0;
    mockFetch((url, init) => {
      if (url.endsWith('/git/ref/heads/main') && (init?.method ?? 'GET') === 'GET') {
        refReads++;
        return refReads === 1 ? { status: 404, body: {} } : { body: { object: { sha: 'seeded' } } };
      }
      if (url.endsWith('/contents/README.md')) return { status: 201, body: { commit: { sha: 'seeded' } } };
      if (url.endsWith('/git/commits/seeded')) return { body: { tree: { sha: 'basetree' } } };
      if (url.endsWith('/git/blobs')) return { body: { sha: 'b' } };
      if (url.endsWith('/git/trees')) return { body: { sha: 't' } };
      if (url.endsWith('/git/commits')) return { body: { sha: 'c' } };
      if (url.endsWith('/git/refs/heads/main')) return { body: { ref: 'refs/heads/main' } };
      return { body: {} };
    });
    const gh = makeGitHub('t', 'org');
    const res = await gh.pushFiles('app', [{ path: 'a.ts', content: 'x' }], 'msg', { initIfEmpty: true });
    expect(res.ok).toBe(true);
    expect(res.commitSha).toBe('c');
    expect(refReads).toBeGreaterThanOrEqual(2); // initial 404 + at least one poll
  });

  it('deployResult ignores advisory compliance failures when the deploy gate is green', async () => {
    const sha = 'a'.repeat(40);
    mockFetch((url) => {
      expect(url).toContain(`head_sha=${sha}`);
      return {
        body: {
          workflow_runs: [
            {
              id: 1,
              name: 'Platform Compliance',
              path: '.github/workflows/compliance.yml',
              status: 'completed',
              conclusion: 'failure',
              head_sha: sha,
              html_url: 'https://runs/compliance',
            },
            {
              id: 2,
              name: 'Deploy to R2',
              path: '.github/workflows/deploy.yml',
              status: 'completed',
              conclusion: 'success',
              head_sha: sha,
              html_url: 'https://runs/deploy',
            },
          ],
        },
      };
    });
    const gh = makeGitHub('t', 'org');
    const res = await gh.deployResult('interns', { sha });
    expect(res).toMatchObject({
      ok: true,
      status: 'completed',
      conclusion: 'success',
      sha: sha.slice(0, 7),
      url: 'https://runs/deploy',
    });
  });

  it('deployResult still blocks when the deploy gate fails', async () => {
    const sha = 'b'.repeat(40);
    mockFetch((url) => {
      if (url.endsWith('/actions/runs/2/jobs')) return { body: { jobs: [] } };
      return {
        body: {
          workflow_runs: [
            {
              id: 1,
              name: 'Platform Compliance',
              path: '.github/workflows/compliance.yml',
              status: 'completed',
              conclusion: 'success',
              head_sha: sha,
              html_url: 'https://runs/compliance',
            },
            {
              id: 2,
              name: 'Deploy to R2',
              path: '.github/workflows/deploy.yml',
              status: 'completed',
              conclusion: 'failure',
              head_sha: sha,
              html_url: 'https://runs/deploy',
            },
          ],
        },
      };
    });
    const gh = makeGitHub('t', 'org');
    const res = await gh.deployResult('interns', { sha });
    expect(res).toMatchObject({
      ok: false,
      status: 'completed',
      conclusion: 'failure',
      sha: sha.slice(0, 7),
      url: 'https://runs/deploy',
    });
  });

  it('deployResult stays pending when only advisory workflows exist for a commit', async () => {
    const sha = 'c'.repeat(40);
    mockFetch(() => ({
      body: {
        workflow_runs: [
          {
            id: 1,
            name: 'Platform Compliance',
            path: '.github/workflows/compliance.yml',
            status: 'completed',
            conclusion: 'success',
            head_sha: sha,
            html_url: 'https://runs/compliance',
          },
        ],
      },
    }));
    const gh = makeGitHub('t', 'org');
    const res = await gh.deployResult('interns', { sha, waitMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('pending');
    expect(res.errorTail).toContain('no deploy workflow run registered');
  });

  it('grades the NEWEST deploy run — a green re-run overrides an earlier failed attempt', async () => {
    const sha = 'd'.repeat(40);
    mockFetch(() => ({
      body: {
        workflow_runs: [
          { id: 1, name: 'Deploy to R2', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'failure', head_sha: sha, html_url: 'https://runs/deploy-1' },
          { id: 5, name: 'Deploy to R2', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success', head_sha: sha, html_url: 'https://runs/deploy-5' },
        ],
      },
    }));
    const gh = makeGitHub('t', 'org');
    const res = await gh.deployResult('interns', { sha });
    expect(res).toMatchObject({ ok: true, status: 'completed', conclusion: 'success', url: 'https://runs/deploy-5' });
  });

  it('does not fail a commit whose only deploy run was cancelled (superseded → pending)', async () => {
    const sha = 'e'.repeat(40);
    mockFetch(() => ({
      body: {
        workflow_runs: [
          { id: 1, name: 'Deploy to R2', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'cancelled', head_sha: sha, html_url: 'https://runs/deploy-1' },
        ],
      },
    }));
    const gh = makeGitHub('t', 'org');
    const res = await gh.deployResult('interns', { sha });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('pending');
    expect(res.conclusion).toBeUndefined();
  });
});

describe('verifyAppOwnership', () => {
  it('true only when the caller is the OWNER of the app', async () => {
    mockFetch(() => ({ body: { apps: [{ id: 'mine', team_role: 'owner' }, { id: 'other', team_role: 'owner' }] } }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(true);
  });
  it('false for a non-owner team member (membership is NOT ownership) — #78/#79 class', async () => {
    for (const role of ['viewer', 'po', 'developer', 'admin']) {
      mockFetch(() => ({ body: { apps: [{ id: 'mine', team_role: role }] } }));
      expect(await verifyAppOwnership('https://api', 'tok', 'mine'), role).toBe(false);
    }
  });
  it('false when the app is absent, or team_role is missing (fail closed)', async () => {
    mockFetch(() => ({ body: { apps: [{ id: 'other', team_role: 'owner' }] } }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(false);
    mockFetch(() => ({ body: { apps: [{ id: 'mine' }] } }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(false);
  });
  it('false on API error', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(false);
  });
});
