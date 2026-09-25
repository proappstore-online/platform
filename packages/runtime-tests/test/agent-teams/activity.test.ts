import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, freshSlug, json, resetTables, session } from './helpers';

beforeEach(resetTables);

/** #6 on real DO SQLite storage: the trail a client saw live is what a fresh client reads back. */
describe('GET /v1/projects/:slug/activity', () => {
  it('returns the persisted trail — ticket created, transitioned — and DELETE clears it (owner only)', async () => {
    const slug = freshSlug('act');
    const owner = await session('gh:1', 'alice');
    expect((await SELF.fetch(`${BASE}/v1/projects`, json('POST', { name: 'Activity App', slug }, owner))).status).toBe(200);
    const ticket = await SELF.fetch(`${BASE}/v1/projects/${slug}/tickets`, json('POST', { title: 'Sign-in', rawIdea: 'users can sign in' }, owner));
    expect(ticket.status).toBe(201);
    const { id } = (await ticket.json()) as { id: string };
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/tickets/${id}/transition`, json('POST', { to: 'cancelled', trigger: 'po' }, owner))).status).toBe(200);

    // A fresh request (as after a page refresh) reads the rows from the DO's storage.
    const res = await SELF.fetch(`${BASE}/v1/projects/${slug}/activity`, json('GET', undefined, owner));
    expect(res.status).toBe(200);
    const { activity } = (await res.json()) as { activity: { type: string; detail: string; ticketId: string | null; createdAt: number }[] };
    expect(activity.map((a) => [a.type, a.detail, a.ticketId])).toEqual([
      ['ticket', 'Created: Sign-in', id],
      ['transition', 'inbox → cancelled · po', id],
    ]);
    expect(activity.every((a) => a.createdAt > 0)).toBe(true);

    // Clearing is an owner route (#79): a viewer is refused, the owner succeeds.
    const { env } = await import('cloudflare:test');
    await env.DB.prepare('INSERT INTO team_members (app_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(slug, 'gh:3', 'viewer', Date.now()).run();
    const viewer = await session('gh:3', 'carol');
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/activity`, json('DELETE', undefined, viewer))).status).toBe(403);
    expect(((await (await SELF.fetch(`${BASE}/v1/projects/${slug}/activity`, json('GET', undefined, owner))).json()) as { activity: unknown[] }).activity).toHaveLength(2);
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/activity`, json('GET', undefined, viewer))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/projects/${slug}/activity`, json('DELETE', undefined, owner))).status).toBe(200);
    expect(await (await SELF.fetch(`${BASE}/v1/projects/${slug}/activity`, json('GET', undefined, owner))).json()).toEqual({ activity: [] });
  });
});
