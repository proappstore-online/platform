import type { Env, SubmissionRow } from '../types.js';
import type { FasUser } from './submissions-types.js';

export function isAdmin(user: FasUser, env: Env): boolean {
  const raw = env.ADMIN_GITHUB_IDS;
  if (!raw) return false;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(user.id);
}

/** Hydrate a raw D1 row into the typed SubmissionRow shape. */
export function rowToSubmission(row: Record<string, unknown>): SubmissionRow {
  return {
    id: row.id as string,
    app_id: row.app_id as string,
    creator_id: row.creator_id as string,
    status: row.status as SubmissionRow['status'],
    name: row.name as string,
    category: row.category as string,
    description: row.description as string,
    icon: (row.icon as string | null) ?? null,
    icon_bg: (row.icon_bg as string | null) ?? null,
    pro_features: (row.pro_features as string | null) ?? null,
    suggested_monthly_price_cents:
      row.suggested_monthly_price_cents == null
        ? null
        : Number(row.suggested_monthly_price_cents),
    repo_url: (row.repo_url as string | null) ?? null,
    reviewer_id: (row.reviewer_id as string | null) ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    created_at: Number(row.created_at),
    reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at),
  };
}

export const APP_ID_RE = /^[a-z][a-z0-9-]*$/;
