import type { ProjectHost } from './project-host.ts';
import type { ToolCall, ToolResult } from './types.ts';
import { executeFileTool, isFileTool } from './spine.ts';
import { RECIPES, getRecipe } from './recipes.ts';
import { json } from './store.ts';
import { loadFiles, saveFiles } from './project-store.ts';
import { DOCS_SKILLS_URL, sliceDocs } from './platform-skill.ts';

export async function fetchDocs(h: ProjectHost): Promise<string> {
  const now = Date.now();
  if (h.docsCache && now - h.docsCache.at < 3_600_000) return h.docsCache.text;
  try {
    const res = await fetch(DOCS_SKILLS_URL, { headers: { 'User-Agent': 'proappstore-agent-teams/1.0' } });
    if (!res.ok) return h.docsCache?.text ?? '';
    const text = await res.text();
    h.docsCache = { text, at: now };
    return text;
  } catch {
    return h.docsCache?.text ?? '';
  }
}

export function listProjectFiles(h: ProjectHost): Response {
  const rows = h.state.storage.sql
    .exec('SELECT path, length(content) AS size, updated_at FROM project_files ORDER BY path')
    .toArray() as { path: string; size: number; updated_at: number }[];
  return json({ files: rows.map((r) => ({ path: r.path, size: r.size, updatedAt: r.updated_at })) });
}

export function getProjectFile(h: ProjectHost, filePath: string): Response {
  if (!filePath) return json({ error: 'path required' }, 400);
  const row = h.state.storage.sql
    .exec('SELECT path, content FROM project_files WHERE path = ?', filePath)
    .toArray()[0] as { path: string; content: string } | undefined;
  if (!row) return json({ error: 'not_found' }, 404);
  const MAX = 200_000;
  const truncated = row.content.length > MAX;
  return json({ path: row.path, content: truncated ? row.content.slice(0, MAX) : row.content, truncated });
}

export function requireParked(h: ProjectHost): Response | null {
  const proj = h.state.storage.sql.exec('SELECT status FROM project LIMIT 1').toArray()[0] as { status: string } | undefined;
  if (proj?.status === 'running') {
    return json({ error: 'Pause the project before editing files directly — agents and direct edits must not run concurrently.' }, 409);
  }
  return null;
}

export async function writeProjectFiles(h: ProjectHost, request: Request): Promise<Response> {
  const blocked = requireParked(h);
  if (blocked) return blocked;
  const body = await request.json().catch(() => null) as { files?: { path?: string; content?: string }[] } | null;
  const incoming = body?.files ?? [];
  if (!Array.isArray(incoming) || incoming.length === 0) return json({ error: 'files: [{ path, content }] required' }, 400);
  if (incoming.length > 200) return json({ error: 'too many files in one call (max 200)' }, 413);
  for (const f of incoming) {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string') return json({ error: 'each file needs string path + content' }, 400);
    if (f.path.includes('..') || f.path.startsWith('/') || f.path.length > 512) return json({ error: `invalid path: ${f.path}` }, 400);
  }
  const files = loadFiles(h.state.storage.sql);
  for (const f of incoming) files.set(f.path!, f.content!);
  saveFiles(h.state.storage.sql, files);
  const names = incoming.slice(0, 5).map((f) => f.path).join(', ');
  h.logActivity('tool', `Direct write: ${incoming.length} file(s) — ${names}${incoming.length > 5 ? ' …' : ''}`, null);
  h.broadcast({ type: 'files-synced', count: files.size });
  return json({ ok: true, written: incoming.length, totalFiles: files.size });
}

export async function deleteProjectFiles(h: ProjectHost, request: Request): Promise<Response> {
  const blocked = requireParked(h);
  if (blocked) return blocked;
  const body = await request.json().catch(() => null) as { paths?: string[] } | null;
  const paths = body?.paths ?? [];
  if (!Array.isArray(paths) || paths.length === 0) return json({ error: 'paths: string[] required' }, 400);
  const files = loadFiles(h.state.storage.sql);
  let deleted = 0;
  for (const p of paths) { if (files.delete(p)) deleted++; }
  saveFiles(h.state.storage.sql, files);
  h.logActivity('tool', `Direct delete: ${deleted} file(s)`, null);
  h.broadcast({ type: 'files-synced', count: files.size });
  return json({ ok: true, deleted, totalFiles: files.size });
}

