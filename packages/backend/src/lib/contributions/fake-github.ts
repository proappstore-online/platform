import type { GhCommitSummary, GhFailure, GhFile, GhRepo, GitHubSource } from './github.js';

/**
 * A deterministic in-memory GitHub for tests (#546). It serves a scripted history, paginated like the real API
 * (newest first, `sha=` pins the listing to a head), counts every call, and can be told to fail. No network, no
 * synthetic commits in any real repository.
 */
export interface FakeCommit extends Omit<GhCommitSummary, 'authoredAt'> { authoredAt?: number; files: GhFile[]; truncated?: boolean }

export class FakeGitHub implements GitHubSource {
  repo: GhRepo;
  /** Newest first. */
  history: FakeCommit[] = [];
  /** Next call(s) fail with this, then it clears. */
  failNext: GhFailure[] = [];
  calls = { getRepo: 0, listCommits: 0, getCommitFiles: 0 };
  fileCalls: string[] = [];

  constructor(repo: Partial<GhRepo> = {}) {
    this.repo = { id: 1001, ownerId: 1, fullName: 'proappstore-online/demo', defaultBranch: 'main', ...repo };
  }

  private failure(): GhFailure | null { return this.failNext.shift() ?? null; }

  async getRepo() {
    this.calls.getRepo++;
    return this.failure() ?? { ok: true as const, repo: { ...this.repo } };
  }

  async listCommits(_id: number, _name: string, ref: string, page: number, perPage: number) {
    this.calls.listCommits++;
    const f = this.failure();
    if (f) return f;
    const start = ref === this.repo.defaultBranch ? 0 : Math.max(0, this.history.findIndex((c) => c.sha === ref));
    const slice = this.history.slice(start);
    const from = (page - 1) * perPage;
    const commits = slice.slice(from, from + perPage).map(({ files: _f, truncated: _t, authoredAt, ...c }): GhCommitSummary => ({ ...c, authoredAt: authoredAt ?? 1_700_000_000_000 }));
    return { ok: true as const, commits, hasNext: from + perPage < slice.length };
  }

  async getCommitFiles(_id: number, _name: string, sha: string) {
    this.calls.getCommitFiles++;
    this.fileCalls.push(sha);
    const f = this.failure();
    if (f) return f;
    const c = this.history.find((x) => x.sha === sha);
    return { ok: true as const, files: c?.files ?? [], truncated: c?.truncated ?? false };
  }
}

let seq = 0;
export function commit(over: Partial<FakeCommit> & { adds?: number; dels?: number } = {}): FakeCommit {
  const { adds = 10, dels = 0, ...rest } = over;
  const n = ++seq;
  return {
    sha: `c${String(n).padStart(6, '0')}`,
    parentCount: 1,
    authorId: 501,
    authorLogin: 'ada',
    authorType: 'user',
    message: `change ${n}`,
    files: [{ filename: `src/f${n}.ts`, additions: adds, deletions: dels, patch: '@@' }],
    ...rest,
  };
}
