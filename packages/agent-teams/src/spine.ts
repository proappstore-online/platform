/**
 * Spine — file-tool executor for agent runs.
 *
 * Mirrors the FAS build agent (fas/agent/src/tools.ts): the Dev/QA file tools
 * operate on an in-memory file map with NO external calls. The map is the
 * project's working tree; the DO persists it between runs (BA → Dev → QA) and
 * the deploy/provision tools (handled by the DO, not here) push it to GitHub.
 *
 * Keeping file edits local means a Dev agent can author a whole codebase across
 * dozens of tool calls cheaply, and QA can read it back, without a round-trip
 * to GitHub per file.
 */

import type { ToolCall, ToolResult } from './types.ts';

/** Tools handled purely against the in-memory file map. */
const FILE_TOOLS = new Set([
  'write_file',
  'read_file',
  'list_files',
  'delete_file',
  'search_files',
  'batch_write_files',
]);

export function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

function ok(call: ToolCall, data: string): ToolResult {
  return { callId: call.id, ok: true, data, durationMs: 0 };
}

function err(call: ToolCall, errorMessage: string): ToolResult {
  return { callId: call.id, ok: false, errorMessage, durationMs: 0 };
}

/** Reject path traversal, absolute paths, and CI config edits. */
function badPath(p: string): boolean {
  return !p || p.includes('..') || p.startsWith('/') || p.startsWith('.github/');
}

// Resource caps — a runaway/malicious agent could otherwise bloat the DO's
// SQLite (our storage + cost). Generous enough for real apps.
export const MAX_FILE_BYTES = 512 * 1024;      // 512KB per file
export const MAX_FILES = 300;                  // files in the working tree
export const MAX_TREE_BYTES = 12 * 1024 * 1024; // 12MB total

function treeBytes(files: Map<string, string>): number {
  let n = 0;
  for (const v of files.values()) n += v.length;
  return n;
}

/**
 * Execute a file tool against the working map. Mutates `files` in place.
 * Callers should route only file tools here (see isFileTool).
 */
export function executeFileTool(call: ToolCall, files: Map<string, string>): ToolResult {
  const args = (call.args ?? {}) as Record<string, unknown>;

  switch (call.name) {
    case 'write_file': {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      if (badPath(path)) {
        return err(call, `path "${path}" not allowed (no "..", absolute paths, or .github/ files)`);
      }
      if (content.length > MAX_FILE_BYTES) return err(call, `file too large: ${content.length} bytes (max ${MAX_FILE_BYTES})`);
      if (!files.has(path) && files.size >= MAX_FILES) return err(call, `too many files (max ${MAX_FILES})`);
      if (treeBytes(files) - (files.get(path)?.length ?? 0) + content.length > MAX_TREE_BYTES) {
        return err(call, `working tree too large (max ${MAX_TREE_BYTES} bytes)`);
      }
      files.set(path, content);
      return ok(call, `Wrote ${path} (${content.length} bytes)`);
    }

    case 'read_file': {
      const path = String(args.path ?? '');
      const content = files.get(path);
      if (content === undefined) return err(call, `file not found: ${path}`);
      const lines = content.split('\n');
      const offset = Math.max(0, Number(args.offset ?? 0));
      const limit = Number(args.limit ?? 0) || 0;
      // If offset/limit specified, return that range.
      if (offset > 0 || limit > 0) {
        const slice = lines.slice(offset, limit > 0 ? offset + limit : undefined);
        return ok(call, `[${path} lines ${offset + 1}-${offset + slice.length} of ${lines.length}]\n${slice.join('\n')}`);
      }
      // Truncate large files to save context. Agent can re-read with offset.
      const MAX_LINES = 300;
      if (lines.length > MAX_LINES) {
        return ok(call, `${lines.slice(0, MAX_LINES).join('\n')}\n\n... (truncated: showing ${MAX_LINES} of ${lines.length} lines. Use offset/limit to read more.)`);
      }
      return ok(call, content);
    }

    case 'list_files': {
      // Honor an optional path prefix (the working tree is the app source only —
      // there's no node_modules, so an SDK-types path correctly returns empty).
      const prefix = String(args.path ?? '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
      let paths = [...files.keys()].sort();
      if (prefix) paths = paths.filter((p) => p === prefix || p.startsWith(`${prefix}/`));
      return ok(call, paths.length
        ? paths.join('\n')
        : prefix ? `(no files under "${prefix}")` : '(no files yet)');
    }

    case 'delete_file': {
      const path = String(args.path ?? '');
      if (badPath(path)) return err(call, `path "${path}" not allowed`);
      if (!files.has(path)) return err(call, `file not found: ${path}`);
      files.delete(path);
      return ok(call, `Deleted ${path}`);
    }

    case 'search_files': {
      const q = String(args.query ?? args.pattern ?? '').toLowerCase();
      if (!q) return err(call, 'query is required');
      const matches: string[] = [];
      for (const [path, content] of files) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(q)) {
            matches.push(`${path}:${i + 1}: ${lines[i]!.trim()}`);
          }
        }
      }
      return ok(call, matches.length ? matches.slice(0, 50).join('\n') : `No matches for "${q}"`);
    }

    case 'batch_write_files': {
      const list = Array.isArray(args.files)
        ? (args.files as { path?: unknown; content?: unknown }[])
        : [];
      if (!list.length) return err(call, 'files array is required');
      // Validate the whole batch against caps BEFORE writing (no partial writes).
      let count = files.size;
      let bytes = treeBytes(files);
      for (const f of list) {
        const path = String(f.path ?? '');
        const content = String(f.content ?? '');
        if (badPath(path)) return err(call, `path "${path}" not allowed`);
        if (content.length > MAX_FILE_BYTES) return err(call, `file too large: ${path} is ${content.length} bytes (max ${MAX_FILE_BYTES})`);
        const existing = files.get(path)?.length;
        if (existing === undefined) {
          if (count >= MAX_FILES) return err(call, `too many files (max ${MAX_FILES})`);
          count += 1;
        }
        bytes += content.length - (existing ?? 0);
        if (bytes > MAX_TREE_BYTES) return err(call, `working tree too large (max ${MAX_TREE_BYTES} bytes)`);
      }
      const written: string[] = [];
      for (const f of list) {
        const path = String(f.path ?? '');
        files.set(path, String(f.content ?? ''));
        written.push(path);
      }
      return ok(call, `Wrote ${written.length} file(s): ${written.join(', ')}`);
    }

    default:
      return err(call, `not a file tool: ${call.name}`);
  }
}
