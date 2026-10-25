import type { ProjectHost } from './project-host.ts';
import type { Role } from './types.ts';
import { json } from './store.ts';
import { deployStatusOf } from './deploy-stage.ts';
import { TEAM_ROLES, minRoleFor, type TeamRole } from './role-gate.ts';

export function assertAccess(h: ProjectHost, request: Request): Response | null {
  const userId = request.headers.get('X-User-Id');
  if (!userId) return json({ error: 'forbidden' }, 403);
  const row = h.state.storage.sql
    .exec('SELECT owner_id FROM project LIMIT 1')
    .toArray()[0] as { owner_id: string } | undefined;
  // If no project exists yet (init), allow (ownership set during init)
  if (!row) return null;
  // Owner always has access
  if (row.owner_id === userId) return null;
  // Team member access: the router sets X-Team-Role ONLY after verifying
  // membership in D1. Require a KNOWN role value (not mere header presence) as
  // defence-in-depth against a smuggled/garbage header. Fine-grained
  // per-route checks happen in assertRole.
  const teamRole = request.headers.get('X-Team-Role');
  if (teamRole && TEAM_ROLES.includes(teamRole as TeamRole)) return null;
  return json({ error: 'not_found' }, 404);
}

export function callerRole(h: ProjectHost, request: Request): TeamRole {
  const userId = request.headers.get('X-User-Id');
  const row = h.state.storage.sql
    .exec('SELECT owner_id FROM project LIMIT 1')
    .toArray()[0] as { owner_id: string } | undefined;
  if (row && row.owner_id === userId) return 'owner';
  const forwarded = request.headers.get('X-Team-Role');
  return TEAM_ROLES.includes(forwarded as TeamRole) ? (forwarded as TeamRole) : 'viewer';
}

export function assertRole(h: ProjectHost, request: Request, path: string): Response | null {
  const min = minRoleFor(path, request.method);
  if (min === 'viewer') return null;
  const role = callerRole(h, request);
  if (TEAM_ROLES.indexOf(role) < TEAM_ROLES.indexOf(min)) {
    return json({ error: 'forbidden', detail: `requires '${min}' role (you have '${role}')` }, 403);
  }
  return null;
}

/** The first frame on every WebSocket: what a client needs to render before any event arrives. */
export function helloFrame(h: ProjectHost): Record<string, unknown> {
  const row = h.state.storage.sql.exec('SELECT * FROM project LIMIT 1').toArray()[0] as Record<string, unknown> | undefined;
  return {
    type: 'hello',
    at: Date.now(),
    project: row
      ? { slug: row.slug, name: row.name, status: row.status ?? 'paused', deploy: deployStatusOf(row, String(row.slug)) }
      : null,
    // What the client may send: "ping" is answered "pong" without waking the DO.
    keepalive: { ping: 'ping', pong: 'pong' },
    sockets: h.state.getWebSockets().length,
  };
}

export async function notifyOwnerOfTransition(h: ProjectHost, event: Record<string, unknown>): Promise<void> {
  const NOTIFY: Record<string, string> = {
    'needs-input': 'needs your input',
    done: 'is done ✓',
    failed: 'failed',
  };
  const what = NOTIFY[event.to as string];
  if (!what || !h.env.PAS_BACKEND || !h.env.INTERNAL_TOKEN) return;
  const proj = h.state.storage.sql
    .exec('SELECT owner_id, slug, name FROM project LIMIT 1')
    .toArray()[0] as { owner_id: string; slug: string; name: string } | undefined;
  if (!proj) return;
  const ticketId = typeof event.ticketId === 'string' ? event.ticketId : undefined;
  let ticketTitle = '';
  if (ticketId) {
    const t = h.state.storage.sql.exec('SELECT title FROM tickets WHERE id = ?', ticketId).toArray()[0] as { title: string } | undefined;
    ticketTitle = t?.title ?? '';
  }
  const appName = proj.name || proj.slug;
  await h.env.PAS_BACKEND.fetch(new Request('https://api.proappstore.online/v1/notifications/send-internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': h.env.INTERNAL_TOKEN },
    body: JSON.stringify({
      userId: proj.owner_id,
      appId: 'console',
      title: ticketTitle ? `${ticketTitle} ${what}` : `${appName} — a task ${what}`,
      body: event.to === 'needs-input' ? `Tap to respond · ${appName}` : appName,
      url: `https://console.proappstore.online/#/apps/${proj.slug}/build`,
      tag: ticketId ?? proj.slug, // collapse repeated updates for the same ticket
    }),
  }));
}
