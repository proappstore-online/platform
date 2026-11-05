import { HttpError } from './auth.js';

/**
 * The public team projection (#542). What a person chose to publish about themselves on an app's
 * storefront team list, nothing else. A member appears only while they are a current member
 * (publisher or `team_members` row) AND have opted in; the public read joins both, so a stale
 * visible flag can never show someone who has left. A label is presentation, never a permission.
 */

const MAX_DISPLAY_NAME = 60;
const MAX_LABEL = 40;
// No HTML, entities, control characters, URLs or email addresses in what is published.
const MARKUP = /[<>]|&(#\d+|#x[0-9a-f]+|[a-z]+);/i;
const CONTROL = /[\x00-\x1f\x7f]/;
const LINKISH = /:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|org|net|io|dev|app|online|co|me|xyz|ai)\b|\S+@\S+/i;

/** Plain text only (no markup, links, email addresses or control characters), trimmed; null when empty. Shared with promoter display names. */
export const plainText = (value: unknown, name: string, max: number) => text(value, name, max);

export interface PublicProfileInput { display_name: string | null; label: string | null; visible: boolean }

function text(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(`${name} must be a string`, 400);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new HttpError(`${name} too long (max ${max} characters)`, 400);
  if (MARKUP.test(trimmed) || CONTROL.test(trimmed) || LINKISH.test(trimmed)) throw new HttpError(`${name} must be plain text without links, email addresses or markup`, 400);
  return trimmed;
}

export function parseProfileInput(body: unknown): PublicProfileInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('JSON object required', 400);
  const source = body as Record<string, unknown>;
  if (typeof source.visible !== 'boolean') throw new HttpError('visible must be true or false', 400);
  const display_name = text(source.display_name, 'display_name', MAX_DISPLAY_NAME);
  const label = text(source.label, 'label', MAX_LABEL);
  if (source.visible && !display_name) throw new HttpError('display_name is required to be visible', 400);
  return { display_name, label, visible: source.visible };
}

const MEMBER = `(EXISTS (SELECT 1 FROM apps WHERE id = ?1 AND creator_id = ?2) OR EXISTS (SELECT 1 FROM team_members WHERE app_id = ?1 AND user_id = ?2))`;

/** Upsert the caller's own row; nothing is written unless they are a current member, decided in the same statement. */
export async function saveOwnProfile(db: D1Database, appId: string, userId: string, input: PublicProfileInput): Promise<boolean> {
  const res = await db.prepare(
    `INSERT INTO app_team_public_profiles (app_id, user_id, display_name, label, visible, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, datetime('now') WHERE ${MEMBER}
     ON CONFLICT(app_id, user_id) DO UPDATE SET display_name = excluded.display_name, label = excluded.label, visible = excluded.visible, updated_at = excluded.updated_at`,
  ).bind(appId, userId, input.display_name, input.label, input.visible ? 1 : 0).run();
  return !!res.meta?.changes;
}

/** Withdraw: visible = 0, keeping what they wrote. Only a current member; false otherwise. */
export async function withdrawOwnProfile(db: D1Database, appId: string, userId: string): Promise<boolean> {
  const member = await db.prepare(`SELECT 1 AS member WHERE ${MEMBER}`).bind(appId, userId).first();
  if (!member) return false;
  await db.prepare("UPDATE app_team_public_profiles SET visible = 0, updated_at = datetime('now') WHERE app_id = ? AND user_id = ?").bind(appId, userId).run();
  return true;
}

/** Owner moderation: take one person off the public list. They may opt in again; removing them from the team is the stronger tool. */
export async function hideProfile(db: D1Database, appId: string, userId: string): Promise<boolean> {
  const res = await db.prepare("UPDATE app_team_public_profiles SET visible = 0, updated_at = datetime('now') WHERE app_id = ? AND user_id = ? AND visible = 1").bind(appId, userId).run();
  return !!res.meta?.changes;
}

/** The owner's moderation view: every current member (publisher first) with what they have published. Private to the owner. */
export async function moderationView(db: D1Database, appId: string) {
  const { results } = await db.prepare(
    `SELECT m.user_id, m.role, p.display_name, p.label, COALESCE(p.visible, 0) AS visible, p.updated_at
       FROM (SELECT creator_id AS user_id, 'owner' AS role FROM apps WHERE id = ?1
             UNION ALL
             SELECT user_id, role FROM team_members WHERE app_id = ?1 AND user_id <> COALESCE((SELECT creator_id FROM apps WHERE id = ?1), '')) m
       LEFT JOIN app_team_public_profiles p ON p.app_id = ?1 AND p.user_id = m.user_id
      ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.user_id`,
  ).bind(appId).all<{ user_id: string; role: string; display_name: string | null; label: string | null; visible: number; updated_at: string | null }>();
  return (results ?? []).map((r) => ({ user_id: r.user_id, role: r.role, display_name: r.display_name, label: r.label, visible: r.visible === 1, updated_at: r.updated_at }));
}

/** The public projection: only chosen display fields of current, opted-in members. No ids, roles, emails or invitations. */
export async function publicMembers(db: D1Database, appId: string) {
  const { results } = await db.prepare(
    `SELECT p.display_name, p.label, (p.user_id = a.creator_id) AS is_creator
       FROM app_team_public_profiles p JOIN apps a ON a.id = p.app_id
      WHERE p.app_id = ?1 AND p.visible = 1 AND p.display_name IS NOT NULL AND p.display_name <> ''
        AND (p.user_id = a.creator_id OR EXISTS (SELECT 1 FROM team_members t WHERE t.app_id = p.app_id AND t.user_id = p.user_id))
      ORDER BY is_creator DESC, p.display_name COLLATE NOCASE, p.rowid`,
  ).bind(appId).all<{ display_name: string; label: string | null; is_creator: number }>();
  return (results ?? []).map((r) => ({ display_name: r.display_name, label: r.label, is_creator: r.is_creator === 1 }));
}
