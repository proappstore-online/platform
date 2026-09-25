import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, freshSlug, json, resetTables, session } from './helpers';

beforeEach(resetTables);

describe('project lifecycle through the router, the D1 index and the ProjectDO', () => {
  it('create writes the agent_projects index, initialises the DO, lists and reads back — for the owner only', async () => {
    const slug = freshSlug();
    const owner = await session('gh:1', 'alice');

    const created = await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'Alice App', slug, idea: 'a todo list' }, owner));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ slug, seededTicket: false });

    // The index row is written BEFORE the DO call (#143) — it is what the listing reads.
    const row = await env.DB.prepare('SELECT slug, owner_id, name FROM agent_projects WHERE slug = ?').bind(slug).first();
    expect(row).toEqual({ slug, owner_id: 'gh:1', name: 'Alice App' });
    const list = await SELF.fetch(`${BASE}/v1/projects`, json('GET', undefined, owner));
    expect(await list.json()).toEqual({ projects: [expect.objectContaining({ slug, name: 'Alice App' })] });

    // The DO answers from its own SQLite: owner, cap, status.
    const got = await SELF.fetch(`${BASE}/v1/projects/${slug}`, json('GET', undefined, owner));
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ ownerId: 'gh:1', name: 'Alice App', slug, costCapMonthlyUsd: 50, status: 'paused' });

    // The template seeded the working tree (project_files) on init.
    const files = await SELF.fetch(`${BASE}/v1/projects/${slug}/files`, json('GET', undefined, owner));
    const { files: seeded } = (await files.json()) as { files: { path: string }[] };
    expect(seeded.map((f) => f.path)).toEqual(expect.arrayContaining(['.gitignore', 'LICENSE']));

    // Another signed-in user: the DO's ownership check answers not_found, and
    // the router refuses to rename the owner's index entry on a re-create.
    const stranger = await session('gh:2', 'bob');
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}`, json('GET', undefined, stranger))).status).toBe(404);
    const takeover = await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'Bobs Now', slug }, stranger));
    expect(takeover.status).toBe(404);
    expect((await env.DB.prepare('SELECT owner_id, name FROM agent_projects WHERE slug = ?').bind(slug).first())).toEqual({ owner_id: 'gh:1', name: 'Alice App' });
  });

  it('a team member listed in D1 is let in with the role the router looked up; a viewer cannot write files', async () => {
    const slug = freshSlug();
    const owner = await session('gh:1', 'alice');
    expect((await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'Team App', slug }, owner))).status).toBe(200);
    await env.DB.prepare('INSERT INTO team_members (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(slug, 'gh:3', 'viewer', Date.now()).run();

    const viewer = await session('gh:3', 'carol');
    const read = await SELF.fetch(`${BASE}/v1/projects/${slug}`, json('GET', undefined, viewer));
    expect(read.status).toBe(200);
    // #79: membership is not privilege — a viewer's write is refused by the DO's role gate.
    const write = await SELF.fetch(`${BASE}/v1/projects/${slug}/files`, json('POST', { files: { 'x.txt': 'hi' } }, viewer));
    expect(write.status).toBe(403);
    // A smuggled trust header is stripped by the router before it reaches the DO.
    const smuggled = await SELF.fetch(`${BASE}/v1/projects/${slug}/files`, json('POST', { files: { 'x.txt': 'hi' } }, viewer, { 'X-Team-Role': 'owner', 'X-User-Id': 'gh:1' }));
    expect(smuggled.status).toBe(403);
  });

  it('401 without a session; the internal token resolves the owner from the D1 index for service callers', async () => {
    const slug = freshSlug();
    const owner = await session('gh:1', 'alice');
    expect((await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'Svc App', slug }, owner))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}`, json('GET', undefined, 'not-a-session'))).status).toBe(401);

    const internal = await SELF.fetch(`${BASE}/v1/projects/${slug}`, json('GET', undefined, undefined, { 'X-Internal-Token': env.INTERNAL_TOKEN }));
    expect(internal.status).toBe(200);
    expect(await internal.json()).toMatchObject({ ownerId: 'gh:1' });
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}`, json('GET', undefined, undefined, { 'X-Internal-Token': 'wrong' }))).status).toBe(401);
  });

  it('a WebSocket upgrade reaches the DO through the router and receives the ticket-created broadcast', async () => {
    const slug = freshSlug();
    const owner = await session('gh:1', 'alice');
    expect((await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'WS App', slug }, owner))).status).toBe(200);

    const res = await SELF.fetch(`${BASE}/v1/projects/${slug}/ws`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${owner}` } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const next = new Promise<unknown>((resolve) => ws.addEventListener('message', (ev) => resolve(JSON.parse(String((ev as MessageEvent).data))), { once: true }));
    const ticket = await SELF.fetch(`${BASE}/v1/projects/${slug}/tickets`, json('POST', { title: 'First', rawIdea: 'do the thing' }, owner));
    expect(ticket.status).toBe(201);
    expect(await next).toMatchObject({ type: 'ticket-created', ticket: expect.objectContaining({ title: 'First', status: 'inbox' }) });
    ws.close();

    // A non-member's upgrade is refused by the DO's access check, not upgraded.
    const stranger = await session('gh:2', 'bob');
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/ws`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${stranger}` } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/ws`, json('GET', undefined, owner))).status).toBe(426);
  });
});
