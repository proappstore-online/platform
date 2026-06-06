import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchRepoFiles } = await import('./github-fetch.js');

function mockGitHubTree(blobs: { path: string; type: string }[]) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({
      sha: 'abc123',
      tree: blobs,
      truncated: false,
    }),
  } as Response);
}

function mockFileContent(content: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({
      content: btoa(content),
      encoding: 'base64',
    }),
  } as Response);
}

describe('fetchRepoFiles', () => {
  const loc = { owner: 'proappstore-online', repo: 'test-app', ref: 'main' };

  beforeEach(() => mockFetch.mockReset());

  it('fetches relevant files and skips non-relevant ones', async () => {
    mockGitHubTree([
      { path: 'LICENSE', type: 'blob' },
      { path: 'package.json', type: 'blob' },
      { path: 'web/src/App.tsx', type: 'blob' },
      { path: 'node_modules/react/index.js', type: 'blob' }, // skipped
      { path: '.git/config', type: 'blob' }, // skipped
    ]);
    mockFileContent('MIT License...');  // LICENSE
    mockFileContent('{}');              // package.json
    mockFileContent('export default function App() {}'); // App.tsx

    const result = await fetchRepoFiles(loc);
    expect(result.files.size).toBe(3);
    expect(result.files.has('LICENSE')).toBe(true);
    expect(result.files.has('package.json')).toBe(true);
    expect(result.files.has('web/src/App.tsx')).toBe(true);
    expect(result.skipped).toBe(2);
    expect(result.sha).toBe('abc123');
  });

  it('passes auth token in headers when provided', async () => {
    mockGitHubTree([]);
    await fetchRepoFiles(loc, 'ghp_test123');

    const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_test123');
  });

  it('works without auth token', async () => {
    mockGitHubTree([]);
    await fetchRepoFiles(loc);

    const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws on non-200 from tree endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    } as Response);

    await expect(fetchRepoFiles(loc)).rejects.toThrow(/404/);
  });

  it('skips individual files that fail to fetch', async () => {
    mockGitHubTree([
      { path: 'LICENSE', type: 'blob' },
      { path: 'package.json', type: 'blob' },
    ]);
    mockFileContent('MIT License');
    // package.json fetch fails
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const result = await fetchRepoFiles(loc);
    expect(result.files.size).toBe(1);
    expect(result.files.has('LICENSE')).toBe(true);
  });

  it('only includes tree entries of type blob', async () => {
    mockGitHubTree([
      { path: 'web/src', type: 'tree' },
      { path: 'LICENSE', type: 'blob' },
    ]);
    mockFileContent('MIT');

    const result = await fetchRepoFiles(loc);
    expect(result.files.size).toBe(1);
  });
});
