/**
 * The back-office workspace template (#190) is staged at templates/template-workspace
 * until it is published as proappstore-online/template-workspace. As with the marketplace
 * template: its manifest registers through the real backend route, its migrations pass the
 * additive-only deploy lint, and every scoped action fails closed for the wrong user or the
 * wrong role (PAS-DATA-022). Batch tools run the way the platform runs them — one param pool,
 * one clock reading, statements in order — so the audit row lands only with its write.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../packages/backend/src/index.js';
import { forbiddenMigrationStatement } from '../packages/backend/src/routes/deploy.js';
import { testToken, mockStmt, makeEnv } from '../packages/backend/src/test-helpers.js';

const ROOT = new URL('../templates/template-workspace/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
type Param = { type: string; optional?: boolean; default?: unknown; max?: number };
type Tool = { name: string; operation: 'query' | 'execute' | 'batch'; sql?: string; statements?: string[]; params: Record<string, Param>; requires_auth: boolean };
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

/** Binds like the platform: one param pool and one clock reading per call; :__uuid per occurrence. */
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

describe('template-workspace: registration (#190)', () => {
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
      '/v1/apps/template-workspace/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) },
      makeEnv({}, db),
    );
    const body = (await res.json()) as { registered?: number; error?: string; warnings?: string[] };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.registered).toBe(MANIFEST.tools.length);
    expect(body.warnings).toEqual([]);
  });

  it('has no public tools, and every write that changes state carries its audit row in the same batch', () => {
    expect(MANIFEST.tools.every((t) => t.requires_auth === true)).toBe(true);
    const audited = MANIFEST.tools.filter((t) => t.operation === 'batch');
    for (const t of audited) expect(t.statements!.some((s) => s.includes('INSERT INTO activity_log')), t.name).toBe(true);
    expect(audited.map((t) => t.name)).toEqual(expect.arrayContaining(['create_workspace', 'set_member_role', 'grant_permission', 'accept_invitation', 'create_record', 'submit_record', 'decide_approval', 'close_record', 'archive_record']));
  });

  it('migrations are additive-only under the deploy lint', () => {
    for (const m of MIGRATIONS.migrations) expect(forbiddenMigrationStatement(m.sql), m.name).toBeNull();
  });
});

