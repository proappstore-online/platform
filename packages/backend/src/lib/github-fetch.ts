/**
 * Fetch a subset of a GitHub repo's files into an in-memory Map keyed by
 * POSIX-style path relative to the repo root. Designed for compliance
 * checks: pulls just the paths the rules look at, not the whole tree.
 *
 * Works against public repos with no auth (60 req/hr per IP) or with a
 * fine-grained `GITHUB_TOKEN` (5000 req/hr). PAS apps are all MIT +
 * public, so unauthenticated is the common case.
 */

const GH_API = 'https://api.github.com';
/** Max bytes of any single repo file fetched for compliance scanning (DoS guard). */
export const MAX_COMPLIANCE_FILE_BYTES = 256 * 1024;

interface TreeNode {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

interface TreeResponse {
  sha: string;
  tree: TreeNode[];
  truncated: boolean;
}

interface ContentResponse {
  content: string;
  encoding: 'base64';
}

/**
 * Paths and prefixes the compliance checks care about. Anything outside
 * this set is skipped — keeps the fetch count bounded (~15-25 files for
 * a typical app) and the latency reasonable (<2s end-to-end).
 */
const RELEVANT_FILES = [
  'LICENSE',
  'README.md',
  'CLAUDE.md',
  'package.json',
  'pnpm-workspace.yaml',
  '.env.production',
  'web/package.json',
  'web/index.html',
  'web/vite.config.ts',
  'web/.env.production',
  'web/public/manifest.json',
];

const RELEVANT_PREFIXES = [
  'web/src/',     // for tracking-lib grep, dark-mode hooks, storefront link
];

const RELEVANT_SUFFIXES = [
  '.ts',
  '.tsx',
  '.css',
  '.html',
];

function isRelevant(path: string): boolean {
  if (RELEVANT_FILES.includes(path)) return true;
  for (const prefix of RELEVANT_PREFIXES) {
    if (path.startsWith(prefix)) {
      for (const suffix of RELEVANT_SUFFIXES) {
        if (path.endsWith(suffix)) return true;
      }
    }
  }
  return false;
}

function headers(token?: string): HeadersInit {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'proappstore-backend-compliance-check',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export interface RepoLocation {
  owner: string;
  repo: string;
  ref: string;
}

export interface FetchResult {
  files: Map<string, string>;
  /** Resolved commit SHA the files were read at. */
  sha: string;
  /** Paths that were in the tree but skipped because they aren't compliance-relevant. */
  skipped: number;
}

/**
 * Fetch the compliance-relevant subset of a repo's tree into a Map.
 * Throws on any non-200 from the GitHub API so the caller can surface
 * a clear "couldn't reach repo" failure to the user.
 */
export async function fetchRepoFiles(loc: RepoLocation, token?: string): Promise<FetchResult> {
  const { owner, repo, ref } = loc;

  // Resolve ref → tree (recursive).
  const treeRes = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
    { headers: headers(token) },
  );
  if (!treeRes.ok) {
    throw new Error(`GitHub tree fetch failed (${treeRes.status}): ${await treeRes.text()}`);
  }
  const tree = (await treeRes.json()) as TreeResponse;

  if (tree.truncated) {
    // Defensive: trees > 7MB get truncated. Our compliance subset is
    // small enough this shouldn't happen, but warn loudly if it does.
    console.warn(`fetchRepoFiles: tree was truncated for ${owner}/${repo}@${ref}`);
  }

  const blobs = tree.tree.filter((n) => n.type === 'blob');
  // SECURITY: cap the size of any file we fetch + scan. Compliance checks run
  // untrusted repo content through regexes inside the provisioning Worker; an
  // oversized file could drive quadratic/ReDoS behaviour and exhaust the Worker
  // CPU budget (DoS). Real source is far below this; skip anything larger.
  const wanted = blobs.filter(
    (b) => isRelevant(b.path) && (b.size == null || b.size <= MAX_COMPLIANCE_FILE_BYTES),
  );
  const skipped = blobs.length - wanted.length;

  // Fetch contents in parallel. ~20 files × ~100ms each = ~2s on first call;
  // CF's per-Worker subrequest cap (50 by default) bounds the worst case.
  const entries = await Promise.all(
    wanted.map(async (node) => {
      const r = await fetch(
        `${GH_API}/repos/${owner}/${repo}/contents/${encodeURI(node.path)}?ref=${encodeURIComponent(ref)}`,
        { headers: headers(token) },
      );
      if (!r.ok) {
        // Single-file failures shouldn't abort the whole check — skip the file.
        console.warn(`fetchRepoFiles: skipping ${node.path} (${r.status})`);
        return null;
      }
      const body = (await r.json()) as ContentResponse;
      if (body.encoding !== 'base64') return null;
      // GitHub adds newlines in the base64 payload; atob handles those fine.
      const decoded = atob(body.content);
      // Belt-and-suspenders in case the tree node lacked a `size`.
      return [node.path, decoded.length > MAX_COMPLIANCE_FILE_BYTES ? decoded.slice(0, MAX_COMPLIANCE_FILE_BYTES) : decoded] as const;
    }),
  );

  const files = new Map<string, string>();
  for (const e of entries) {
    if (e) files.set(e[0], e[1]);
  }
  return { files, sha: tree.sha, skipped };
}
