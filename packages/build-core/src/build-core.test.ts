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

  it('pushFiles runs blobs→tree→commit→ref on an existing repo', async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`);
      if (url.endsWith('/git/ref/heads/main')) return { body: { object: { sha: 'parent' } } };
      if (url.endsWith('/git/commits/parent')) return { body: { tree: { sha: 'basetree' } } };
      if (url.endsWith('/git/blobs')) return { body: { sha: 'blob1' } };
      if (url.endsWith('/git/trees')) return { body: { sha: 'tree1' } };
      if (url.endsWith('/git/commits')) return { body: { sha: 'commit1' } };
      if (url.endsWith('/git/refs/heads/main')) return { body: { ref: 'refs/heads/main' } };
      return { body: {} };
    });
    const gh = makeGitHub('t', 'org');
    const res = await gh.pushFiles('app', [{ path: 'a.ts', content: 'x' }], 'msg');
    expect(res.ok).toBe(true);
    expect(res.commitSha).toBe('commit1');
    expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/git/blobs'))).toBe(true);
    expect(calls.some((c) => c.startsWith('PATCH') && c.endsWith('/git/refs/heads/main'))).toBe(true);
  });

  it('pushFiles refuses an empty repo unless initIfEmpty', async () => {
    mockFetch((url) => (url.endsWith('/git/ref/heads/main') ? { status: 404, body: {} } : { body: {} }));
    const gh = makeGitHub('t', 'org');
    const res = await gh.pushFiles('app', [{ path: 'a.ts', content: 'x' }], 'msg');
    expect(res.ok).toBe(false);
  });
});

describe('verifyAppOwnership', () => {
  it('true when the app is in the user\'s apps', async () => {
    mockFetch(() => ({ body: { apps: [{ id: 'mine' }, { id: 'other' }] } }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(true);
  });
  it('false when not owned', async () => {
    mockFetch(() => ({ body: { apps: [{ id: 'other' }] } }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(false);
  });
  it('false on API error', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    expect(await verifyAppOwnership('https://api', 'tok', 'mine')).toBe(false);
  });
});