describe('template-workspace: scoped actions fail closed for the wrong user or role', () => {
  const ADMIN = 'gh:admin';
  const MANAGER = 'gh:manager';
  const MEMBER = 'gh:member';
  const OUTSIDER = 'gh:outsider';
  const W = 'ws-1';

  function seeded() {
    const db = freshDb();
    const call = makeCaller(db);
    expect(call('create_workspace', ADMIN, { workspace_id: W, name: 'Acme', display_name: 'Ada' })).toEqual([1, 1, 1]);
    // manager and member join through consumable invitations
    call('create_invitation', ADMIN, { id: 'inv-mgr', workspace_id: W, login: 'max', role: 'manager' });
    call('create_invitation', ADMIN, { id: 'inv-mem', workspace_id: W, login: 'mia' });
    expect(call('accept_invitation', MANAGER, { code: 'inv-mgr', display_name: 'Max' })).toEqual([1, 1, 1]);
    expect(call('accept_invitation', MEMBER, { code: 'inv-mem', display_name: 'Mia' })).toEqual([1, 1, 1]);
    return { db, call };
  }
  const audit = (call: ReturnType<typeof makeCaller>, user: string, action: string) =>
    (call('list_activity', user, { workspace_id: W }) as { action: string }[]).filter((a) => a.action === action);

  it('create_workspace is idempotent and outsiders see nothing', () => {
    const { call } = seeded();
    expect(call('create_workspace', ADMIN, { workspace_id: W, name: 'Acme again', display_name: 'Ada' })).toEqual([0, 0, 0]);
    expect(call('get_workspace', ADMIN, { workspace_id: W })).toEqual([expect.objectContaining({ name: 'Acme', role: 'admin' })]);
    expect(call('get_workspace', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect(call('list_members', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect(call('list_activity', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect(call('list_my_workspaces', OUTSIDER)).toEqual([]);
    expect((call('list_members', MEMBER, { workspace_id: W }) as unknown[]).length).toBe(3);
    expect(audit(call, ADMIN, 'workspace.created')).toHaveLength(1);
  });

  it('invitations are consumable and the role comes from the invitation, never the client', () => {
    const { call } = seeded();
    expect(call('accept_invitation', OUTSIDER, { code: 'inv-mgr', display_name: 'Eve' })).toEqual([0, 0, 0]);
    expect(call('accept_invitation', OUTSIDER, { code: 'nope', display_name: 'Eve' })).toEqual([0, 0, 0]);
    expect(call('create_invitation', MEMBER, { id: 'inv-x', workspace_id: W, role: 'admin' })).toBe(0);
    expect(call('create_invitation', ADMIN, { id: 'inv-adm', workspace_id: W, role: 'admin' })).toBe(0);
    expect(call('create_invitation', MANAGER, { id: 'inv-2', workspace_id: W })).toBe(0);
    call('grant_permission', ADMIN, { workspace_id: W, user_id: MANAGER, key: 'manage_members' });
    expect(call('create_invitation', MANAGER, { id: 'inv-2', workspace_id: W })).toBe(1);
    expect(call('revoke_invitation', MEMBER, { id: 'inv-2', workspace_id: W })).toBe(0);
    expect(call('list_invitations', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect(call('revoke_invitation', MANAGER, { id: 'inv-2', workspace_id: W })).toBe(1);
    expect((call('list_members', ADMIN, { workspace_id: W }) as { user_id: string; role: string }[]).find((m) => m.user_id === MANAGER)!.role).toBe('manager');
  });

  it('roles and permissions: admin only, never yourself, audited', () => {
    const { call } = seeded();
    expect(call('set_member_role', MANAGER, { workspace_id: W, user_id: MEMBER, role: 'admin' })).toEqual([0, 0]);
    expect(call('set_member_role', ADMIN, { workspace_id: W, user_id: ADMIN, role: 'member' })).toEqual([0, 0]);
    expect(call('set_member_role', ADMIN, { workspace_id: W, user_id: MEMBER, role: 'owner' })).toEqual([0, 0]);
    expect(call('set_member_role', ADMIN, { workspace_id: W, user_id: MEMBER, role: 'manager' })).toEqual([1, 1]);
    expect(call('grant_permission', MEMBER, { workspace_id: W, user_id: MEMBER, key: 'approve' })).toEqual([0, 0]);
    expect(call('grant_permission', ADMIN, { workspace_id: W, user_id: OUTSIDER, key: 'approve' })).toEqual([0, 0]);
    expect(call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'delete_everything' })).toEqual([0, 0]);
    expect(call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'approve' })).toEqual([1, 1]);
    expect(call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'approve' })).toEqual([0, 0]);
    expect(call('revoke_permission', MANAGER, { workspace_id: W, user_id: MEMBER, key: 'approve' })).toEqual([0, 0]);
    expect(call('revoke_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'approve' })).toEqual([1, 1]);
    expect(call('remove_member', MANAGER, { workspace_id: W, user_id: MEMBER })).toEqual([0, 0, 0]);
    expect(call('remove_member', ADMIN, { workspace_id: W, user_id: ADMIN })).toEqual([0, 0, 0]);
    expect(call('remove_member', ADMIN, { workspace_id: W, user_id: MEMBER })).toEqual([0, 1, 1]);
    expect(call('leave_workspace', ADMIN, { workspace_id: W })).toBe(0);
    expect(call('leave_workspace', MANAGER, { workspace_id: W })).toBe(1);
    expect(call('rename_workspace', MANAGER, { workspace_id: W, name: 'X' })).toEqual([0, 0]);
    expect(call('rename_workspace', ADMIN, { workspace_id: W, name: 'Acme Ltd' })).toEqual([1, 1]);
    expect(audit(call, ADMIN, 'member.role_changed')).toHaveLength(1);
    expect(audit(call, ADMIN, 'member.removed')).toHaveLength(1);
  });

  it('record lifecycle: draft → submitted → approved → closed, guarded on the state the caller saw', () => {
    const { call } = seeded();
    expect(call('create_record', OUTSIDER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'Intruder' })).toEqual([0, 0]);
    expect(call('create_record', MEMBER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'March invoice', amount: 1200 })).toEqual([1, 1]);
    expect(call('create_record', MEMBER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'dup' })).toEqual([0, 0]);
    expect(call('get_record', OUTSIDER, { id: 'r1', workspace_id: W })).toEqual([]);
    expect(call('update_record', OUTSIDER, { id: 'r1', workspace_id: W, title: 'Hijack' })).toEqual([0, 0]);
    expect(call('update_record', MEMBER, { id: 'r1', workspace_id: W, title: 'March invoice (v2)', amount: 1250 })).toEqual([1, 1]);
    expect(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'approved' })).toEqual([0, 0, 0]);
    expect(call('close_record', ADMIN, { id: 'r1', workspace_id: W })).toEqual([0, 0]);
    expect(call('submit_record', OUTSIDER, { id: 'r1', workspace_id: W, approval_id: 'a0' })).toEqual([0, 0, 0]);
    expect(call('submit_record', MEMBER, { id: 'r1', workspace_id: W, approval_id: 'a1', note: 'please' })).toEqual([1, 1, 1]);
    expect(call('submit_record', MEMBER, { id: 'r1', workspace_id: W, approval_id: 'a2' })).toEqual([0, 0, 0]);
    expect(call('update_record', MEMBER, { id: 'r1', workspace_id: W, title: 'too late' })).toEqual([0, 0]);
    expect((call('list_pending_approvals', MANAGER, { workspace_id: W }) as unknown[]).length).toBe(1);
    expect(call('list_pending_approvals', OUTSIDER, { workspace_id: W })).toEqual([]);
    // the requester cannot approve their own submission even with the permission; a manager needs the key
    call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'approve' });
    expect(call('decide_approval', MEMBER, { id: 'a1', workspace_id: W, decision: 'approved' })).toEqual([0, 0, 0]);
    expect(call('decide_approval', MANAGER, { id: 'a1', workspace_id: W, decision: 'approved' })).toEqual([0, 0, 0]);
    expect(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'maybe' })).toEqual([0, 0, 0]);
    expect(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'rejected', note: 'wrong amount' })).toEqual([1, 1, 1]);
    expect(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'approved' })).toEqual([0, 0, 0]);
    expect((call('get_record', MEMBER, { id: 'r1', workspace_id: W })[0] as { status: string }).status).toBe('rejected');
    expect(call('update_record', MEMBER, { id: 'r1', workspace_id: W, title: 'March invoice (v3)', amount: 1200 })).toEqual([1, 1]);
    expect(call('submit_record', MEMBER, { id: 'r1', workspace_id: W, approval_id: 'a2' })).toEqual([1, 1, 1]);
    call('grant_permission', ADMIN, { workspace_id: W, user_id: MANAGER, key: 'approve' });
    expect(call('decide_approval', MANAGER, { id: 'a2', workspace_id: W, decision: 'approved' })).toEqual([1, 1, 1]);
    expect(call('close_record', MEMBER, { id: 'r1', workspace_id: W })).toEqual([0, 0]);
    expect(call('close_record', MANAGER, { id: 'r1', workspace_id: W })).toEqual([1, 1]);
    expect(call('close_record', MANAGER, { id: 'r1', workspace_id: W })).toEqual([0, 0]);
    const rec = call('get_record', MEMBER, { id: 'r1', workspace_id: W })[0] as { status: string; approvals: string };
    expect(rec.status).toBe('closed');
    expect((JSON.parse(rec.approvals) as { decision: string }[]).map((a) => a.decision).sort()).toEqual(['approved', 'rejected']);
    expect(audit(call, ADMIN, 'record.decided')).toHaveLength(2);
    expect(audit(call, ADMIN, 'record.submitted')).toHaveLength(2);
    expect(audit(call, ADMIN, 'record.closed')).toHaveLength(1);
    expect(call('archive_record', MEMBER, { id: 'r1', workspace_id: W })).toEqual([0, 0]);
    expect(call('archive_record', ADMIN, { id: 'r1', workspace_id: W })).toEqual([1, 1]);
    expect(call('get_record', ADMIN, { id: 'r1', workspace_id: W })).toEqual([]);
  });

  it('lists, stats, export and the audit trail apply the membership predicate; export needs its permission', () => {
    const { call } = seeded();
    call('create_record', MEMBER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'One', amount: 10 });
    call('create_record', MANAGER, { id: 'r2', workspace_id: W, type: 'expense', title: 'Two', amount: 5 });
    expect((call('list_records', MEMBER, { workspace_id: W }) as unknown[]).length).toBe(2);
    expect((call('list_records', MEMBER, { workspace_id: W, type: 'expense' }) as unknown[]).length).toBe(1);
    expect((call('list_records', MEMBER, { workspace_id: W, q: 'one' }) as unknown[]).length).toBe(1);
    const first = (call('list_records', MEMBER, { workspace_id: W }) as { created_at: number }[])[0]!;
    expect((call('list_records', MEMBER, { workspace_id: W, before: first.created_at }) as unknown[]).length).toBe(1);
    expect(call('list_records', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect(call('record_stats', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect(call('record_stats', MEMBER, { workspace_id: W })).toEqual([{ status: 'draft', count: 2, total: 15 }]);
    expect(call('export_records', MEMBER, { workspace_id: W })).toEqual([]);
    expect(call('export_records', OUTSIDER, { workspace_id: W })).toEqual([]);
    expect((call('export_records', ADMIN, { workspace_id: W }) as unknown[]).length).toBe(2);
    call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'export' });
    expect((call('export_records', MEMBER, { workspace_id: W }) as unknown[]).length).toBe(2);
    expect((call('list_activity', MEMBER, { workspace_id: W, entity_id: 'r1' }) as unknown[]).length).toBe(1);
    expect(call('update_my_profile', OUTSIDER, { workspace_id: W, display_name: 'Eve' })).toBe(0);
    expect(call('update_my_profile', MEMBER, { workspace_id: W, display_name: 'Mia B.' })).toBe(1);
  });
});
