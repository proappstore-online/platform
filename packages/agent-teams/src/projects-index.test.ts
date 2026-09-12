import { describe, expect, it, vi } from 'vitest';
import app from './index.js';

// #143: the agent_projects index row is the ONLY pointer the owner's listing has
// to a project (DOs can't be enumerated). These tests pin the three behaviours
// that make a lost row visible instead of silent: the write fails the create,
// a read failure is a 503 not an empty list, and opening a project as its
// owner repairs a missing row.

const KEY = 'test-signing-key';
const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function mint(uid: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ uid, login: uid, exp: Math.floor(Date.now() / 1000) + 3600 })));
  const key = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body))));
  return `${body}.${sig}`;
}

type Row = { slug: string; owner_id: string; name: string; created_at: number };

/** In-memory stand-in for the agent_projects table: enough SQL to drive index.ts. */
function fakeD1(opts: { failRun?: boolean; failAll?: boolean } = {}) {
  const rows: Row[] = [];
  const log: string[] = [];
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => { args = a; return stmt; },
      first: async () => {
        if (sql.includes('SELECT owner_id FROM agent_projects')) {
          const r = rows.find((x) => x.slug === args[0]);
          return r ? { owner_id: r.owner_id } : null;
        }
        if (sql.includes('SELECT 1 FROM agent_projects')) {
          return rows.some((x) => x.slug === args[0] && x.owner_id === args[1]) ? { 1: 1 } : null;
        }
        if (sql.includes('COUNT(*)')) return { n: rows.filter((x) => x.owner_id === args[0]).length };
        return null; // team_members etc.
      },
      run: async () => {
        if (opts.failRun) throw new Error('D1_ERROR: table locked');
        if (sql.includes('INSERT INTO agent_projects')) {
          log.push('index-write');
          const [slug, owner_id, name, created_at] = args as [string, string, string, number];
          const existing = rows.find((x) => x.slug === slug);
          if (!existing) rows.push({ slug, owner_id, name, created_at });
          else if (sql.includes('DO UPDATE') && existing.owner_id === owner_id) existing.name = name;
        }
        return { meta: {} };
      },
      all: async () => {
        if (opts.failAll) throw new Error('D1_ERROR: table locked');
        return { results: rows.filter((x) => x.owner_id === args[0]).map(({ slug, name, created_at }) => ({ slug, name, created_at })) };
      },
    };
    return stmt;
  };
  return { db: { prepare } as unknown as D1Database, rows, log };
}

function fakeProjectNs(handler: (req: Request) => Response, log: string[]) {
  const fetch = vi.fn((req: Request) => { log.push('do-call'); return Promise.resolve(handler(req)); });
  const ns = { idFromName: (s: string) => s, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
  return { ns, fetch };
}

function env(db: D1Database, ns: DurableObjectNamespace) {
  return { DB: db, PROJECT: ns, SESSION_SIGNING_KEY: KEY, PAS_API_BASE: 'https://api.test' } as never;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('POST /v1/projects — index write (#143)', () => {
  it('fails the create with 503 when the index write rejects, and never touches the DO', async () => {
    const { db, log } = fakeD1({ failRun: true });
    const { ns, fetch } = fakeProjectNs(() => json({ id: 'p1', slug: 'my-app' }), log);
    const res = await app.request('/v1/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await mint('gh:1')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My App', slug: 'my-app' }),
    }, env(db, ns));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'index_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('writes the index row BEFORE calling the DO, and the row lists afterwards', async () => {
    const { db, rows, log } = fakeD1();
    const { ns } = fakeProjectNs(() => json({ id: 'p1', slug: 'my-app' }), log);
    const tok = await mint('gh:1');
    const res = await app.request('/v1/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My App', slug: 'my-app' }),
    }, env(db, ns));
    expect(res.status).toBe(200);
    expect(log).toEqual(['index-write', 'do-call']);
    expect(rows).toEqual([expect.objectContaining({ slug: 'my-app', owner_id: 'gh:1', name: 'My App' })]);

    const list = await app.request('/v1/projects', { headers: { Authorization: `Bearer ${tok}` } }, env(db, ns));
    expect(list.status).toBe(200);
    expect((await list.json() as { projects: { slug: string }[] }).projects.map((p) => p.slug)).toEqual(['my-app']);
  });

  it('does not let a non-owner rename another user\'s index entry (write now precedes the DO check)', async () => {
    const { db, rows, log } = fakeD1();
    rows.push({ slug: 'victim-app', owner_id: 'gh:victim', name: 'Victim', created_at: 1 });
    // The DO rejects a re-init by a non-owner with 404, as project-do.ts does.
    const { ns } = fakeProjectNs(() => json({ error: 'not_found' }, 404), log);
    const res = await app.request('/v1/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await mint('gh:attacker')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pwned', slug: 'victim-app' }),
    }, env(db, ns));
    expect(res.status).toBe(404);
    expect(rows[0]).toEqual(expect.objectContaining({ owner_id: 'gh:victim', name: 'Victim' }));
  });
});

describe('GET /v1/projects — index read (#143)', () => {
  it('returns 503, not an empty list, when the index read rejects', async () => {
    const { db, log } = fakeD1({ failAll: true });
    const { ns } = fakeProjectNs(() => json({}), log);
    const res = await app.request('/v1/projects', { headers: { Authorization: `Bearer ${await mint('gh:1')}` } }, env(db, ns));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'index_unavailable' });
  });
});

describe('GET /v1/projects/:slug — self-heal (#143)', () => {
  it('re-creates a missing index row when the DO says the caller is the owner', async () => {
    const { db, rows, log } = fakeD1();
    const { ns } = fakeProjectNs(() => json({ id: 'p1', ownerId: 'gh:1', name: 'Lost App', slug: 'lost-app', createdAt: 1234 }), log);
    const tok = await mint('gh:1');
    const res = await app.request('/v1/projects/lost-app', { headers: { Authorization: `Bearer ${tok}` } }, env(db, ns));
    expect(res.status).toBe(200);
    expect((await res.json() as { slug: string }).slug).toBe('lost-app'); // DO body relayed intact
    expect(rows).toEqual([{ slug: 'lost-app', owner_id: 'gh:1', name: 'Lost App', created_at: 1234 }]);

    const list = await app.request('/v1/projects', { headers: { Authorization: `Bearer ${tok}` } }, env(db, ns));
    expect((await list.json() as { projects: { slug: string }[] }).projects.map((p) => p.slug)).toEqual(['lost-app']);
  });

  it('writes nothing when the DO reports a different owner', async () => {
    const { db, rows, log } = fakeD1();
    const { ns } = fakeProjectNs(() => json({ id: 'p1', ownerId: 'gh:owner', name: 'Shared', slug: 'shared-app' }), log);
    const res = await app.request('/v1/projects/shared-app', { headers: { Authorization: `Bearer ${await mint('gh:member')}` } }, env(db, ns));
    expect(res.status).toBe(200);
    expect(rows).toEqual([]);
  });
});
