import { describe, expect, it } from 'vitest';
import { addMessage, listMessages, storeMessage } from './project-messages.ts';
import { addMemory, forgetMemory, rememberFact } from './project-memory.ts';
import { createTicket, deleteTicket, getTicket, listTickets, nextSeq, transitionTicket, updateTicket } from './project-tickets.ts';
import { fakeHost, req, seedProject, seedTicket } from './project-test-host.ts';

describe('tickets', () => {
  it('creates a numbered inbox ticket and announces it', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    const a = await createTicket(host, req('/tickets', { method: 'POST', body: { title: 'A', rawIdea: 'first' } }));
    const b = await createTicket(host, req('/tickets', { method: 'POST', body: { title: 'B', rawIdea: 'second' } }));
    expect(a.status).toBe(201);
    expect(((await a.json()) as { seq: number; status: string })).toMatchObject({ seq: 1, status: 'inbox' });
    expect(((await b.json()) as { seq: number }).seq).toBe(2);
    expect(nextSeq(host)).toBe(3);
    expect(broadcasts.filter((e) => e.type === 'ticket-created')).toHaveLength(2);
  });

  it('refuses a ticket with no title or idea', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect((await createTicket(host, req('/tickets', { method: 'POST', body: { title: 'only' } }))).status).toBe(400);
  });

  it('lists build tickets newest first and hides the legacy research kind', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 'old', 'inbox', { created_at: 1 });
    seedTicket(db, 'new', 'inbox', { created_at: 2 });
    seedTicket(db, 'kb', 'inbox', { kind: 'research', created_at: 3 });
    const { tickets } = (await listTickets(host).json()) as { tickets: { id: string }[] };
    expect(tickets.map((t) => t.id)).toEqual(['new', 'old']);
  });

  it('404s an unknown ticket without broadcasting an update for it (#137)', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    expect(getTicket(host, 'nope').status).toBe(404);
    const res = await updateTicket(host, 'nope', req('/tickets/nope', { method: 'PATCH', body: { title: 'x' } }));
    expect(res.status).toBe(404);
    expect(broadcasts).toEqual([]);
  });

  it('updates only the fields supplied', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'inbox');
    const res = await updateTicket(host, 't1', req('/tickets/t1', { method: 'PATCH', body: { title: 'Renamed' } }));
    expect(await res.json()).toMatchObject({ id: 't1', title: 'Renamed', rawIdea: 'idea' });
  });

  it('deletes a ticket with its messages', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'inbox');
    await storeMessage(host, { ticketId: 't1', author: 'BA', body: 'hi' });
    expect(deleteTicket(host, 't1').status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(broadcasts).toContainEqual({ type: 'ticket-deleted', ticketId: 't1' });
    expect(deleteTicket(host, 't1').status).toBe(404);
  });

  it('rejects an invalid transition and applies a valid one', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'inbox');
    const bad = await transitionTicket(host, 't1', req('/x', { method: 'POST', body: { to: 'done', trigger: 'po' } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_transition', from: 'inbox', to: 'done', trigger: 'po' });
    const ok = await transitionTicket(host, 't1', req('/x', { method: 'POST', body: { to: 'ba-refining', trigger: 'BA' } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'ba-refining', assigneeRole: 'BA' });
  });

  it('fails a qa-failed ticket instead of looping past the iteration cap', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'qa-failed', { iterations: 5 });
    const res = await transitionTicket(host, 't1', req('/x', { method: 'POST', body: { to: 'dev-active', trigger: 'Dev' } }));
    expect(await res.json()).toMatchObject({ status: 'failed' });
    expect(broadcasts).toContainEqual({ type: 'ticket-failed', ticketId: 't1', reason: 'iteration_cap' });
  });
});

