import { isBot } from './policy.js';

/**
 * The slice of GitHub the contribution ingestion reads (#546). It is an interface so the engine is tested against
 * deterministic fake histories and never against live GitHub. Every failure is a typed result, never a thrown
 * string, so the engine can tell "rate limited" from "access gone" from "try again" without parsing messages.
 */
export type GhFailure =
  | { ok: false; kind: 'rate_limited'; retryAt: number }
  | { ok: false; kind: 'access_lost' }
  | { ok: false; kind: 'transient'; detail: string };
type GhResult<T> = ({ ok: true } & T) | GhFailure;

export interface GhRepo { id: number; ownerId: number | null; fullName: string; defaultBranch: string }
export interface GhCommitSummary {
  sha: string;
  parentCount: number;
  authorId: number | null;
  authorLogin: string | null;
  authorType: 'user' | 'bot' | 'unlinked';
  authoredAt: number;
  message: string;
}
export interface GhFile { filename: string; additions: number; deletions: number; status?: string | undefined; patch?: string | undefined }

export interface GitHubSource {
  getRepo(fullName: string): Promise<GhResult<{ repo: GhRepo }>>;
  /** Newest first, `page` is 1-based. `hasNext` is false on the last page. */
  listCommits(repoId: number, fullName: string, branch: string, page: number, perPage: number): Promise<GhResult<{ commits: GhCommitSummary[]; hasNext: boolean }>>;
  /** Every file of one commit, following pagination. `truncated` means GitHub would not return them all. */
  getCommitFiles(repoId: number, fullName: string, sha: string): Promise<GhResult<{ files: GhFile[]; truncated: boolean }>>;
}

const API = 'https://api.github.com';
const FILES_PER_PAGE = 100;
/** GitHub caps a commit's file listing at 3000 files; past this we say so instead of inventing a total. */
const MAX_FILE_PAGES = 30;

interface RawCommit {
  sha: string;
  parents?: unknown[];
  commit: { author?: { date?: string } | null; message?: string };
  author: { id?: number; login?: string; type?: string } | null;
}

function classify(res: Response, now: number): GhFailure | null {
  if (res.ok) return null;
  if (res.status === 401 || res.status === 404 || res.status === 451) return { ok: false, kind: 'access_lost' };
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.status === 429 || remaining === '0' || Number.isFinite(retryAfter) && retryAfter > 0) {
      const retryAt = retryAfter > 0 ? now + retryAfter * 1000 : reset > 0 ? reset * 1000 : now + 60_000;
      return { ok: false, kind: 'rate_limited', retryAt: Math.max(retryAt, now + 1000) };
    }
    return { ok: false, kind: 'access_lost' };
  }
  return { ok: false, kind: 'transient', detail: `github ${res.status}` };
}

/** The real source. Reads only: no write, no token is logged or returned. */
export function githubSource(token: string, now: () => number = Date.now, fetcher: typeof fetch = fetch): GitHubSource {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'proappstore-contributions', Authorization: `Bearer ${token}` };
  const get = async <T>(url: string): Promise<GhResult<{ body: T; link: string | null }>> => {
    let res: Response;
    try { res = await fetcher(url, { headers }); } catch { return { ok: false, kind: 'transient', detail: 'network' }; }
    const failure = classify(res, now());
    if (failure) return failure;
    try { return { ok: true, body: (await res.json()) as T, link: res.headers.get('link') }; } catch { return { ok: false, kind: 'transient', detail: 'bad body' }; }
  };

  return {
    async getRepo(fullName) {
      const r = await get<{ id: number; full_name: string; default_branch: string; owner?: { id?: number } }>(`${API}/repos/${fullName}`);
      if (!r.ok) return r;
      return { ok: true, repo: { id: r.body.id, ownerId: r.body.owner?.id ?? null, fullName: r.body.full_name, defaultBranch: r.body.default_branch } };
    },
    async listCommits(repoId, _fullName, branch, page, perPage) {
      // By immutable id, so a rename mid-run cannot redirect the read to a different repository.
      const r = await get<RawCommit[]>(`${API}/repositories/${repoId}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`);
      if (!r.ok) return r;
      const commits = r.body.map((c): GhCommitSummary => {
        const date = Date.parse(c.commit.author?.date ?? '');
        return {
          sha: c.sha,
          parentCount: c.parents?.length ?? 0,
          authorId: typeof c.author?.id === 'number' ? c.author.id : null,
          authorLogin: c.author?.login ?? null,
          authorType: c.author === null || typeof c.author.id !== 'number' ? 'unlinked' : isBot(c.author) ? 'bot' : 'user',
          authoredAt: Number.isFinite(date) ? date : 0,
          message: c.commit.message ?? '',
        };
      });
      return { ok: true, commits, hasNext: /rel="next"/.test(r.link ?? '') };
    },
    async getCommitFiles(repoId, _fullName, sha) {
      const files: GhFile[] = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const r = await get<{ files?: Array<{ filename: string; additions: number; deletions: number; status?: string; patch?: string }> }>(`${API}/repositories/${repoId}/commits/${sha}?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (!r.ok) return r;
        const batch = r.body.files ?? [];
        for (const f of batch) files.push({ filename: f.filename, additions: f.additions, deletions: f.deletions, status: f.status, patch: f.patch });
        if (batch.length < FILES_PER_PAGE) return { ok: true, files, truncated: false };
      }
      return { ok: true, files, truncated: true };
    },
  };
}
