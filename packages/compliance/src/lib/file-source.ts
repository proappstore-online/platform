/**
 * Filesystem-agnostic file access for compliance checks.
 *
 * Why: the CLI scans a real directory on disk; the VibeCode agent runs
 * in a Cloudflare Worker (no node:fs) and holds files in a Map. Both
 * call the same checks via this interface so rules stay in one place.
 *
 * Conventions:
 *   - Paths are POSIX-style and relative to the repo root
 *     (e.g. `web/src/App.tsx`).
 *   - `read` returns null for missing files — checks decide whether
 *     missing == fail or missing == not-applicable.
 *   - `list()` already excludes noise dirs (.git, node_modules, dist,
 *     etc.). Implementations are responsible for that filtering.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface FileSource {
  /** Yield every relevant file path. Implementations skip noise dirs. */
  list(): AsyncIterable<string>;
  /** UTF-8 text. Returns null if the path doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Raw bytes. Returns null if the path doesn't exist. Optional — only
   *  bundle-size needs binary access today. */
  readBytes?(path: string): Promise<Uint8Array | null>;
  /** Names of direct children of `dir`. Returns null if dir missing.
   *  Optional — only bundle-size needs directory enumeration. */
  listDir?(dir: string): Promise<string[] | null>;
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.wrangler',
  '.turbo',
]);

/**
 * Filesystem-backed FileSource — used by the CLI and CI. Walks the
 * directory tree once on first list() iteration; uses node:fs for
 * read/readBytes/listDir.
 *
 * Paths containing `..` segments are rejected — every read returns
 * null. Defense in depth: today's checks only pass paths that came
 * from `list()` (which stays inside the root), but a future buggy or
 * malicious check could try `source.read('../etc/passwd')`. We refuse
 * rather than letting `path.join` resolve outside repoDir.
 */
export function fsFileSource(repoDir: string): FileSource {
  return {
    async *list() {
      yield* walk(repoDir, repoDir);
    },
    async read(path) {
      if (hasTraversal(path)) return null;
      try {
        return await readFile(join(repoDir, path), 'utf8');
      } catch {
        return null;
      }
    },
    async readBytes(path) {
      if (hasTraversal(path)) return null;
      try {
        const buf = await readFile(join(repoDir, path));
        return new Uint8Array(buf);
      } catch {
        return null;
      }
    },
    async listDir(dir) {
      if (hasTraversal(dir)) return null;
      try {
        return await readdir(join(repoDir, dir));
      } catch {
        return null;
      }
    },
  };
}

/** True if `path` contains a `..` segment or is absolute. */
function hasTraversal(path: string): boolean {
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return true; // absolute
  return path.split(/[/\\]/).some((seg) => seg === '..');
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, root);
    } else if (entry.isFile()) {
      // Always emit POSIX-style paths so checks can rely on consistent
      // separators across platforms.
      yield relative(root, full).split(sep).join('/');
    }
  }
}

/**
 * Map-backed FileSource — used by the VibeCode agent (Workers env).
 * The agent's session DO holds the virtual filesystem as a Map; this
 * adapter exposes it through the same interface as the on-disk CLI.
 *
 * `readBytes` decodes the stored UTF-8 string back to bytes — fine for
 * text-only checks. The agent has no built artefacts (it runs pre-
 * deploy), so bundle-size will return its "not built yet" warn anyway.
 *
 * `listDir` synthesises directory listings from the Map keys.
 */
export function mapFileSource(files: Map<string, string>): FileSource {
  return {
    async *list() {
      for (const path of files.keys()) {
        if (isSkippedPath(path)) continue;
        yield path;
      }
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    async readBytes(path) {
      const text = files.get(path);
      if (text === undefined) return null;
      return new TextEncoder().encode(text);
    },
    async listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const children = new Set<string>();
      let saw = false;
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        saw = true;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        children.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return saw ? [...children] : null;
    },
  };
}

function isSkippedPath(path: string): boolean {
  for (const seg of path.split('/')) {
    if (SKIP_DIRS.has(seg)) return true;
  }
  return false;
}
