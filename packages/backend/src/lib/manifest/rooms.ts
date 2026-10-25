import { actionCallers, type ToolManifest } from '../action-sql.js';
import { MAX_ROOM_RULES_PER_APP, ROOM_PATTERN, USER_ROOM_PREFIX, type RoomRule } from '../room-access.js';

// ── Rooms (#351) ─────────────────────────────────────────────────────────────

/**
 * The `rooms` section: `[{ pattern: "<prefix>:*", authorize: "<action>" }]`. A
 * room whose id starts with the prefix admits a signed-in user only when the
 * authorize action returns a row for them (lib/room-access.ts). The action runs
 * as the joining user, with params `room` and `key`: a registered query that
 * requires sign-in, lists "user" in its callers, takes no other required param,
 * and is neither scheduled nor step-up (a room join carries no recent sign-in).
 * `user:` is the platform's own and cannot be declared.
 */
export function validateRooms(raw: unknown, tools: ToolManifest[]): { error: string } | { rules: RoomRule[] } {
  if (raw === undefined || raw === null) return { rules: [] };
  if (!Array.isArray(raw) || raw.length > MAX_ROOM_RULES_PER_APP) return { error: `rooms must be an array of at most ${MAX_ROOM_RULES_PER_APP} rules` };
  const rules: RoomRule[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `rooms[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `${at} must be an object` };
    const unknown = Object.keys(item).find((k) => k !== 'pattern' && k !== 'authorize');
    if (unknown) return { error: `${at}: unknown field "${unknown}"` };
    const { pattern, authorize } = item as { pattern?: unknown; authorize?: unknown };
    const m = typeof pattern === 'string' ? ROOM_PATTERN.exec(pattern) : null;
    if (!m) return { error: `${at}.pattern must be a lowercase prefix ending in ":" followed by "*", e.g. "chat:*"` };
    const prefix = m[1]!;
    if (prefix === USER_ROOM_PREFIX) return { error: `${at}.pattern: "user:*" is the platform's own (only user <uid> may join user:<uid>)` };
    if (rules.some((r) => r.prefix === prefix)) return { error: `${at}: duplicate pattern "${pattern}"` };
    const tool = tools.find((t) => t.name === authorize);
    if (typeof authorize !== 'string' || !tool) return { error: `${at}.authorize must name an action in this manifest` };
    if (tool.operation !== 'query') return { error: `${at}.authorize "${authorize}" must be a query action (it returns a row when the user may join)` };
    if (tool.requires_auth !== true) return { error: `${at}.authorize "${authorize}" must require sign-in (it runs as the joining user)` };
    if (!actionCallers(tool).includes('user')) return { error: `${at}.authorize "${authorize}" must list "user" in its callers` };
    if (tool.schedule !== undefined || tool.step_up) return { error: `${at}.authorize "${authorize}" cannot be scheduled or require step_up` };
    const other = Object.entries(tool.params ?? {}).find(([name, p]) => name !== 'room' && name !== 'key' && !p.optional && p.default === undefined);
    if (other) return { error: `${at}.authorize "${authorize}": param "${other[0]}" is required, but a join passes only "room" and "key"` };
    rules.push({ prefix, authorize });
  }
  return { rules };
}