export async function syncFromGitHub(h: ProjectHost, reason: string): Promise<{ pulled: boolean; count?: number }> {
  if (!h.env.ADMIN || !h.env.INTERNAL_TOKEN) return { pulled: false };
  const proj = h.state.storage.sql
    .exec('SELECT slug, repo_synced_sha FROM project LIMIT 1')
    .toArray()[0] as { slug: string; repo_synced_sha: string | null } | undefined;
  if (!proj?.slug) return { pulled: false };

  const callAdmin = async (headOnly: boolean) => {
    const res = await h.env.ADMIN!.fetch(new Request('https://admin.proappstore.online/api/repo-pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': h.env.INTERNAL_TOKEN! },
      body: JSON.stringify({ id: proj.slug, headOnly }),
    }));
    return res.json() as Promise<{ ok: boolean; sha?: string; files?: Record<string, string>; truncated?: boolean }>;
  };

  try {
    const head = await callAdmin(true);
    if (!head.ok || !head.sha) return { pulled: false }; // no repo / no commits
    if (head.sha === proj.repo_synced_sha) return { pulled: false }; // already current

    const pull = await callAdmin(false);
    if (!pull.ok || !pull.files) return { pulled: false };
    const entries = Object.entries(pull.files);
    saveFiles(h.state.storage.sql, new Map(entries)); // mirror GitHub (only reached when it moved)
    const now = Date.now();
    h.state.storage.sql.exec('UPDATE project SET repo_synced_sha = ?, repo_synced_at = ?', pull.sha ?? head.sha, now);
    h.logActivity('sync', `Synced ${entries.length} file(s) from GitHub @${(pull.sha ?? head.sha)!.slice(0, 7)} (${reason})`);
    h.broadcast({ type: 'files-synced', count: entries.length });
    return { pulled: true, count: entries.length };
  } catch {
    return { pulled: false };
  }
}

async function publishKb(h: ProjectHost): Promise<void> {
  const env = h.env;
  if (!env.ADMIN || !env.INTERNAL_TOKEN) return; // no admin binding (dev)
  const proj = h.state.storage.sql
    .exec('SELECT slug, name FROM project LIMIT 1')
    .toArray()[0] as { slug: string; name: string } | undefined;
  if (!proj) return;
  const kb: Record<string, string> = {};
  for (const [p, c] of loadFiles(h.state.storage.sql)) {
    if (p === 'KNOWLEDGE.md' || /^docs\/.+\.(md|markdown)$/i.test(p)) kb[p] = c;
  }
  if (Object.keys(kb).length === 0) return; // nothing written yet
  try {
    const res = await env.ADMIN.fetch(new Request('https://admin.proappstore.online/api/publish-kb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN },
      body: JSON.stringify({ id: proj.slug, name: proj.name, files: kb }),
    }));
    if (res.ok) h.logActivity('control', `Knowledge Base published → kb.proappstore.online/${proj.slug}/`, null);
    else h.logActivity('control', `KB publish skipped (admin ${res.status}) — retries on next KB change`, null);
  } catch (e) {
    h.logActivity('control', `KB publish error (non-fatal): ${e instanceof Error ? e.message : 'unknown'}`, null);
  }
}

export function makeDispatch(h: ProjectHost, files: Map<string, string>): (call: ToolCall) => Promise<ToolResult> {
  return async (call) => {
    if (call.name === 'read_docs') {
      const topic = (call.args as { topic?: string } | undefined)?.topic;
      // Check if the topic matches a recipe name first
      if (topic && RECIPES[topic.toLowerCase().replace(/\s+/g, '-')]) {
        return { callId: call.id, ok: true, data: getRecipe(topic), durationMs: 0 };
      }
      if (topic === 'recipes') {
        return { callId: call.id, ok: true, data: getRecipe(), durationMs: 0 };
      }
      const out = sliceDocs(await fetchDocs(h), topic) || 'docs unavailable';
      return { callId: call.id, ok: true, data: out, durationMs: 0 };
    }
    if (isFileTool(call.name)) return executeFileTool(call, files);
    return { callId: call.id, ok: false, errorMessage: `Tool not available to agents: ${call.name}. Deployment is automatic after QA.`, durationMs: 0 };
  };
}
