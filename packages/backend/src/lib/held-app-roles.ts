/**
 * The app roles a user holds in one app (#695): the roles granted to them in
 * `app_roles`, plus — when they own the app — every role the app declares in
 * mcp.json `roles` (`app_declared_roles`). Every app-role gate reads this:
 * action auth (which also backs the operator view), GET /roles/check/:role,
 * GET /roles/me, the operator audit trail, review-document access
 * (lib/review-access.ts) and a private app's `visibility.roles` (#696).
 *
 * The owner is the app's creator or a team member with the `owner` team role,
 * as requireAppAccess decides it. A platform admin is not the app's owner and
 * holds no app role through admin standing. An app that declares no roles
 * implies none, so it behaves exactly as before: only grants count.
 *
 * One D1 query, so a gate costs what its grant lookup cost before.
 */
import { roleSubjects, type RoleSubjectUser } from './role-subject.js';
import type { DeclaredRole } from './manifest/roles.js';

/** Where a held role comes from: an app_roles grant, or owning the app (declared roles only). */
type RoleSource = 'grant' | 'owner';

/** A role a gate admitted the caller under, for the success audit (#232). */
export interface RoleGrant {
  role: string;
  /** True when ownership, not a grant, supplied the role. */
  viaOwner: boolean;
}

/** Role name -> source. A role both granted and owner-implied reads as `grant`. */
export type HeldAppRoles = ReadonlyMap<string, RoleSource>;

export async function heldAppRoles(db: D1Database, appId: string, user: RoleSubjectUser): Promise<HeldAppRoles> {
  const { results } = await db.prepare(
    `SELECT role_name, 'grant' AS source FROM app_roles WHERE app_id = ?1 AND (user_id = ?2 OR user_id = ?3)
     UNION ALL
     SELECT d.role_id, 'owner' FROM app_declared_roles d
      WHERE d.app_id = ?1
        AND (EXISTS (SELECT 1 FROM apps a WHERE a.id = ?1 AND a.creator_id = ?2)
             OR EXISTS (SELECT 1 FROM team_members t WHERE t.app_id = ?1 AND t.user_id = ?2 AND t.role = 'owner'))`,
  ).bind(appId, ...roleSubjects(user)).all<{ role_name: string; source: RoleSource }>();
  const held = new Map<string, RoleSource>();
  for (const row of results ?? []) if (held.get(row.role_name) !== 'grant') held.set(row.role_name, row.source);
  return held;
}

/**
 * The first of `roles` that `held` contains, as a grant for the audit, or null.
 * A granted role wins over an owner-implied one, so the audit names ownership
 * only when nothing else admitted the caller.
 */
export function firstHeld(held: HeldAppRoles, roles: readonly string[]): RoleGrant | null {
  const role = roles.find((r) => held.get(r) === 'grant') ?? roles.find((r) => held.has(r));
  return role === undefined ? null : { role, viaOwner: held.get(role) === 'owner' };
}

/** The roles the app declares in mcp.json `roles`, in declared order. Empty when it declares none. */
export async function declaredAppRoles(db: D1Database, appId: string): Promise<DeclaredRole[]> {
  const { results } = await db.prepare(
    'SELECT role_id, label, description, requires FROM app_declared_roles WHERE app_id = ? ORDER BY position',
  ).bind(appId).all<{ role_id: string; label: string; description: string | null; requires: string }>();
  return (results ?? []).map((r) => ({ id: r.role_id, label: r.label, description: r.description, requires: JSON.parse(r.requires) as string[] }));
}
