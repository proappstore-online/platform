import { expect, it, vi } from 'vitest';
import { githubSource } from './github.js';

it('reads by immutable id, encodes the ref and preserves authorship and pagination', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([
    { sha: 'abc', parents: [{}], author: { id: 42, login: 'robot[bot]', type: 'Bot' }, commit: { author: { date: '2026-01-01T00:00:00Z' }, message: 'change' } },
    { sha: 'def', parents: [], author: null, commit: { author: { date: '2026-01-02T00:00:00Z' } } },
  ]), { headers: { link: '<https://api.github.com/next>; rel="next"' } }));
  const result = await githubSource('synthetic', () => 1000, fetcher).listCommits(99, 'ignored/name', 'feature/a', 2, 100);
  expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repositories/99/commits?sha=feature%2Fa&per_page=100&page=2', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer synthetic' }) }));
  expect(result).toMatchObject({ ok: true, hasNext: true, commits: [{ sha: 'abc', authorId: 42, authorType: 'bot', parentCount: 1, authoredAt: Date.UTC(2026, 0, 1) }, { sha: 'def', authorId: null, authorType: 'unlinked' }] });
});

it('follows commit file pages and retains missing patches for policy exclusion', async () => {
  const batch = Array.from({ length: 100 }, () => ({ filename: 'src/a.ts', additions: 2, deletions: 1, patch: '@@' }));
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ files: batch })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ filename: 'image.png', additions: 0, deletions: 0 }] })));
  const result = await githubSource('synthetic', () => 1000, fetcher).getCommitFiles(99, 'ignored', 'abc');
  expect(result.ok && result.files).toHaveLength(101);
  expect(result).toMatchObject({ ok: true, truncated: false });
  expect(fetcher.mock.calls[1]![0]).toBe('https://api.github.com/repositories/99/commits/abc?per_page=100&page=2');
});

it.each([
  [401, {}, 'access_lost'], [403, {}, 'access_lost'], [404, {}, 'access_lost'],
  [429, { 'retry-after': '60' }, 'rate_limited'],
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' }, 'rate_limited'],
  [500, {}, 'transient'],
] as const)('classifies HTTP %s without returning provider bodies', async (status, headers, kind) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider body', { status, headers }));
  const result = await githubSource('synthetic', () => 1000, fetcher).getRepo('org/app');
  expect(result).toMatchObject({ ok: false, kind });
  expect(JSON.stringify(result)).not.toContain('private provider body');
  if (result.ok === false && result.kind === 'rate_limited') expect(result.retryAt).toBe(status === 429 ? 61_000 : 120_000);
});

it('reports network and invalid JSON failures as transient', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('private network details')).mockResolvedValueOnce(new Response('invalid'));
  const source = githubSource('synthetic', () => 1000, fetcher);
  expect(await source.getRepo('org/app')).toEqual({ ok: false, kind: 'transient', detail: 'network' });
  expect(await source.getRepo('org/app')).toEqual({ ok: false, kind: 'transient', detail: 'bad body' });
});
