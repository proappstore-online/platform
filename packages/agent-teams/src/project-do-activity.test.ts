import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ProjectDO } from './project-do.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function fakeState() {
  const db = new DatabaseSync(':memory:');
  const broadcasts: Record<string, unknown>[] = [];
  const socket = { send: (data: string) => { broadcasts.push(JSON.parse(data) as Record<string, unknown>); } };
  const state = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          if (/^\s*select/i.test(sql)) return { toArray: () => db.prepare(sql).all(...(params as never[])) };
          if (params.length === 0) db.exec(sql); else db.prepare(sql).run(...(params as never[]));
          return { toArray: () => [] };
        },
      },
    },
    getWebSockets: () => [socket],
  };
  return { state, broadcasts, db };
}

const OWNER = 'user-1';
const H = { 'X-User-Id': OWNER, 'Content-Type': 'application/json' };

/**
 * #6: the activity trail is persisted in the DO's SQLite, and every
 * state-changing broadcast writes a row — so what the panel showed live is
 * what GET /activity returns after a refresh.
 */
describe('activity log persistence (#6)', () => {
  async function setup() {
    const { state, broadcasts, db } = fakeState();
    const doInstance = new ProjectDO(state as never, { AGENT_STORAGE: undefined } as never);
    await doInstance.fetch(new Request('http://do/tickets', { headers: H }));
    db.exec(`INSERT INTO project (id, owner_id, name, slug, created_at) VALUES ('p1', '${OWNER}', 'Probe', 'probe', 1)`);
    const activity = async () => ((await (await doInstance.fetch(new Request('http://do/activity', { headers: H }))).json()) as { activity: { type: string; detail: string; ticketId: string | null }[] }).activity;
    return { doInstance, broadcasts, db, activity };
  }

  it('a created ticket and its transition are rows on disk, each announced once as an activity event', async () => {
    const { doInstance, broadcasts, activity } = await setup();
    const created = await doInstance.fetch(new Request('http://do/tickets', { method: 'POST', headers: H, body: JSON.stringify({ title: 'Login page', rawIdea: 'users sign in' }) }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const moved = await doInstance.fetch(new Request(`http://do/tickets/${id}/transition`, { method: 'POST', headers: H, body: JSON.stringify({ to: 'cancelled', trigger: 'po' }) }));
    expect(moved.status).toBe(200);

    const rows = await activity();
    expect(rows.map((r) => [r.type, r.detail, r.ticketId])).toEqual([
      ['ticket', 'Created: Login page', id],
      ['transition', 'inbox → cancelled · po', id],
    ]);
    // Live clients got exactly one activity event per row (no duplicate from an explicit log).
    const live = broadcasts.filter((b) => b.type === 'activity').map((b) => (b.entry as { detail: string }).detail);
    expect(live).toEqual(['Created: Login page', 'inbox → cancelled · po']);
  });

  it('a run ending, a failure and an update leave rows; token deltas and heartbeats do not', async () => {
    const { doInstance, activity } = await setup();
    const broadcast = (e: Record<string, unknown>) => (doInstance as unknown as { broadcast(e: Record<string, unknown>): void }).broadcast(e);
    broadcast({ type: 'agent-run-started', ticketId: 't1', role: 'Dev' });
    broadcast({ type: 'agent-text', ticketId: 't1', role: 'Dev', text: 'writing…' });
    broadcast({ type: 'agent-heartbeat', ticketId: 't1', role: 'Dev' });
    broadcast({ type: 'agent-run-ended', ticketId: 't1', role: 'Dev', error: 'timeout' });
    broadcast({ type: 'ticket-updated', ticketId: 't1' });
    broadcast({ type: 'ticket-failed', ticketId: 't1', reason: 'iteration_cap' });
    broadcast({ type: 'transition', ticketId: 't1', from: 'qa-failed', to: 'failed', auto: true });
    expect((await activity()).map((r) => r.detail)).toEqual(['Dev failed: timeout', 'Updated', 'Failed: iteration_cap', 'qa-failed → failed · auto']);
  });

  it('forgetting a memory leaves a row naming the key; DELETE /activity clears the trail and announces it', async () => {
    const { doInstance, broadcasts, activity } = await setup();
    await doInstance.fetch(new Request('http://do/memory', { method: 'POST', headers: H, body: JSON.stringify({ key: 'stack', value: 'React' }) }));
    const { memory } = (await (await doInstance.fetch(new Request('http://do/memory', { headers: H }))).json()) as { memory: { id: string }[] };
    await doInstance.fetch(new Request(`http://do/memory/${memory[0]!.id}`, { method: 'DELETE', headers: H }));
    expect((await activity()).map((r) => r.detail)).toEqual(['Remembered: stack', 'Forgot: stack']);

    const cleared = await doInstance.fetch(new Request('http://do/activity', { method: 'DELETE', headers: H }));
    expect(cleared.status).toBe(200);
    expect(await activity()).toEqual([]);
    expect(broadcasts.at(-1)).toEqual({ type: 'activity-cleared' });
  });
});
