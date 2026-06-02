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
      files.set(path, content);
      return ok(call, `Wrote ${path} (${content.length} bytes)`);
    }

    case 'read_file': {
      const path = String(args.path ?? '');
      const content = files.get(path);
      return content === undefined ? err(call, `file not found: ${path}`) : ok(call, content);
    }

    case 'list_files': {
      const paths = [...files.keys()].sort();
      return ok(call, paths.length ? paths.join('\n') : '(no files yet)');
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
      const written: string[] = [];
      for (const f of list) {
        const path = String(f.path ?? '');
        const content = String(f.content ?? '');
        if (badPath(path)) return err(call, `path "${path}" not allowed`);
        files.set(path, content);
        written.push(path);
      }
      return ok(call, `Wrote ${written.length} file(s): ${written.join(', ')}`);
    }

    default:
      return err(call, `not a file tool: ${call.name}`);
  }
}
