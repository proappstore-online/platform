/**
 * Team-role gate for ProjectDO routes: which role a caller needs for a path + method.
 * Split out of project-do.ts; logic unchanged.
 */

// Team role ladder (mirrors the backend's TEAM_ROLES). Index = privilege rank.
export const TEAM_ROLES = ['viewer', 'po', 'developer', 'admin', 'owner'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Minimum team role required for a DO route. Destructive, spend-config, and
 * deploy routes require `owner`; other mutations require `developer`; reads
 * allow any member (`viewer`). Keep in sync with the fetch() dispatch table.
 */
export function minRoleFor(path: string, method: string): TeamRole {
  const ownerRoutes: ReadonlyArray<readonly [string, string]> = [
    ['/project/play', 'POST'], ['/project/pause', 'POST'],
    ['/roles', 'PUT'], ['/budget', 'PUT'],
    ['/files', 'POST'], ['/files', 'DELETE'],
    ['/deploy', 'POST'],
    ['/chat/history', 'DELETE'], ['/activity', 'DELETE'],
    ['/shares', 'POST'], ['/generate-listing', 'POST'],
  ];
  if (ownerRoutes.some(([p, m]) => p === path && m === method)) return 'owner';
  // Destructive ticket/memory sub-routes.
  if (method === 'DELETE' && (/^\/tickets\/[a-f0-9-]+$/.test(path) || /^\/memory\/[a-f0-9-]+$/.test(path))) {
    return 'owner';
  }
  if (method === 'GET') return 'viewer';
  return 'developer';
}
