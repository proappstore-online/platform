/**
 * The project contribution counting policy (#545, epic #544). Versioned: a changed rule is a new version, and
 * stored facts say which version produced them, so totals are never silently re-derived under different rules.
 *
 * Policy v1:
 *  - Counted: added and removed lines in SOURCE and TEST files of non-merge commits reachable from the default branch.
 *  - Not counted: documentation and prose (md, mdx, rst, txt, adoc), lockfiles, generated or built output
 *    (dist, build, coverage, .next, *.min.*, source maps, *.d.ts under generated paths), vendored dependencies
 *    (node_modules, vendor, third_party), binaries and media (GitHub returns no patch for them), and files whose diff
 *    GitHub did not return.
 *  - Tests count. Documentation does not.
 *  - A merge commit adds nothing: its changes are counted once, on the commits it brings in.
 */
export const POLICY_VERSION = 1;

export const POLICY_DESCRIPTION = {
  version: POLICY_VERSION,
  counts: 'Added and removed lines in source and test files, in non-merge commits reachable from the default branch, counted once per commit.',
  tests: 'counted',
  documentation: 'not counted (md, mdx, rst, txt, adoc)',
  excluded: ['lockfiles', 'generated or build output (dist, build, coverage, .next, minified files, source maps)', 'vendored dependencies (node_modules, vendor, third_party)', 'binary and media files', 'files GitHub returned no diff for'],
  merge_commits: 'never counted; the commits they bring in are counted instead',
  authorship: 'the commit author GitHub linked to a numeric account; co-author trailers are counted but never credited',
  period: 'by the commit author date in UTC; from <= date < to',
} as const;

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'cargo.lock', 'gemfile.lock', 'poetry.lock',
  'composer.lock', 'go.sum', 'pipfile.lock', 'packages.lock.json', 'mix.lock', 'flake.lock', 'pubspec.lock', 'podfile.lock',
]);
const PROSE_EXT = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const GENERATED_DIR = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|__generated__|generated)\//i;
const VENDOR_DIR = /(^|\/)(node_modules|vendor|third_party|bower_components)\//i;
const GENERATED_FILE = /(\.min\.(js|css)|\.map|\.snap|\.generated\.[a-z]+|\.pb\.go|_pb2\.py)$/i;

export type Exclusion = 'lockfile' | 'prose' | 'generated' | 'vendored' | 'binary' | 'no_diff';

export interface CommitFile { filename: string; additions: number; deletions: number; status?: string | undefined; patch?: string | undefined; changes?: number | undefined }

/** Why a path is not counted, or null when it is. Case-insensitive on the path. */
export function pathExclusion(filename: string): Exclusion | null {
  const lower = filename.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (LOCKFILES.has(base)) return 'lockfile';
  if (VENDOR_DIR.test(lower)) return 'vendored';
  if (GENERATED_DIR.test(lower) || GENERATED_FILE.test(lower)) return 'generated';
  if (PROSE_EXT.test(lower)) return 'prose';
  return null;
}

export interface FileTotals { additions: number; deletions: number; filesCounted: number; filesExcluded: number }

/**
 * Sum the counted lines of one commit's files. A file with changes but no `patch` is binary, too large for GitHub
 * to diff, or a pure rename/mode change: none of those yield trustworthy line counts, so they are excluded.
 */
export function totalFiles(files: readonly CommitFile[]): FileTotals {
  let additions = 0, deletions = 0, filesCounted = 0, filesExcluded = 0;
  for (const f of files) {
    const reason: Exclusion | null = pathExclusion(f.filename) ?? (f.patch === undefined && (f.additions > 0 || f.deletions > 0) ? 'binary' : null);
    if (reason !== null || (f.additions === 0 && f.deletions === 0)) { filesExcluded++; continue; }
    additions += Math.max(0, f.additions | 0);
    deletions += Math.max(0, f.deletions | 0);
    filesCounted++;
  }
  return { additions, deletions, filesCounted, filesExcluded };
}

/** Number of distinct `Co-authored-by:` trailers in a commit message (the author is not one). Counted, never credited. */
export function countCoAuthors(message: string): number {
  const seen = new Set<string>();
  for (const m of message.matchAll(/^co-authored-by:\s*(.+?)\s*$/gim)) seen.add(m[1]!.toLowerCase());
  return seen.size;
}

/** A GitHub account type or login that is automation, not a person. */
export function isBot(author: { type?: string | undefined; login?: string | undefined } | null | undefined): boolean {
  if (!author) return false;
  return author.type === 'Bot' || /\[bot\]$/i.test(author.login ?? '');
}
