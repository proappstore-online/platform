/**
 * The marketplace template (#191) is staged at templates/template-marketplace until
 * it is published as proappstore-online/template-marketplace. Its manifest and
 * migrations must pass exactly what a real deploy applies — registration through the
 * backend route (manifest validation, PAS-DATA-011 public-tool rules, the :__user_id
 * scoping rule of #150, schema coherence) and the additive-only migration lint — and
 * every scoped action must fail closed for the wrong user (PAS-DATA-022).
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../packages/backend/src/index.js';
import { forbiddenMigrationStatement } from '../packages/backend/src/routes/deploy.js';
import { testToken, mockStmt, makeEnv } from '../packages/backend/src/test-helpers.js';

const ROOT = new URL('../templates/template-marketplace/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
type Param = { type: string; optional?: boolean; default?: unknown; max?: number };
type Tool = { name: string; operation: 'query' | 'execute' | 'batch'; sql?: string; statements?: string[]; params: Record<string, Param>; requires_auth: boolean };
const MANIFEST = read('mcp.json') as { tools: Tool[] };
const MIGRATIONS = read('migrations.json') as { migrations: { name: string; sql: string }[] };
const TOOLS = Object.fromEntries(MANIFEST.tools.map((t) => [t.name, t]));

// Vite's builtin list predates node:sqlite (it strips the prefix and cannot find a bare
// "sqlite"); requiring it bypasses the transform, as project-do-update-ticket.test.ts does.
type DatabaseSync = import('node:sqlite').DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

// --- A real SQLite built from migrations.json, bound the way the platform binds ------------

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

function bind(sql: string, resolved: Record<string, unknown>, user: string | null) {
  const values: unknown[] = [];
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (name === '__user_id') { if (user === null) throw new Error('public tool bound a user'); values.push(user); }
    else if (name === '__now') values.push(Date.now());
    else if (name === '__uuid') values.push(randomUUID());
    else if (name in resolved) values.push(resolved[name]);
    else throw new Error(`unresolved parameter: ${name}`);
    return '?';
  });
  return [bound, values] as const;
}

function makeCaller(db: DatabaseSync) {
  return (name: string, user: string | null, params: Record<string, unknown> = {}) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`no such action: ${name}`);
    if (user === null && tool.requires_auth) throw new Error(`${name} requires auth`);
    const resolved = resolve(tool, params);
    const [sql, values] = bind(tool.sql!, resolved, user);
    const stmt = db.prepare(sql);
    return tool.operation === 'query'
      ? (stmt.all(...(values as never[])) as Record<string, unknown>[])
      : Number(stmt.run(...(values as never[])).changes);
  };
}

// --- Registration through the real backend route ---------------------------------------

describe('template-marketplace: registration (#191)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/validate')) {
        // Schema coherence the way the data worker checks it: prepare each statement
        // against the migrated schema without executing it.
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

  it('registers every tool: manifest rules, public-tool rules, :__user_id scoping, schema coherence', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/template-marketplace/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) },
      makeEnv({}, db),
    );
    const body = (await res.json()) as { registered?: number; error?: string; warnings?: string[] };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.registered).toBe(MANIFEST.tools.length);
    expect(body.warnings).toEqual([]);
  });

  it('public tools are exactly the catalogue reads, name their columns and never expose ids of reviewers', () => {
    const pub = MANIFEST.tools.filter((t) => t.requires_auth === false).map((t) => t.name).sort();
    expect(pub).toEqual(['get_listing', 'list_listings', 'list_reviews', 'listing_stats', 'search_listings']);
    for (const name of pub) {
      const sql = TOOLS[name]!.sql!;
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).toMatch(/\bLIMIT\s+\d+\b/i);
    }
    expect(TOOLS.list_reviews!.sql).not.toContain('author_id');
  });

  it('migrations are additive-only under the deploy lint', () => {
    for (const m of MIGRATIONS.migrations) expect(forbiddenMigrationStatement(m.sql), m.name).toBeNull();
    expect(MIGRATIONS.migrations.map((m) => m.name)).toEqual([...MIGRATIONS.migrations.map((m) => m.name)].sort());
  });
});

// --- Negative tests per scoped action (PAS-DATA-022) -------------------------------------

describe('template-marketplace: scoped actions fail closed for the wrong user', () => {
  const OWNER = 'gh:owner';
  const SEEKER = 'gh:seeker';
  const STRANGER = 'gh:stranger';
  const L = 'listing-1';

  function seeded() {
    const db = freshDb();
    const call = makeCaller(db);
    expect(call('create_listing', OWNER, { id: L, owner_name: 'Olive', title: 'Sunny room', category: 'room', price: 40, price_unit: 'night' })).toBe(1);
    return { db, call };
  }

  it('create_listing is idempotent by client id', () => {
    const { call } = seeded();
    expect(call('create_listing', OWNER, { id: L, owner_name: 'Olive', title: 'Sunny room again' })).toBe(0);
    expect((call('get_listing', null, { id: L }) as { title: string }[])[0]!.title).toBe('Sunny room');
  });

  it('only the owner can update, pause or archive a listing', () => {
    const { call } = seeded();
    expect(call('update_listing', STRANGER, { id: L, title: 'Hijacked' })).toBe(0);
    expect(call('set_listing_status', STRANGER, { id: L, status: 'archived' })).toBe(0);
    expect(call('update_listing', OWNER, { id: L, title: 'Sunny room, renovated' })).toBe(1);
    expect(call('set_listing_status', OWNER, { id: L, status: 'archived' })).toBe(1);
    expect(call('get_listing', null, { id: L })).toEqual([]);
    expect(call('set_listing_status', OWNER, { id: L, status: 'deleted' })).toBe(0);
    expect(call('get_my_listing', STRANGER, { id: L })).toEqual([]);
    expect(call('get_my_listing', OWNER, { id: L })).toHaveLength(1);
  });

  it('public catalogue shows active listings only, keyset-paginates and searches', () => {
    const { call } = seeded();
    call('create_listing', OWNER, { id: 'listing-2', owner_name: 'Olive', title: 'Garage space', category: 'parking', location: 'Newtown' });
    call('set_listing_status', OWNER, { id: 'listing-2', status: 'paused' });
    expect((call('list_listings', null) as { id: string }[]).map((r) => r.id)).toEqual([L]);
    expect(call('search_listings', null, { q: 'sunny' })).toHaveLength(1);
    expect(call('search_listings', null, { q: 'garage' })).toHaveLength(0);
    const first = (call('list_listings', null) as { created_at: number }[])[0]!;
    expect(call('list_listings', null, { before: first.created_at })).toEqual([]);
  });

  it('create_request refuses own listing, duplicates, blocked pairs and inactive listings; stays idempotent', () => {
    const { call } = seeded();
    expect(call('create_request', OWNER, { id: 'r-own', listing_id: L, requester_name: 'Olive' })).toBe(0);
    expect(call('create_request', SEEKER, { id: 'r-1', listing_id: L, requester_name: 'Sam', note: 'Two nights?' })).toBe(1);
    expect(call('create_request', SEEKER, { id: 'r-1', listing_id: L, requester_name: 'Sam' })).toBe(0);
    expect(call('create_request', SEEKER, { id: 'r-2', listing_id: L, requester_name: 'Sam' })).toBe(0);
    expect(call('block_user', OWNER, { blocked_id: STRANGER })).toBe(1);
    expect(call('create_request', STRANGER, { id: 'r-3', listing_id: L, requester_name: 'Stan' })).toBe(0);
    call('set_listing_status', OWNER, { id: L, status: 'paused' });
    expect(call('create_request', 'gh:fourth', { id: 'r-4', listing_id: L, requester_name: 'Fay' })).toBe(0);
  });

  it('request lifecycle: only the owner transitions, only from the state the caller saw; only the requester cancels', () => {
    const { call } = seeded();
    call('create_request', SEEKER, { id: 'r-1', listing_id: L, requester_name: 'Sam' });
    expect(call('set_request_status', SEEKER, { id: 'r-1', from: 'pending', to: 'accepted' })).toBe(0);
    expect(call('set_request_status', STRANGER, { id: 'r-1', from: 'pending', to: 'accepted' })).toBe(0);
    expect(call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'completed' })).toBe(0);
    expect(call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'accepted' })).toBe(1);
    expect(call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'accepted' })).toBe(0);
    expect(call('cancel_request', STRANGER, { id: 'r-1' })).toBe(0);
    expect(call('list_my_requests', STRANGER)).toEqual([]);
    expect(call('list_incoming_requests', STRANGER)).toEqual([]);
    expect(call('list_incoming_requests', OWNER)).toHaveLength(1);
    expect(call('set_request_status', OWNER, { id: 'r-1', from: 'accepted', to: 'completed' })).toBe(1);
    expect(call('cancel_request', SEEKER, { id: 'r-1' })).toBe(0);
  });

  it('reviews attach only to the caller’s own completed request, once', () => {
    const { call } = seeded();
    call('create_request', SEEKER, { id: 'r-1', listing_id: L, requester_name: 'Sam' });
    expect(call('can_review', SEEKER, { listing_id: L })).toEqual([]);
    expect(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 5 })).toBe(0);
    call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'accepted' });
    call('set_request_status', OWNER, { id: 'r-1', from: 'accepted', to: 'completed' });
    expect(call('can_review', SEEKER, { listing_id: L })).toEqual([{ request_id: 'r-1' }]);
    expect(call('create_review', STRANGER, { request_id: 'r-1', author_name: 'Stan', rating: 1 })).toBe(0);
    expect(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 9 })).toBe(0);
    expect(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 5, comment: 'Lovely' })).toBe(1);
    expect(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 1 })).toBe(0);
    expect(call('can_review', SEEKER, { listing_id: L })).toEqual([]);
    const pub = call('list_reviews', null, { listing_id: L }) as Record<string, unknown>[];
    expect(pub).toHaveLength(1);
    expect(Object.keys(pub[0]!)).not.toContain('author_id');
    expect((call('listing_stats', null, { listing_id: L }) as { review_count: number }[])[0]!.review_count).toBe(1);
  });

  it('messages run only between the owner and one other party, and blocks cut both ways', () => {
    const { call } = seeded();
    expect(call('send_message', SEEKER, { listing_id: L, recipient_id: OWNER, sender_name: 'Sam', body: 'Still free?' })).toBe(1);
    expect(call('send_message', OWNER, { listing_id: L, recipient_id: SEEKER, sender_name: 'Olive', body: 'Yes' })).toBe(1);
    expect(call('send_message', STRANGER, { listing_id: L, recipient_id: SEEKER, sender_name: 'Stan', body: 'Hi' })).toBe(0);
    expect(call('send_message', OWNER, { listing_id: L, recipient_id: OWNER, sender_name: 'Olive', body: 'Me' })).toBe(0);
    expect(call('list_messages', STRANGER, { listing_id: L, other_id: OWNER })).toEqual([]);
    expect(call('list_messages', SEEKER, { listing_id: L, other_id: OWNER })).toHaveLength(2);
    expect(call('list_conversations', STRANGER)).toEqual([]);
    const convos = call('list_conversations', OWNER) as { other_id: string; other_name: string }[];
    expect(convos).toEqual([expect.objectContaining({ other_id: SEEKER, other_name: 'Sam' })]);
    expect(call('block_user', SEEKER, { blocked_id: OWNER })).toBe(1);
    expect(call('send_message', OWNER, { listing_id: L, recipient_id: SEEKER, sender_name: 'Olive', body: 'Hello?' })).toBe(0);
    expect(call('send_message', SEEKER, { listing_id: L, recipient_id: OWNER, sender_name: 'Sam', body: 'Bye' })).toBe(0);
    expect(call('unblock_user', STRANGER, { blocked_id: OWNER })).toBe(0);
    expect(call('unblock_user', SEEKER, { blocked_id: OWNER })).toBe(1);
    expect(call('send_message', SEEKER, { listing_id: L, recipient_id: OWNER, sender_name: 'Sam', body: 'Back' })).toBe(1);
  });

  it('favourites are per user and only for active listings; self-block and self-report are refused', () => {
    const { call } = seeded();
    expect(call('add_favorite', SEEKER, { listing_id: L })).toBe(1);
    expect(call('add_favorite', SEEKER, { listing_id: L })).toBe(0);
    expect(call('add_favorite', SEEKER, { listing_id: 'nope' })).toBe(0);
    expect(call('list_my_favorites', STRANGER)).toEqual([]);
    expect(call('list_my_favorite_ids', SEEKER)).toEqual([{ listing_id: L }]);
    expect(call('remove_favorite', STRANGER, { listing_id: L })).toBe(0);
    expect(call('remove_favorite', SEEKER, { listing_id: L })).toBe(1);
    expect(call('block_user', SEEKER, { blocked_id: SEEKER })).toBe(0);
    expect(call('report_user', SEEKER, { reported_id: SEEKER, reason: 'spam' })).toBe(0);
    expect(call('report_user', SEEKER, { reported_id: OWNER, listing_id: L, reason: 'spam', note: 'ad' })).toBe(1);
    expect(call('list_blocks', SEEKER)).toEqual([]);
  });
});
