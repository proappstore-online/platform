import type { ToolManifest } from '../action-sql.js';
import { MAX_VISIBILITY_ROLES, type AppVisibility } from '../visibility.js';
import { OPERATOR_ROLE } from './operator.js';

/**
 * Validate `visibility` (#259): a private app is served — origin, data, MCP — only
 * to its team (creator, team members, platform admins) and to holders of up to five app roles. `member` is refused for the
 * reason the operator gate refuses it. A private app cannot register a public
 * (requires_auth false) action: an anonymous data path would defeat the gate.
 */
export function validateVisibility(visibility: unknown, tools: ToolManifest[]): { error: string } | { visibility: AppVisibility | null } {
  if (visibility === undefined || visibility === null) return { visibility: null };
  if (typeof visibility !== 'object' || Array.isArray(visibility)) return { error: 'visibility must be an object' };
  const { mode, roles = [] } = visibility as Record<string, unknown>;
  if (mode !== 'public' && mode !== 'private') return { error: "visibility.mode must be 'public' or 'private'" };
  if (!Array.isArray(roles) || roles.length > MAX_VISIBILITY_ROLES) return { error: `visibility.roles must be an array of at most ${MAX_VISIBILITY_ROLES} app role names` };
  for (const role of roles) {
    if (typeof role !== 'string' || !OPERATOR_ROLE.test(role)) return { error: 'visibility.roles entries must be app role names ([a-z][a-z0-9_-], max 50 chars)' };
    if (role === 'member') return { error: "visibility.roles cannot include 'member' (every signed-in user holds it)" };
  }
  if (new Set(roles).size !== roles.length) return { error: 'visibility.roles must not repeat a role' };
  if (mode === 'private') {
    const open = tools.find((t) => t.requires_auth === false);
    if (open) return { error: `visibility: a private app cannot register public action "${open.name}" (requires_auth false)` };
  }
  return { visibility: { mode, roles: roles as string[] } };
}
