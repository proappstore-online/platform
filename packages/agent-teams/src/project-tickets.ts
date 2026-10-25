import type { ProjectHost } from './project-host.ts';
import type { Role, Ticket, TicketStatus } from './types.ts';
import { MAX_ITERATIONS, assigneeForStatus, canTransition } from './ticket-machine.ts';
import { json, rowToTicket, uuid } from './store.ts';
import { autoAdvance } from './project-pipeline.ts';

export function listTickets(h: ProjectHost): Response {
  // Build tickets only — the Knowledge Base is a conversation, not a ticket.
  // Excludes any legacy kind='research' row so it can never surface on the board.
  const rows = h.state.storage.sql
    .exec("SELECT * FROM tickets WHERE kind != 'research' ORDER BY created_at DESC")
    .toArray();
  return json({ tickets: rows.map(rowToTicket) });
}

/** Next short per-project ticket number (#N). DO is single-threaded, so MAX+1 is race-free. */
export function nextSeq(h: ProjectHost): number {
  const row = h.state.storage.sql
    .exec('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tickets')
    .toArray()[0] as { n: number } | undefined;
  return row?.n ?? 1;
}

export function getTicket(h: ProjectHost, id: string): Response {
  const row = h.state.storage.sql
    .exec('SELECT * FROM tickets WHERE id = ?', id)
    .toArray()[0];
  if (!row) return json({ error: 'ticket_not_found' }, 404);
  return json(rowToTicket(row));
}

export async function createTicket(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json()) as { title: string; rawIdea: string };
  if (!body.title || !body.rawIdea) {
    return json({ error: 'title and rawIdea required' }, 400);
  }

  const id = uuid();
  const now = Date.now();
  const seq = nextSeq(h);

  h.state.storage.sql.exec(
    `INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'inbox', ?, ?)`,
    id, seq, body.title, body.rawIdea, now, now,
  );

  const ticket: Ticket = {
    id,
    seq,
    projectId: '',
    title: body.title,
    rawIdea: body.rawIdea,
    spec: null,
    status: 'inbox',
    kind: 'build',
    assigneeRole: null,
    iterations: 0,
    createdAt: now,
    updatedAt: now,
    costSpentUsd: 0,
    prUrl: null,
    finalCommitSha: null,
    stuckReason: null,
  };

  h.broadcast({ type: 'ticket-created', ticket });
  autoAdvance(h);
  return json(ticket, 201);
}

export async function updateTicket(h: ProjectHost, id: string, request: Request): Promise<Response> {
  const body = (await request.json()) as Partial<Ticket>;
  const now = Date.now();

  // Check the row exists BEFORE touching anything (#137). The RESPONSE was
  // already right — `getTicket` at the bottom 404s on a miss — but an unknown
  // id still ran an UPDATE that matched nothing and then broadcast
  // `ticket-updated`, so every open board and panel handled a change to a card
  // it could not find. Same pre-check `deleteTicket` already does, and it has
  // to be a SELECT: `sql.exec` gives no changed-row count to test after the
  // fact, and a broadcast cannot be taken back once sent.
  const existing = h.state.storage.sql
    .exec('SELECT id FROM tickets WHERE id = ?', id)
    .toArray()[0] as { id: string } | undefined;
  if (!existing) return json({ error: 'ticket_not_found' }, 404);

  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now];

  if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title); }
  if (body.rawIdea !== undefined) { sets.push('raw_idea = ?'); vals.push(body.rawIdea); }
  if (body.spec !== undefined) { sets.push('spec_json = ?'); vals.push(JSON.stringify(body.spec)); }
  if (body.prUrl !== undefined) { sets.push('pr_url = ?'); vals.push(body.prUrl); }
  if (body.finalCommitSha !== undefined) { sets.push('final_commit_sha = ?'); vals.push(body.finalCommitSha); }

  vals.push(id);
  h.state.storage.sql.exec(
    `UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`,
    ...vals,
  );

  h.broadcast({ type: 'ticket-updated', ticketId: id });
  return getTicket(h, id);
}

// Delete a ticket and its messages. Activity/cost-ledger rows are kept as an
// audit trail. Broadcasts so open boards/panels drop it live.
export function deleteTicket(h: ProjectHost, id: string): Response {
  const row = h.state.storage.sql
    .exec('SELECT title FROM tickets WHERE id = ?', id)
    .toArray()[0] as { title: string } | undefined;
  if (!row) return json({ error: 'not_found' }, 404);
  h.state.storage.sql.exec('DELETE FROM messages WHERE ticket_id = ?', id);
  h.state.storage.sql.exec('DELETE FROM tickets WHERE id = ?', id);
  h.logActivity('control', `Ticket deleted: ${row.title}`, null);
  h.broadcast({ type: 'ticket-deleted', ticketId: id });
  return json({ ok: true });
}

export async function transitionTicket(h: ProjectHost, id: string, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    to: TicketStatus;
    trigger: 'po' | Role | 'system';
    reason?: string;
  };

  const row = h.state.storage.sql
    .exec('SELECT * FROM tickets WHERE id = ?', id)
    .toArray()[0];
  if (!row) return json({ error: 'ticket_not_found' }, 404);

  const ticket = rowToTicket(row);

  if (!canTransition(ticket.status, body.to, body.trigger)) {
    return json({
      error: 'invalid_transition',
      from: ticket.status,
      to: body.to,
      trigger: body.trigger,
    }, 400);
  }

  // Check iteration cap for qa-failed → dev-active
  if (ticket.status === 'qa-failed' && body.to === 'dev-active') {
    if (ticket.iterations >= MAX_ITERATIONS) {
      // Auto-fail instead
      h.state.storage.sql.exec(
        `UPDATE tickets SET status = 'failed', stuck_reason = ?, updated_at = ? WHERE id = ?`,
        `Iteration cap reached (${MAX_ITERATIONS})`, Date.now(), id,
      );
      h.broadcast({ type: 'ticket-failed', ticketId: id, reason: 'iteration_cap' });
      return getTicket(h, id);
    }
  }

  const now = Date.now();
  const assignee = assigneeForStatus(body.to);
  const iterationBump = (ticket.status === 'qa-failed' && body.to === 'dev-active') ? 1 : 0;

  h.state.storage.sql.exec(
    `UPDATE tickets SET status = ?, assignee_role = ?, iterations = iterations + ?,
     stuck_reason = ?, updated_at = ? WHERE id = ?`,
    body.to, assignee, iterationBump, body.reason ?? null, now, id,
  );

  h.broadcast({
    type: 'ticket-transition',
    ticketId: id,
    from: ticket.status,
    to: body.to,
    trigger: body.trigger,
  });

  return getTicket(h, id);
}
