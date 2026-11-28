import { parseReviewRoles } from '../review-access.js';
import type { DeclaredRole } from './roles.js';

/** The `storage` section of mcp.json (#696). */
export interface StorageManifest {
  /** The app roles whose holders may review `_review/` uploads (#208). */
  review_roles: string[];
}

/**
 * The `storage` section: `{ review_roles: string[] }`. Absent is `null` — the
 * team sets review roles through PUT storage-config, as before. When declared,
 * the list follows PUT storage-config's rules and, if the app declares `roles`,
 * names only declared roles, so a typo fails registration instead of locking
 * every reviewer out.
 */
export function validateStorage(raw: unknown, declared: DeclaredRole[] | null): { error: string } | { storage: StorageManifest | null } {
  if (raw === undefined || raw === null) return { storage: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'storage must be an object { review_roles }' };
  const unknown = Object.keys(raw).find((k) => k !== 'review_roles');
  if (unknown) return { error: `storage: unknown field "${unknown}"` };
  const parsed = parseReviewRoles((raw as Record<string, unknown>).review_roles, 'storage.review_roles');
  if ('error' in parsed) return parsed;
  if (declared) {
    const undeclared = parsed.roles.find((r) => !declared.some((d) => d.id === r));
    if (undeclared !== undefined) return { error: `storage.review_roles: role "${undeclared}" is not declared in roles` };
  }
  return { storage: { review_roles: parsed.roles } };
}
