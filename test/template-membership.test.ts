/**
 * The membership groups template (#189) is staged at templates/template-membership until it is
 * published as proappstore-online/template-membership. Same bar as the other two staged
 * templates: the manifest registers through the real backend route, the migrations pass the
 * additive-only deploy lint, and every scoped action fails closed for the wrong user or role
 * (PAS-DATA-022). Batches bind like the platform: one param pool, one clock reading, in order.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../packages/backend/src/index.js';
import { forbiddenMigrationStatement } from '../packages/backend/src/routes/deploy.js';
import { testToken, mockStmt, makeEnv } from '../packages/backend/src/test-helpers.js';

const ROOT = new URL('../templates/template-membership/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
type Param = { type: string; optional?: boolean; default?: unknown; max?: number };
type Tool = { name: string; operation: 'query' | 'execute' | 'batch'; sql?: string; statements?: string[]; params: Record<string, Param>; requires_auth: boolean; auth?: { app_roles?: string[]; caller_unscoped?: { reason: string } } };
const MANIFEST = read('mcp.json') as { tools: Tool[] };
const MIGRATIONS = read('migrations.json') as { migrations: { name: string; sql: string }[] };
const TOOLS = Object.fromEntries(MANIFEST.tools.map((t) => [t.name, t]));

type DatabaseSync = import('node:sqlite').DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS.migrations) db.exec(m.sql);
  return db;
}

function resolve(tool: Tool, params: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.params)) {
    let value = params[name];
    if (value === undefined || value === null) {
      if (schema.default !== undefined) value = schema.default;
      else if (schema.optional) value = null;
      else throw new Error(`${tool.name}: missing required parameter ${name}`);
    }
    if (value !== null && schema.type === 'integer') value = Number(value);
    out[name] = value;
  }
  for (const name of Object.keys(params)) if (!(name in tool.params)) throw new Error(`${tool.name}: unknown parameter ${name}`);
  return out;
}

function bind(sql: string, resolved: Record<string, unknown>, user: string, now: number) {
  const values: unknown[] = [];
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (name === '__user_id') values.push(user);
    else if (name === '__now') values.push(now);
    else if (name === '__uuid') values.push(randomUUID());
    else if (name in resolved) values.push(resolved[name]);
    else throw new Error(`unresolved parameter: ${name}`);
    return '?';
  });
  return [bound, values] as const;
}

let clock = 1_700_000_000_000;
const NOW = () => clock;
function makeCaller(db: DatabaseSync) {
  return (name: string, user: string, params: Record<string, unknown> = {}) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`no such action: ${name}`);
    const resolved = resolve(tool, params);
    const now = ++clock;
    if (tool.operation === 'batch') {
      db.exec('BEGIN');
      try {
        const changes = tool.statements!.map((s) => {
          const [sql, values] = bind(s, resolved, user, now);
          return Number(db.prepare(sql).run(...(values as never[])).changes);
        });
        db.exec('COMMIT');
        return changes;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    const [sql, values] = bind(tool.sql!, resolved, user, now);
    const stmt = db.prepare(sql);
    return tool.operation === 'query'
      ? (stmt.all(...(values as never[])) as Record<string, unknown>[])
      : Number(stmt.run(...(values as never[])).changes);
  };
}

describe('template-membership: registration (#189)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/validate')) {
        const db = freshDb();
        const body = JSON.parse(init!.body as string) as { statements: { id: string; sql: string; paramCount: number }[] };
        const results = body.statements.map((s) => {
          try { db.prepare(s.sql); return { id: s.id, ok: true }; }
          catch (e) { return { id: s.id, ok: false, error: e instanceof Error ? e.message : String(e) }; }
        });
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registers every tool through the backend route', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/template-membership/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) },
      makeEnv({}, db),
    );
    const body = (await res.json()) as { registered?: number; error?: string; warnings?: string[] };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.registered).toBe(MANIFEST.tools.length);
    expect(body.warnings).toEqual([]);
  });

  it('no public tools; the only unscoped statements are the app-admin tools gated by auth.app_roles', () => {
    expect(MANIFEST.tools.every((t) => t.requires_auth === true)).toBe(true);
    const unscoped = MANIFEST.tools.filter((t) => t.auth?.caller_unscoped).map((t) => t.name).sort();
    expect(unscoped).toEqual(['admin_delete_group', 'admin_list_groups']);
    for (const name of unscoped) expect(TOOLS[name]!.auth?.app_roles).toEqual(['admin']);
    for (const t of MANIFEST.tools.filter((t) => !t.auth?.caller_unscoped)) {
      for (const s of t.statements ?? [t.sql!]) expect(s, `${t.name}`).toContain(':__user_id');
    }
  });

  it('migrations are additive-only under the deploy lint', () => {
    for (const m of MIGRATIONS.migrations) expect(forbiddenMigrationStatement(m.sql), m.name).toBeNull();
  });
});

describe('template-membership: scoped actions fail closed for the wrong user or role', () => {
  const ADMIN = 'gh:admin';
  const MOD = 'gh:mod';
  const MEMBER = 'gh:member';
  const OUTSIDER = 'gh:outsider';
  const G = 'grp-1';

  function seeded() {
    const db = freshDb();
    const call = makeCaller(db);
    expect(call('create_group', ADMIN, { group_id: G, slug: 'chess-club', name: 'Chess Club', display_name: 'Ada' })).toEqual([1, 1, 1]);
    expect(call('create_join_code', ADMIN, { id: 'jc-mod', group_id: G, code: 'MOD-1', role: 'moderator' })).toBe(1);
    expect(call('create_join_code', ADMIN, { id: 'jc-mem', group_id: G, code: 'MEM-1', max_uses: 2 })).toBe(1);
    expect(call('join_group_by_code', MOD, { code: 'MOD-1', display_name: 'Mo' })).toEqual([1, 1, 1]);
    expect(call('join_group_by_code', MEMBER, { code: 'MEM-1', display_name: 'Mia' })).toEqual([1, 1, 1]);
    return { db, call };
  }
  const activity = (call: ReturnType<typeof makeCaller>, user: string) => (call('list_activity', user, { group_id: G }) as { action: string }[]).map((a) => a.action);

  it('create_group is idempotent; outsiders see nothing', () => {
    const { call } = seeded();
    expect(call('create_group', ADMIN, { group_id: G, slug: 'chess-club', name: 'Again', display_name: 'Ada' })).toEqual([0, 0, 0]);
    expect(call('get_group', OUTSIDER, { group_id: G })).toEqual([]);
    expect(call('list_members', OUTSIDER, { group_id: G })).toEqual([]);
    expect(call('list_events', OUTSIDER, { group_id: G })).toEqual([]);
    expect(call('list_messages', OUTSIDER, { group_id: G })).toEqual([]);
    expect(call('list_activity', OUTSIDER, { group_id: G })).toEqual([]);
    expect(call('list_my_groups', OUTSIDER)).toEqual([]);
    expect(call('get_group', MEMBER, { group_id: G })).toEqual([expect.objectContaining({ name: 'Chess Club', role: 'member', member_count: 3 })]);
    expect(activity(call, ADMIN).filter((a) => a === 'group.created')).toHaveLength(1);
  });

  it('join codes are consumable, role-carrying, and bounded by max_uses and expiry', () => {
    const { call } = seeded();
    expect(call('join_group_by_code', OUTSIDER, { code: 'MOD-1', display_name: 'Eve' })).toEqual([0, 0, 0]);
    expect(call('join_group_by_code', OUTSIDER, { code: 'nope', display_name: 'Eve' })).toEqual([0, 0, 0]);
    expect(call('join_group_by_code', 'gh:second', { code: 'MEM-1', display_name: 'Sam' })).toEqual([1, 1, 1]);
    expect(call('join_group_by_code', 'gh:third', { code: 'MEM-1', display_name: 'Tia' })).toEqual([0, 0, 0]);
    expect(call('create_join_code', ADMIN, { id: 'jc-old', group_id: G, code: 'OLD-1', expires_at: NOW() - 1 })).toBe(1);
    expect(call('join_group_by_code', 'gh:fourth', { code: 'OLD-1', display_name: 'Fay' })).toEqual([0, 0, 0]);
    expect(call('create_join_code', ADMIN, { id: 'jc-adm', group_id: G, code: 'ADM-1', role: 'admin' })).toBe(0);
    expect(call('create_join_code', MEMBER, { id: 'jc-x', group_id: G, code: 'X-1' })).toBe(0);
    expect(call('create_join_code', MOD, { id: 'jc-y', group_id: G, code: 'Y-1' })).toBe(1);
    expect(call('list_join_codes', MEMBER, { group_id: G })).toEqual([]);
    expect((call('list_join_codes', MOD, { group_id: G }) as { code: string }[]).map((c) => c.code).sort()).toEqual(['Y-1']);
    expect(call('revoke_join_code', MEMBER, { id: 'jc-y', group_id: G })).toBe(0);
    expect(call('revoke_join_code', MOD, { id: 'jc-y', group_id: G })).toBe(1);
    expect((call('list_members', ADMIN, { group_id: G }) as { user_id: string; role: string }[]).find((m) => m.user_id === MOD)!.role).toBe('moderator');
  });

  it('roles: admin only, never yourself; removal follows the role ladder; the last admin stays', () => {
    const { call } = seeded();
    expect(call('set_member_role', MOD, { group_id: G, user_id: MEMBER, role: 'admin' })).toEqual([0, 0]);
    expect(call('set_member_role', ADMIN, { group_id: G, user_id: ADMIN, role: 'member' })).toEqual([0, 0]);
    expect(call('set_member_role', ADMIN, { group_id: G, user_id: MEMBER, role: 'owner' })).toEqual([0, 0]);
    expect(call('set_member_role', ADMIN, { group_id: G, user_id: MEMBER, role: 'moderator' })).toEqual([1, 1]);
    expect(call('set_member_role', ADMIN, { group_id: G, user_id: MEMBER, role: 'member' })).toEqual([1, 1]);
    expect(call('add_member', MEMBER, { group_id: G, user_id: 'gh:new', display_name: 'New' })).toEqual([0, 0]);
    expect(call('add_member', MOD, { group_id: G, user_id: 'gh:new', display_name: 'New' })).toEqual([1, 1]);
    expect(call('add_member', MOD, { group_id: G, user_id: 'gh:new', display_name: 'New' })).toEqual([0, 0]);
    expect(call('remove_member', MEMBER, { group_id: G, user_id: 'gh:new' })).toEqual([0, 0, 0]);
    expect(call('remove_member', MOD, { group_id: G, user_id: ADMIN })).toEqual([0, 0, 0]);
    expect(call('remove_member', MOD, { group_id: G, user_id: 'gh:new' })).toEqual([0, 1, 1]);
    expect(call('remove_member', ADMIN, { group_id: G, user_id: ADMIN })).toEqual([0, 0, 0]);
    expect(call('remove_member', ADMIN, { group_id: G, user_id: MOD })).toEqual([0, 1, 1]);
    expect(call('leave_group', ADMIN, { group_id: G })).toBe(0);
    expect(call('leave_group', MEMBER, { group_id: G })).toBe(1);
    expect(call('update_group', MEMBER, { group_id: G, name: 'X' })).toEqual([0, 0]);
    expect(call('update_group', ADMIN, { group_id: G, name: 'Chess Club Sydney' })).toEqual([1, 1]);
    expect(activity(call, ADMIN)).toEqual(expect.arrayContaining(['member.role_changed', 'member.added', 'member.removed', 'group.updated']));
  });

  it('events: moderators create, members RSVP, capacity waitlists and a freed seat promotes', () => {
    const { call } = seeded();
    const t = NOW() + 86_400_000;
    expect(call('create_event', MEMBER, { id: 'ev-1', group_id: G, title: 'Blitz night', starts_at: t, capacity: 1 })).toEqual([0, 0]);
    expect(call('create_event', OUTSIDER, { id: 'ev-1', group_id: G, title: 'Blitz night', starts_at: t })).toEqual([0, 0]);
    expect(call('create_event', MOD, { id: 'ev-1', group_id: G, title: 'Blitz night', starts_at: t, capacity: 1 })).toEqual([1, 1]);
    expect(call('create_event', MOD, { id: 'ev-1', group_id: G, title: 'dup', starts_at: t })).toEqual([0, 0]);
    expect(call('get_event', OUTSIDER, { id: 'ev-1', group_id: G })).toEqual([]);
    expect(call('rsvp_event', OUTSIDER, { id: 'r-o', event_id: 'ev-1', status: 'going' })).toEqual([0, 0, 0, 0]);
    expect(call('rsvp_event', MEMBER, { id: 'r-m', event_id: 'ev-1', status: 'maybe' })).toEqual([0, 0, 0, 0]);
    expect(call('rsvp_event', MEMBER, { id: 'r-m', event_id: 'ev-1', status: 'going' })).toEqual([0, 1, 0, 1]);
    expect(call('rsvp_event', MEMBER, { id: 'r-m2', event_id: 'ev-1', status: 'going' })).toEqual([1, 0, 0, 1]); // still going, not bumped by itself
    expect(call('rsvp_event', MOD, { id: 'r-x', event_id: 'ev-1', status: 'going' })).toEqual([0, 1, 0, 1]);
    let rows = call('list_rsvps', ADMIN, { event_id: 'ev-1' }) as { user_id: string; status: string; waitlist_position: number | null }[];
    expect(rows).toEqual([
      expect.objectContaining({ user_id: MEMBER, status: 'going', waitlist_position: null }),
      expect.objectContaining({ user_id: MOD, status: 'waitlist', waitlist_position: 1 }),
    ]);
    expect((call('get_event', MEMBER, { id: 'ev-1', group_id: G })[0] as { going_count: number; waitlist_count: number; my_status: string })).toEqual(expect.objectContaining({ going_count: 1, waitlist_count: 1, my_status: 'going' }));
    expect(call('rsvp_event', MEMBER, { id: 'r-m3', event_id: 'ev-1', status: 'not_going' })).toEqual([1, 0, 1, 1]);
    rows = call('list_rsvps', ADMIN, { event_id: 'ev-1' }) as typeof rows;
    expect(rows).toEqual([expect.objectContaining({ user_id: MOD, status: 'going', waitlist_position: null })]);
    expect(call('list_rsvps', OUTSIDER, { event_id: 'ev-1' })).toEqual([]);
    expect(call('update_event', MEMBER, { id: 'ev-1', group_id: G, title: 'Hijack', starts_at: t })).toEqual([0, 0]);
    expect(call('update_event', MOD, { id: 'ev-1', group_id: G, title: 'Blitz night II', starts_at: t, capacity: 2 })).toEqual([1, 1]);
    expect((call('list_events', MEMBER, { group_id: G }) as { title: string }[]).map((e) => e.title)).toEqual(['Blitz night II']);
    expect(call('list_events', MEMBER, { group_id: G, past: 1 })).toEqual([]);
    expect(call('delete_event', MEMBER, { id: 'ev-1', group_id: G })).toEqual([0, 0, 0]);
    expect(call('delete_event', MOD, { id: 'ev-1', group_id: G })).toEqual([2, 1, 1]);
    expect(call('get_event', MOD, { id: 'ev-1', group_id: G })).toEqual([]);
    expect(activity(call, ADMIN)).toEqual(expect.arrayContaining(['event.created', 'event.rsvp', 'event.updated', 'event.deleted']));
  });

  it('thread: members post, owners or moderators delete, keyset pagination, all scoped', () => {
    const { call } = seeded();
    expect(call('post_message', OUTSIDER, { id: 'm-o', group_id: G, content: 'hi' })).toBe(0);
    expect(call('post_message', MEMBER, { id: 'm-1', group_id: G, content: 'Anyone for a game?' })).toBe(1);
    expect(call('post_message', MEMBER, { id: 'm-1', group_id: G, content: 'dup' })).toBe(0);
    expect(call('post_message', MOD, { id: 'm-2', group_id: G, content: 'Sure' })).toBe(1);
    const page = call('list_messages', MEMBER, { group_id: G }) as { id: string; display_name: string; created_at: number }[];
    expect(page.map((m) => m.id)).toEqual(['m-2', 'm-1']);
    expect(page[1]!.display_name).toBe('Mia');
    expect((call('list_messages', MEMBER, { group_id: G, before: page[0]!.created_at }) as { id: string }[]).map((m) => m.id)).toEqual(['m-1']);
    expect(call('delete_message', MEMBER, { id: 'm-2', group_id: G })).toBe(0);
    expect(call('delete_message', MOD, { id: 'm-1', group_id: G })).toBe(1);
    expect(call('delete_message', MOD, { id: 'm-2', group_id: G })).toBe(1);
    expect(call('update_my_profile', OUTSIDER, { group_id: G, display_name: 'Eve' })).toBe(0);
    expect(call('update_my_profile', MEMBER, { group_id: G, display_name: 'Mia B.' })).toBe(1);
  });

  it('app-admin tools are gated by the platform app role, not by group membership', () => {
    const { call } = seeded();
    // The SQL itself is unscoped by design; the executor refuses callers without the app role.
    expect(TOOLS.admin_list_groups!.auth).toEqual(expect.objectContaining({ app_roles: ['admin'] }));
    expect(TOOLS.admin_delete_group!.auth).toEqual(expect.objectContaining({ app_roles: ['admin'] }));
    expect((call('admin_list_groups', 'gh:app-admin') as { member_count: number }[])[0]!.member_count).toBe(3);
    expect(call('admin_delete_group', 'gh:app-admin', { group_id: G }).at(-1)).toBe(1);
    expect(call('list_my_groups', ADMIN)).toEqual([]);
  });
});