describe('messages and the cost ledger', () => {
  it('validates a posted message', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'inbox');
    const post = (body: unknown) => addMessage(host, 't1', req('/m', { method: 'POST', body }));
    expect((await post({ author: 'BA', body: 'x', costUsd: -1 })).status).toBe(400);
    expect((await post({ author: 'BA' })).status).toBe(400);
    const ok = await post({ author: 'BA', body: 'hello' });
    expect(ok.status).toBe(201);
    const { messages } = (await listMessages(host, 't1').json()) as { messages: { body: string }[] };
    expect(messages.map((m) => m.body)).toEqual(['hello']);
  });

  it('rolls cost up to the ticket, the project and the ledger', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    seedTicket(db, 't1', 'dev-active');
    await storeMessage(host, { ticketId: 't1', author: 'Dev', body: 'done', costUsd: 1.5, tokensIn: 10, tokensOut: 20, model: 'm' });
    expect(db.prepare('SELECT cost_spent_usd AS c FROM tickets').get()).toEqual({ c: 1.5 });
    expect(db.prepare('SELECT cost_spent_monthly_usd AS c, cost_month AS m FROM project').get()).toEqual({ c: 1.5, m: new Date().toISOString().slice(0, 7) });
    expect(db.prepare('SELECT role, cost_usd, tokens_in, tokens_out, model FROM cost_ledger').get()).toEqual({ role: 'Dev', cost_usd: 1.5, tokens_in: 10, tokens_out: 20, model: 'm' });
  });

  it('starts a new month at the new spend, not on top of last month\'s', async () => {
    const { host, db } = fakeHost();
    seedProject(db, { cost_spent_monthly_usd: 40, cost_month: '2001-01' });
    seedTicket(db, 't1', 'dev-active');
    await storeMessage(host, { ticketId: 't1', author: 'Dev', body: 'x', costUsd: 2 });
    expect(db.prepare('SELECT cost_spent_monthly_usd AS c FROM project').get()).toEqual({ c: 2 });
  });

  it('fails the active tickets when the monthly cap is hit', async () => {
    const { host, db, broadcasts } = fakeHost();
    seedProject(db, { cost_cap_monthly_usd: 5 });
    seedTicket(db, 'active', 'dev-active');
    seedTicket(db, 'inbox', 'inbox');
    await storeMessage(host, { ticketId: 'active', author: 'Dev', body: 'x', costUsd: 5 });
    const status = (id: string) => (db.prepare('SELECT status FROM tickets WHERE id = ?').get(id) as { status: string }).status;
    expect([status('active'), status('inbox')]).toEqual(['failed', 'inbox']);
    expect(broadcasts).toContainEqual({ type: 'cost-cap-reached', spent: 5, cap: 5 });
  });

  it('offloads a body over 8 KB to R2 and stores a stub', async () => {
    const puts: [string, string][] = [];
    const { host, db } = fakeHost({ AGENT_STORAGE: { put: async (k: string, v: string) => { puts.push([k, v]); } } });
    seedProject(db);
    seedTicket(db, 't1', 'inbox');
    const id = await storeMessage(host, { ticketId: 't1', author: 'Dev', body: 'x'.repeat(9000) });
    expect(puts).toEqual([[`messages/t1/${id}`, 'x'.repeat(9000)]]);
    expect((db.prepare('SELECT body FROM messages').get() as { body: string }).body).toMatch(/\.\.\. \[offloaded\]$/);
  });
});

describe('project memory', () => {
  it('upserts by key rather than duplicating, then forgets', async () => {
    const { host, db, activity, broadcasts } = fakeHost();
    seedProject(db);
    rememberFact(host, 'decision', 'currency', 'AUD');
    rememberFact(host, 'decision', 'currency', 'USD');
    expect(db.prepare('SELECT value FROM project_memory').all()).toEqual([{ value: 'USD' }]);
    expect(activity.map((a) => a.detail)).toEqual(['Remembered: currency', 'Remembered: currency']);
    const { id } = db.prepare('SELECT id FROM project_memory').get() as { id: string };
    expect(await forgetMemory(host, id).json()).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_memory').get()).toEqual({ n: 0 });
    expect(broadcasts.filter((b) => b.type === 'memory-updated')).toHaveLength(3);
  });

  it('requires a key and a value', async () => {
    const { host, db } = fakeHost();
    seedProject(db);
    expect((await addMemory(host, req('/memory', { method: 'POST', body: { key: 'k' } }))).status).toBe(400);
    const ok = await addMemory(host, req('/memory', { method: 'POST', body: { key: 'k', value: 'v' } }));
    expect(((await ok.json()) as { memory: { key: string }[] }).memory.map((m) => m.key)).toEqual(['k']);
  });
});
