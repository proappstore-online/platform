import type { ToolManifest } from '../action-sql.js';
import type { OperatorViewContract } from '../operator-contract-shared.js';

/** An app role name, as POST /v1/apps/:appId/roles accepts it. */
export const APP_ROLE_NAME_RE = /^[a-z][a-z0-9_-]{0,49}$/;

/** One role the app declares in mcp.json `roles` (#695). */
export interface DeclaredRole {
  id: string;
  label: string;
  description: string | null;
  /** Declared roles a holder of this one must also hold; granted with it. */
  requires: string[];
}

const MAX_DECLARED_ROLES = 50;
const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 500;
/** Platform-managed names: `owner` is ownership itself, `member` every signed-in user. */
const RESERVED = ['owner', 'member'];

/**
 * The `roles` section: `[{ id, label, description?, requires? }]`. Absent is
 * `null` — the app declares nothing and role names stay free strings. When
 * declared, every role the manifest gates on (an action's `auth.app_roles`, the
 * operator view's `admin_access.roles` and `audit.app_roles`) must be one of them,
 * (or, on an action, the platform's `member`), so a typo fails registration
 * instead of locking everyone out. The operator view already refuses `member`.
 */
export function validateRoles(
  raw: unknown,
  tools: ToolManifest[],
  operatorView: OperatorViewContract | null,
): { error: string } | { roles: DeclaredRole[] | null } {
  if (raw === undefined || raw === null) return { roles: null };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DECLARED_ROLES) {
    return { error: `roles must be an array of 1-${MAX_DECLARED_ROLES} { id, label, description?, requires? }` };
  }
  const roles: DeclaredRole[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `roles[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: `${at} must be an object` };
    const unknown = Object.keys(entry).find((k) => !['id', 'label', 'description', 'requires'].includes(k));
    if (unknown) return { error: `${at}: unknown field "${unknown}"` };
    const { id, label, description, requires } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !APP_ROLE_NAME_RE.test(id)) return { error: `${at}.id must match ${APP_ROLE_NAME_RE.source}` };
    if (RESERVED.includes(id)) return { error: `${at}.id "${id}" is managed by the platform and cannot be declared` };
    if (roles.some((r) => r.id === id)) return { error: `${at}: duplicate id "${id}"` };
    if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_CHARS) {
      return { error: `${at}.label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters` };
    }
    if (description !== undefined && (typeof description !== 'string' || !description.trim() || description.length > MAX_DESCRIPTION_CHARS)) {
      return { error: `${at}.description must be a non-empty string of at most ${MAX_DESCRIPTION_CHARS} characters when supplied` };
    }
    if (requires !== undefined && (!Array.isArray(requires) || !requires.every((r) => typeof r === 'string'))) {
      return { error: `${at}.requires must be an array of declared role ids` };
    }
    roles.push({ id, label: label.trim(), description: description === undefined ? null : description.trim(), requires: [...new Set((requires ?? []) as string[])] });
  }

  const ids = new Set(roles.map((r) => r.id));
  for (const [i, role] of roles.entries()) {
    const missing = role.requires.find((r) => !ids.has(r));
    if (missing !== undefined) return { error: `roles[${i}].requires: "${missing}" is not a declared role` };
  }
  const cycle = requiresCycle(roles);
  if (cycle) return { error: `roles: requires forms a cycle (${cycle.join(' -> ')})` };

  // `member` is every signed-in user's platform-managed role: never declared, always valid on an action.
  const undeclared = (ref: string, where: string) => (ids.has(ref) || ref === 'member' ? null : `${where}: role "${ref}" is not declared in roles`);
  for (const tool of tools) {
    for (const role of tool.auth?.app_roles ?? []) {
      const error = undeclared(role, `action "${tool.name}" auth.app_roles`);
      if (error) return { error };
    }
  }
  for (const role of operatorView?.admin_access?.roles ?? []) {
    const error = undeclared(role, 'operator_view.admin_access.roles');
    if (error) return { error };
  }
  for (const role of operatorView?.audit?.app_roles ?? []) {
    const error = undeclared(role, 'operator_view.audit.app_roles');
    if (error) return { error };
  }
  return { roles };
}

/** The first `requires` cycle, as the path that closes it, or null. */
function requiresCycle(roles: DeclaredRole[]): string[] | null {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const done = new Set<string>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    for (const next of byId.get(id)?.requires ?? []) {
      const found = visit(next, [...path, id]);
      if (found) return found;
    }
    done.add(id);
    return null;
  };
  for (const role of roles) {
    const found = visit(role.id, []);
    if (found) return found;
  }
  return null;
}

/** The declared roles `role` requires, transitively — granted with it. Empty for an undeclared role. */
export function requiredRoles(declared: DeclaredRole[], role: string): string[] {
  const byId = new Map(declared.map((r) => [r.id, r]));
  const out = new Set<string>();
  const stack = [...(byId.get(role)?.requires ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === role || out.has(id)) continue;
    out.add(id);
    stack.push(...(byId.get(id)?.requires ?? []));
  }
  return [...out];
}

/** The declared roles that require `role`, transitively — revoked with it. */
export function dependentRoles(declared: DeclaredRole[], role: string): string[] {
  return declared.filter((r) => r.id !== role && requiredRoles(declared, r.id).includes(role)).map((r) => r.id);
}
