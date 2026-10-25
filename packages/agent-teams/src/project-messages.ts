import type { ProjectHost } from './project-host.ts';
import type { ToolCall } from './types.ts';
import { json, rowToMessage, uuid } from './store.ts';

export function listMessages(h: ProjectHost, ticketId: string): Response {
  const rows = h.state.storage.sql
    .exec('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at', ticketId)
    .toArray();
  return json({ messages: rows.map(rowToMessage) });
}

export async function addMessage(h: ProjectHost, ticketId: string, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    author: string;
    body: string;
    toolCalls?: ToolCall[];
    costUsd?: number;
    tokensIn?: number;
    tokensOut?: number;
  };

  // Validate non-negative cost/token values
  if ((body.costUsd ?? 0) < 0 || (body.tokensIn ?? 0) < 0 || (body.tokensOut ?? 0) < 0) {
    return json({ error: 'cost and token values must be non-negative' }, 400);
  }
  if (!body.body || !body.author) {
    return json({ error: 'author and body required' }, 400);
  }

  const id = await storeMessage(h, {
    ticketId,
    author: body.author,
    body: body.body,
    toolCalls: body.toolCalls,
    costUsd: body.costUsd ?? 0,
    tokensIn: body.tokensIn ?? 0,
    tokensOut: body.tokensOut ?? 0,
    model: 'unknown',
  });
  return json({ id }, 201);
}

export async function storeMessage(h: ProjectHost, opts: {
  ticketId: string;
  author: string;
  body: string;
  toolCalls?: ToolCall[] | undefined;
  costUsd?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  model?: string | undefined;
}): Promise<string> {
  const id = uuid();
  const now = Date.now();
  const costUsd = opts.costUsd ?? 0;
  const tokensIn = opts.tokensIn ?? 0;
  const tokensOut = opts.tokensOut ?? 0;

  // Offload large bodies to R2
  let storedBody = opts.body;
  let offloadKey: string | null = null;
  if (opts.body.length > 8192) {
    offloadKey = `messages/${opts.ticketId}/${id}`;
    await h.env.AGENT_STORAGE.put(offloadKey, opts.body);
    storedBody = opts.body.slice(0, 200) + '... [offloaded]';
  }

  h.state.storage.sql.exec(
    `INSERT INTO messages (id, ticket_id, author, body, tool_calls_json, created_at, cost_usd, tokens_in, tokens_out, body_offload_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, opts.ticketId, opts.author, storedBody,
    opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
    now, costUsd, tokensIn, tokensOut, offloadKey,
  );

  // Update cost on ticket and project (with monthly reset)
  if (costUsd > 0) {
    h.state.storage.sql.exec(
      'UPDATE tickets SET cost_spent_usd = cost_spent_usd + ? WHERE id = ?',
      costUsd, opts.ticketId,
    );

    // Monthly cost reset: check if we're in a new month
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const proj = h.state.storage.sql
      .exec('SELECT cost_month, cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1')
      .toArray()[0] as { cost_month: string; cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;

    if (proj && proj.cost_month !== currentMonth) {
      // New month: reset counter
      h.state.storage.sql.exec(
        'UPDATE project SET cost_spent_monthly_usd = ?, cost_month = ?',
        costUsd, currentMonth,
      );
    } else {
      h.state.storage.sql.exec(
        'UPDATE project SET cost_spent_monthly_usd = cost_spent_monthly_usd + ?, cost_month = ?',
        costUsd, currentMonth,
      );
    }

    // Record in cost ledger (permanent, never reset)
    h.state.storage.sql.exec(
      `INSERT INTO cost_ledger (ticket_id, role, cost_usd, tokens_in, tokens_out, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      opts.ticketId, opts.author, costUsd, tokensIn, tokensOut, opts.model ?? 'unknown', now,
    );

    // Re-read after update for cap check
    const updated = h.state.storage.sql
      .exec('SELECT cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1')
      .toArray()[0] as { cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;

    if (updated && updated.cost_spent_monthly_usd >= updated.cost_cap_monthly_usd) {
      // Auto-fail all active tickets
      h.state.storage.sql.exec(
        `UPDATE tickets SET status = 'failed', stuck_reason = 'Monthly cost cap reached', updated_at = ?
         WHERE status IN ('ba-refining', 'dev-active', 'qa-active', 'qa-failed')`,
        now,
      );
      h.broadcast({ type: 'cost-cap-reached', spent: updated.cost_spent_monthly_usd, cap: updated.cost_cap_monthly_usd });
    }
  }

  // Bump the ticket's updated_at so the console's open-ticket panel detects the
  // new message and reloads (the client uses updatedAt as the change signature).
  h.state.storage.sql.exec('UPDATE tickets SET updated_at = ? WHERE id = ?', now, opts.ticketId);
  h.broadcast({ type: 'message', ticketId: opts.ticketId, messageId: id, author: opts.author });
  return id;
}
