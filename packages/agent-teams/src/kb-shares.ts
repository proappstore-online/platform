/**
 * KB share links — public, owner-created links to a project's Knowledge Base
 * (KNOWLEDGE.md + docs/*). Private by default; the owner creates share links with
 * a configurable access type.
 *
 * Free functions over SqlStorage (same convention as project-store.ts) — share +
 * file data live in the DO's SQLite (`kb_shares` + `project_files`), co-located with
 * the KB. project-do.ts wraps these as thin methods. No broadcast/logging here.
 */
import { json } from './store.ts';

export interface CreateShareInput {
  accessType?: string;
  allowlist?: string;
  label?: string;
  expiresAt?: number;
}

export function listShares(sql: SqlStorage): Response {
  const rows = sql
    .exec('SELECT * FROM kb_shares WHERE revoked = 0 ORDER BY created_at DESC')
    .toArray();
  return json({ shares: rows.map((r) => ({
    id: r.id, accessType: r.access_type, allowlist: r.allowlist,
    label: r.label, expiresAt: r.expires_at, createdAt: r.created_at, viewCount: r.view_count,
  })) });
}

export function createShare(sql: SqlStorage, body: CreateShareInput): Response {
  const accessType = body.accessType ?? 'open';
  if (!['open', 'google', 'github', 'password'].includes(accessType)) {
    return json({ error: 'accessType must be open, google, github, or password' }, 400);
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16); // short URL-safe ID
  const now = Date.now();
  sql.exec(
    'INSERT INTO kb_shares (id, access_type, allowlist, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, accessType, body.allowlist ?? null, body.label ?? null, body.expiresAt ?? null, now,
  );

  const proj = sql.exec('SELECT slug FROM project LIMIT 1').toArray()[0] as { slug: string } | undefined;
  const url = `https://agents.proappstore.online/kb/${proj?.slug ?? 'unknown'}/s/${id}`;

  return json({ id, url, accessType }, 201);
}

export function revokeShare(sql: SqlStorage, shareId: string): Response {
  sql.exec('UPDATE kb_shares SET revoked = 1 WHERE id = ?', shareId);
  return json({ ok: true });
}

/** Public: serve the KB file list if the share link is valid + open. */
export function accessKbViaShare(sql: SqlStorage, shareId: string): Response {
  const share = sql
    .exec('SELECT * FROM kb_shares WHERE id = ? AND revoked = 0', shareId)
    .toArray()[0] as { access_type: string; expires_at: number | null } | undefined;

  if (!share) return json({ error: 'Share link not found or revoked' }, 404);
  if (share.expires_at && Date.now() > share.expires_at) return json({ error: 'Share link expired' }, 410);

  // For 'open' type, serve immediately. Other types need additional auth (Phase 2).
  if (share.access_type !== 'open') {
    return json({ error: `This link requires ${share.access_type} authentication (coming soon)` }, 403);
  }

  // Bump view count
  sql.exec('UPDATE kb_shares SET view_count = view_count + 1 WHERE id = ?', shareId);

  // Return KB file list
  const files = sql
    .exec("SELECT path, length(content) AS size FROM project_files WHERE path = 'KNOWLEDGE.md' OR path LIKE 'docs/%' ORDER BY path")
    .toArray() as { path: string; size: number }[];

  return json({ files, accessType: share.access_type });
}

/** Public: serve a specific KB file if the share link is valid + open. */
export function accessKbFileViaShare(sql: SqlStorage, shareId: string, filePath: string): Response {
  const share = sql
    .exec('SELECT * FROM kb_shares WHERE id = ? AND revoked = 0', shareId)
    .toArray()[0] as { access_type: string; expires_at: number | null } | undefined;

  if (!share) return json({ error: 'Share link not found or revoked' }, 404);
  if (share.expires_at && Date.now() > share.expires_at) return json({ error: 'Share link expired' }, 410);
  if (share.access_type !== 'open') return json({ error: `Requires ${share.access_type} auth` }, 403);

  // Only serve KB files (KNOWLEDGE.md + docs/*)
  if (filePath !== 'KNOWLEDGE.md' && !filePath.startsWith('docs/')) {
    return json({ error: 'Only KB files (KNOWLEDGE.md + docs/*) are accessible via share links' }, 403);
  }

  const row = sql
    .exec('SELECT content FROM project_files WHERE path = ?', filePath)
    .toArray()[0] as { content: string } | undefined;

  if (!row) return json({ error: 'file not found' }, 404);
  return json({ path: filePath, content: row.content });
}
