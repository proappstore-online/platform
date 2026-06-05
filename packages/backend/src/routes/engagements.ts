import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';

/**
 * Services Phase 2: engagements + service chat with per-prompt billing.
 *
 * Engagements:
 *   POST   /services/engagements              Direct hire (client picks a dev)
 *   GET    /services/engagements              List own engagements
 *   GET    /services/engagements/:id          Single engagement
 *   PATCH  /services/engagements/:id          Update status (deliver, cancel)
 *   POST   /services/engagements/:id/rate     Client rates the dev
 *
 * Service chat (per-prompt billing):
 *   GET    /services/engagements/:id/messages  Message history
 *   POST   /services/engagements/:id/messages  Send message (charges if dev)
 *
 * Build requests:
 *   POST   /services/requests                 Client posts a request
 *   GET    /services/requests                 List open requests
 *   POST   /services/requests/:id/accept      Dev accepts → creates engagement
 *   DELETE /services/requests/:id             Client cancels
 */

export const engagementRoutes = new Hono<{ Bindings: Env }>();

const PLATFORM_FEE_BPS = 1000; // 10%

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Best-effort email notification. Never throws — failures are silent.
 *  Body is plaintext (HTML-escaped before insertion into the email template). */
async function notify(env: Env, userId: string, subject: string, body: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  try {
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
      .bind(userId).first<{ email: string | null }>();
    if (!user?.email) return;
    const safe = escHtml(body);
    await sendEmail(
      { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? 'ProAppStore <noreply@proappstore.online>' },
      { to: user.email, subject: escHtml(subject), html: `<p>${safe}</p><p style="color:#999;font-size:12px"><a href="https://console.proappstore.online/#/services">Open Console</a></p>`, text: body },
    );
  } catch { /* best-effort */ }
}

// ── Engagements ──────────────────────────────────────────────

// Direct hire: client creates an engagement with a specific developer
engagementRoutes.post('/services/engagements', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ developerId: string; description?: string }>();
    if (!body.developerId) return c.json({ error: 'developerId required' }, 400);

    // Look up the developer's rate
    const dev = await c.env.DB.prepare('SELECT prompt_rate_cents, available FROM dev_profiles WHERE creator_id = ?')
      .bind(body.developerId).first<{ prompt_rate_cents: number; available: number }>();
    if (!dev) return c.json({ error: 'developer not found' }, 404);
    if (!dev.available) return c.json({ error: 'developer is not accepting clients' }, 400);
    if (body.developerId === user.id) return c.json({ error: 'cannot hire yourself' }, 400);

    // Rate limit: max 5 active engagements per client
    const activeCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS c FROM engagements WHERE client_id = ? AND status = 'active'",
    ).bind(user.id).first<{ c: number }>();
    if ((activeCount?.c ?? 0) >= 5) return c.json({ error: 'Too many active engagements (max 5). Complete or cancel one first.' }, 429);

    // Check client has minimum balance
    const bal = await c.env.DB.prepare('SELECT balance_cents FROM client_balances WHERE user_id = ?')
      .bind(user.id).first<{ balance_cents: number }>();
    if (!bal || bal.balance_cents < dev.prompt_rate_cents) {
      return c.json({ error: `Insufficient balance. You need at least $${(dev.prompt_rate_cents / 100).toFixed(2)} (one prompt). Top up first.` }, 402);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO engagements (id, client_id, developer_id, status, prompt_rate_cents, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(id, user.id, body.developerId, dev.prompt_rate_cents, now, now).run();

    // Seed a system message
    if (body.description) {
      await c.env.DB.prepare(
        `INSERT INTO service_messages (id, engagement_id, sender_role, sender_id, body, created_at)
         VALUES (?, ?, 'system', 'system', ?, ?)`,
      ).bind(crypto.randomUUID(), id, `Client wants: ${body.description}`, now).run();
    }

    // Notify the developer
    void notify(c.env, body.developerId, 'New client engagement on ProAppStore',
      `A client has hired you${body.description ? ` for: ${body.description.slice(0, 200)}` : ''}. Rate: $${(dev.prompt_rate_cents / 100).toFixed(2)}/prompt.`);

    return c.json({ id, status: 'active', promptRateCents: dev.prompt_rate_cents }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// List own engagements (both as client and as developer)
engagementRoutes.get('/services/engagements', async (c) => {
  try {
    const user = await requireUser(c);
    const rows = await c.env.DB.prepare(
      `SELECT e.*, u_client.login AS client_login, u_dev.login AS dev_login
       FROM engagements e
       LEFT JOIN users u_client ON u_client.id = e.client_id
       LEFT JOIN users u_dev ON u_dev.id = e.developer_id
       WHERE e.client_id = ? OR e.developer_id = ?
       ORDER BY e.updated_at DESC LIMIT 50`,
    ).bind(user.id, user.id).all<Record<string, unknown>>();

    return c.json({
      engagements: (rows.results ?? []).map((r) => engagementDto(r, user.id)),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Single engagement
engagementRoutes.get('/services/engagements/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const row = await c.env.DB.prepare(
      `SELECT e.*, u_client.login AS client_login, u_dev.login AS dev_login
       FROM engagements e
       LEFT JOIN users u_client ON u_client.id = e.client_id
       LEFT JOIN users u_dev ON u_dev.id = e.developer_id
       WHERE e.id = ? AND (e.client_id = ? OR e.developer_id = ?)`,
    ).bind(c.req.param('id'), user.id, user.id).first<Record<string, unknown>>();
    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json(engagementDto(row, user.id));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Update engagement status
engagementRoutes.patch('/services/engagements/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ status: string }>();
    const id = c.req.param('id');

    const row = await c.env.DB.prepare('SELECT * FROM engagements WHERE id = ?')
      .bind(id).first<{ client_id: string; developer_id: string; status: string }>();
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.client_id !== user.id && row.developer_id !== user.id) return c.json({ error: 'forbidden' }, 403);

    // Only dev can mark delivered; either party can cancel
    if (body.status === 'delivered' && row.developer_id !== user.id) return c.json({ error: 'only the developer can mark delivered' }, 403);
    if (!['delivered', 'cancelled'].includes(body.status)) return c.json({ error: 'status must be delivered or cancelled' }, 400);
    if (row.status !== 'active') return c.json({ error: 'engagement is not active' }, 400);

    // Require at least 1 dev message before delivery (prevents badge gaming)
    if (body.status === 'delivered') {
      const eng = await c.env.DB.prepare('SELECT prompts_count FROM engagements WHERE id = ?')
        .bind(id).first<{ prompts_count: number }>();
      if (!eng || eng.prompts_count < 1) return c.json({ error: 'Cannot deliver with zero prompts. Send at least one message first.' }, 400);
    }

    const now = Date.now();
    await c.env.DB.prepare('UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?')
      .bind(body.status, now, id).run();

    // Bump dev's completed count on delivery
    if (body.status === 'delivered') {
      await c.env.DB.prepare(
        'UPDATE dev_profiles SET completed_engagements = completed_engagements + 1, updated_at = ? WHERE creator_id = ?',
      ).bind(now, row.developer_id).run();
    }

    return c.json({ id, status: body.status });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Rate the developer (client only, once per engagement)
engagementRoutes.post('/services/engagements/:id/rate', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ score: number; comment?: string }>();
    const id = c.req.param('id');

    if (!body.score || body.score < 1 || body.score > 5 || !Number.isInteger(body.score)) return c.json({ error: 'score must be an integer 1-5' }, 400);
    if (body.comment && body.comment.length > 2000) return c.json({ error: 'comment too long (max 2000)' }, 400);

    const eng = await c.env.DB.prepare('SELECT * FROM engagements WHERE id = ?')
      .bind(id).first<{ client_id: string; developer_id: string; status: string }>();
    if (!eng) return c.json({ error: 'not found' }, 404);
    if (eng.client_id !== user.id) return c.json({ error: 'only the client can rate' }, 403);
    if (eng.status !== 'delivered') return c.json({ error: 'can only rate delivered engagements' }, 400);

    // Check for existing rating
    const existing = await c.env.DB.prepare('SELECT id FROM engagement_ratings WHERE engagement_id = ?')
      .bind(id).first();
    if (existing) return c.json({ error: 'already rated' }, 409);

    const now = Date.now();
    const ratingId = crypto.randomUUID();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO engagement_ratings (id, engagement_id, client_id, developer_id, score, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(ratingId, id, user.id, eng.developer_id, body.score, body.comment ?? null, now),
      // Update dev's avg rating
      c.env.DB.prepare(
        `UPDATE dev_profiles SET
           avg_rating = (SELECT AVG(score) FROM engagement_ratings WHERE developer_id = ?),
           rating_count = (SELECT COUNT(*) FROM engagement_ratings WHERE developer_id = ?),
           updated_at = ?
         WHERE creator_id = ?`,
      ).bind(eng.developer_id, eng.developer_id, now, eng.developer_id),
    ]);

    return c.json({ id: ratingId, score: body.score });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Service chat ─────────────────────────────────────────────

// Message history
engagementRoutes.get('/services/engagements/:id/messages', async (c) => {
  try {
    const user = await requireUser(c);
    const id = c.req.param('id');

    // Verify access
    const eng = await c.env.DB.prepare('SELECT client_id, developer_id FROM engagements WHERE id = ?')
      .bind(id).first<{ client_id: string; developer_id: string }>();
    if (!eng) return c.json({ error: 'not found' }, 404);
    if (eng.client_id !== user.id && eng.developer_id !== user.id) return c.json({ error: 'forbidden' }, 403);

    const rows = await c.env.DB.prepare(
      'SELECT * FROM service_messages WHERE engagement_id = ? ORDER BY created_at ASC LIMIT 500',
    ).bind(id).all<{
      id: string; engagement_id: string; sender_role: string; sender_id: string;
      body: string; charged: number; charge_cents: number; created_at: number;
    }>();

    return c.json({
      messages: (rows.results ?? []).map((r) => ({
        id: r.id,
        senderRole: r.sender_role,
        senderId: r.sender_id,
        body: r.body,
        charged: r.charged === 1,
        chargeCents: r.charge_cents,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Send message — charges client when dev sends
engagementRoutes.post('/services/engagements/:id/messages', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ body: string }>();
    if (!body.body?.trim()) return c.json({ error: 'body required' }, 400);
    if (body.body.length > 32768) return c.json({ error: 'message too long (max 32KB)' }, 413);

    const id = c.req.param('id');
    const eng = await c.env.DB.prepare(
      'SELECT * FROM engagements WHERE id = ?',
    ).bind(id).first<{
      client_id: string; developer_id: string; status: string; prompt_rate_cents: number;
    }>();
    if (!eng) return c.json({ error: 'not found' }, 404);
    if (eng.client_id !== user.id && eng.developer_id !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (eng.status !== 'active') return c.json({ error: 'engagement is not active' }, 400);

    const isDev = user.id === eng.developer_id;
    const senderRole = isDev ? 'developer' : 'client';
    const msgId = crypto.randomUUID();
    const now = Date.now();
    let chargeCents = 0;

    if (isDev) {
      // Rate limit: max 10 dev messages per minute per engagement, 30 globally
      const recentCount = await c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM service_messages
         WHERE engagement_id = ? AND sender_role = 'developer' AND created_at > ?`,
      ).bind(id, now - 60_000).first<{ c: number }>();
      if ((recentCount?.c ?? 0) >= 10) {
        return c.json({ error: 'Rate limit: max 10 messages per minute. Wait a moment.' }, 429);
      }
      // Global rate limit across all engagements
      const globalCount = await c.env.DB.prepare(
        `SELECT COUNT(*) AS c FROM service_messages sm
         JOIN engagements e ON e.id = sm.engagement_id
         WHERE e.developer_id = ? AND sm.sender_role = 'developer' AND sm.created_at > ?`,
      ).bind(user.id, now - 60_000).first<{ c: number }>();
      if ((globalCount?.c ?? 0) >= 30) {
        return c.json({ error: 'Global rate limit: max 30 messages per minute across all engagements.' }, 429);
      }

      // Minimum message length for charged messages
      if (body.body.trim().length < 20) {
        return c.json({ error: 'Developer messages must be at least 20 characters (you are charging for this).' }, 400);
      }

      // Charge flow: check balance, then do everything in one atomic batch.
      // The batch is a D1 transaction — if any statement fails, all roll back.
      // The conditional WHERE on the deduct prevents overdraft under concurrency.
      chargeCents = eng.prompt_rate_cents;
      const devEarned = Math.round(chargeCents * (10000 - PLATFORM_FEE_BPS) / 10000);
      const platformFee = chargeCents - devEarned;

      // Pre-check balance (fast reject without touching the DB in a write path)
      const bal = await c.env.DB.prepare('SELECT balance_cents FROM client_balances WHERE user_id = ?')
        .bind(eng.client_id).first<{ balance_cents: number }>();
      if (!bal || bal.balance_cents < chargeCents) {
        return c.json({ error: 'Client has insufficient balance. Ask them to top up.' }, 402);
      }

      // Atomic batch: deduct + record + message + totals. If any statement
      // fails the entire transaction rolls back (D1 batch guarantee).
      await c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE client_balances SET balance_cents = balance_cents - ?, total_spent_cents = total_spent_cents + ?, updated_at = ? WHERE user_id = ? AND balance_cents >= ?',
        ).bind(chargeCents, chargeCents, now, eng.client_id, chargeCents),
        c.env.DB.prepare(
          `INSERT INTO balance_transactions (id, user_id, type, amount_cents, engagement_id, description, created_at)
           VALUES (?, ?, 'charge', ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), eng.client_id, -chargeCents, id, `Dev prompt — $${(chargeCents / 100).toFixed(2)}`, now),
        c.env.DB.prepare(
          `INSERT INTO service_messages (id, engagement_id, sender_role, sender_id, body, charged, charge_cents, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(msgId, id, senderRole, user.id, body.body.trim(), chargeCents, now),
        c.env.DB.prepare(
          `UPDATE engagements SET
             prompts_count = prompts_count + 1,
             total_charged_cents = total_charged_cents + ?,
             total_dev_earned_cents = total_dev_earned_cents + ?,
             total_platform_fee_cents = total_platform_fee_cents + ?,
             updated_at = ?
           WHERE id = ?`,
        ).bind(chargeCents, devEarned, platformFee, now, id),
      ]);
    } else {
      // Client message — free
      await c.env.DB.prepare(
        `INSERT INTO service_messages (id, engagement_id, sender_role, sender_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(msgId, id, senderRole, user.id, body.body.trim(), now).run();
    }

    // Notify the other party (best-effort, async)
    const recipientId = isDev ? eng.client_id : eng.developer_id;
    const preview = body.body.trim().slice(0, 100);
    void notify(c.env, recipientId, `New message in your ProAppStore engagement`,
      `${isDev ? 'Developer' : 'Client'}: "${preview}${body.body.trim().length > 100 ? '...' : ''}"`);

    return c.json({
      id: msgId,
      senderRole,
      body: body.body.trim(),
      charged: isDev,
      chargeCents,
      createdAt: now,
    }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Build requests ───────────────────────────────────────────

// Client posts what they want built
engagementRoutes.post('/services/requests', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ title: string; description: string; budgetCents?: number }>();
    if (!body.title?.trim() || !body.description?.trim()) return c.json({ error: 'title and description required' }, 400);
    if (body.title.length > 200) return c.json({ error: 'title too long (max 200)' }, 400);
    if (body.description.length > 10000) return c.json({ error: 'description too long (max 10K)' }, 400);

    // Max 5 open requests per client
    const openCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS c FROM build_requests WHERE client_id = ? AND status = 'open'",
    ).bind(user.id).first<{ c: number }>();
    if ((openCount?.c ?? 0) >= 5) return c.json({ error: 'Too many open requests (max 5). Cancel one first.' }, 429);

    const id = crypto.randomUUID();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO build_requests (id, client_id, title, description, budget_cents, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).bind(id, user.id, body.title.trim(), body.description.trim(), body.budgetCents ?? null, now, now).run();

    return c.json({ id, status: 'open' }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// List open build requests (devs browse these)
engagementRoutes.get('/services/requests', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.*, u.login AS client_login
     FROM build_requests r
     LEFT JOIN users u ON u.id = r.client_id
     WHERE r.status = 'open'
     ORDER BY r.created_at DESC LIMIT 50`,
  ).all<Record<string, unknown>>();

  return c.json({
    requests: (rows.results ?? []).map((r) => ({
      id: r.id,
      clientLogin: r.client_login ?? 'anonymous',
      title: r.title,
      description: r.description,
      budgetCents: r.budget_cents,
      createdAt: r.created_at,
    })),
  });
});

// Dev accepts a build request → creates engagement
engagementRoutes.post('/services/requests/:id/accept', async (c) => {
  try {
    const user = await requireUser(c);
    const reqId = c.req.param('id');

    const req = await c.env.DB.prepare('SELECT * FROM build_requests WHERE id = ? AND status = ?')
      .bind(reqId, 'open').first<{ id: string; client_id: string; title: string; description: string }>();
    if (!req) return c.json({ error: 'request not found or already taken' }, 404);
    if (req.client_id === user.id) return c.json({ error: 'cannot accept your own request' }, 400);

    // Check dev has a profile
    const dev = await c.env.DB.prepare('SELECT prompt_rate_cents FROM dev_profiles WHERE creator_id = ?')
      .bind(user.id).first<{ prompt_rate_cents: number }>();
    if (!dev) return c.json({ error: 'create a developer profile first' }, 400);

    // Check client balance
    const bal = await c.env.DB.prepare('SELECT balance_cents FROM client_balances WHERE user_id = ?')
      .bind(req.client_id).first<{ balance_cents: number }>();
    if (!bal || bal.balance_cents < dev.prompt_rate_cents) {
      return c.json({ error: 'client has insufficient balance for even one prompt' }, 402);
    }

    // Atomically claim the request (prevents two devs accepting the same one)
    const now = Date.now();
    const claim = await c.env.DB.prepare(
      `UPDATE build_requests SET status = 'accepted', accepted_by = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
    ).bind(user.id, now, reqId).run();
    if (!claim.meta.changes) return c.json({ error: 'request already accepted by another developer' }, 409);

    const engId = crypto.randomUUID();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO engagements (id, client_id, developer_id, build_request_id, status, prompt_rate_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).bind(engId, req.client_id, user.id, reqId, dev.prompt_rate_cents, now, now),
      c.env.DB.prepare(
        `UPDATE build_requests SET engagement_id = ? WHERE id = ?`,
      ).bind(engId, reqId),
      // Seed system message
      c.env.DB.prepare(
        `INSERT INTO service_messages (id, engagement_id, sender_role, sender_id, body, created_at)
         VALUES (?, ?, 'system', 'system', ?, ?)`,
      ).bind(crypto.randomUUID(), engId, `Build request: ${req.title}\n\n${req.description}`, now),
    ]);

    // Notify the client their request was accepted
    void notify(c.env, req.client_id, 'Your build request was accepted on ProAppStore',
      `A developer accepted your request "${req.title}". The engagement is now active.`);

    return c.json({ engagementId: engId, status: 'active' }, 201);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Client cancels their build request
engagementRoutes.delete('/services/requests/:id', async (c) => {
  try {
    const user = await requireUser(c);
    const result = await c.env.DB.prepare(
      "UPDATE build_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND client_id = ? AND status = 'open'",
    ).bind(Date.now(), c.req.param('id'), user.id).run();
    if (!result.meta.changes) return c.json({ error: 'not found or already accepted' }, 404);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Admin: refund ────────────────────────────────────────────

// Admin-only: refund a client for a specific engagement (or partial amount)
engagementRoutes.post('/services/engagements/:id/refund', async (c) => {
  try {
    const user = await requireUser(c);
    // Admin check
    const adminIds = (c.env.ADMIN_GITHUB_IDS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    if (!adminIds.includes(user.id)) return c.json({ error: 'admin only' }, 403);

    const body = await c.req.json<{ amountCents: number; reason?: string }>();
    if (!body.amountCents || body.amountCents < 1) return c.json({ error: 'amountCents required (positive integer)' }, 400);

    const id = c.req.param('id');
    const eng = await c.env.DB.prepare('SELECT * FROM engagements WHERE id = ?')
      .bind(id).first<{ client_id: string; developer_id: string; total_charged_cents: number }>();
    if (!eng) return c.json({ error: 'engagement not found' }, 404);
    if (body.amountCents > eng.total_charged_cents) return c.json({ error: 'refund cannot exceed total charged' }, 400);

    const now = Date.now();
    const txId = crypto.randomUUID();

    await c.env.DB.batch([
      // Credit the client
      c.env.DB.prepare(
        'UPDATE client_balances SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ?',
      ).bind(body.amountCents, now, eng.client_id),
      // Record the refund transaction
      c.env.DB.prepare(
        `INSERT INTO balance_transactions (id, user_id, type, amount_cents, engagement_id, description, created_at)
         VALUES (?, ?, 'refund', ?, ?, ?, ?)`,
      ).bind(txId, eng.client_id, body.amountCents, id, body.reason ?? `Admin refund — $${(body.amountCents / 100).toFixed(2)}`, now),
    ]);

    return c.json({ ok: true, refundedCents: body.amountCents, transactionId: txId });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Helpers ──────────────────────────────────────────────────

// ── Client workspace view ────────────────────────────────────

// Get the workspace link for an engagement (client sees the dev's project)
engagementRoutes.get('/services/engagements/:id/workspace', async (c) => {
  try {
    const user = await requireUser(c);
    const id = c.req.param('id');
    const eng = await c.env.DB.prepare(
      'SELECT client_id, developer_id, project_slug, status FROM engagements WHERE id = ?',
    ).bind(id).first<{ client_id: string; developer_id: string; project_slug: string | null; status: string }>();
    if (!eng) return c.json({ error: 'not found' }, 404);
    if (eng.client_id !== user.id && eng.developer_id !== user.id) return c.json({ error: 'forbidden' }, 403);

    if (!eng.project_slug) {
      return c.json({ hasWorkspace: false, message: 'No workspace linked yet. The developer creates one from the Build tab.' });
    }

    return c.json({
      hasWorkspace: true,
      projectSlug: eng.project_slug,
      // Client gets a read-only view URL; dev gets the full workspace
      viewUrl: `/app/#/apps/${eng.project_slug}/build`,
      role: user.id === eng.client_id ? 'client' : 'developer',
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Link an engagement to an agent-teams project (dev only)
engagementRoutes.post('/services/engagements/:id/workspace', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ projectSlug: string }>();
    const id = c.req.param('id');
    if (!body.projectSlug) return c.json({ error: 'projectSlug required' }, 400);

    const eng = await c.env.DB.prepare('SELECT developer_id, status FROM engagements WHERE id = ?')
      .bind(id).first<{ developer_id: string; status: string }>();
    if (!eng) return c.json({ error: 'not found' }, 404);
    if (eng.developer_id !== user.id) return c.json({ error: 'only the developer can link a workspace' }, 403);
    if (eng.status !== 'active') return c.json({ error: 'engagement is not active' }, 400);

    await c.env.DB.prepare('UPDATE engagements SET project_slug = ?, updated_at = ? WHERE id = ?')
      .bind(body.projectSlug, Date.now(), id).run();

    return c.json({ ok: true, projectSlug: body.projectSlug });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Unread tracking ──────────────────────────────────────────

// Get unread counts across all user's engagements (for badge)
engagementRoutes.get('/services/unread', async (c) => {
  try {
    const user = await requireUser(c);
    const rows = await c.env.DB.prepare(
      `SELECT e.id, e.status,
              (SELECT COUNT(*) FROM service_messages m
               WHERE m.engagement_id = e.id
                 AND m.created_at > COALESCE(
                   (SELECT last_read_at FROM engagement_reads
                    WHERE engagement_id = e.id AND user_id = ?), 0)
                 AND m.sender_id != ?
              ) AS unread
       FROM engagements e
       WHERE (e.client_id = ? OR e.developer_id = ?) AND e.status = 'active'`,
    ).bind(user.id, user.id, user.id, user.id).all<{ id: string; unread: number }>();

    const total = (rows.results ?? []).reduce((sum, r) => sum + r.unread, 0);
    return c.json({
      total,
      engagements: (rows.results ?? []).filter(r => r.unread > 0).map(r => ({ id: r.id, unread: r.unread })),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// Mark an engagement as read (updates last_read_at)
engagementRoutes.post('/services/engagements/:id/read', async (c) => {
  try {
    const user = await requireUser(c);
    const id = c.req.param('id');
    // Verify access
    const eng = await c.env.DB.prepare('SELECT client_id, developer_id FROM engagements WHERE id = ?')
      .bind(id).first<{ client_id: string; developer_id: string }>();
    if (!eng) return c.json({ error: 'not found' }, 404);
    if (eng.client_id !== user.id && eng.developer_id !== user.id) return c.json({ error: 'forbidden' }, 403);

    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO engagement_reads (engagement_id, user_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(engagement_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    ).bind(id, user.id, now).run();

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

// ── Helpers ──────────────────────────────────────────────────

function engagementDto(row: Record<string, unknown>, userId: string) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientLogin: row.client_login ?? null,
    developerId: row.developer_id,
    devLogin: row.dev_login ?? null,
    projectSlug: row.project_slug ?? null,
    buildRequestId: row.build_request_id ?? null,
    status: row.status,
    promptRateCents: row.prompt_rate_cents,
    promptsCount: row.prompts_count,
    totalChargedCents: row.total_charged_cents,
    totalDevEarnedCents: row.total_dev_earned_cents,
    totalPlatformFeeCents: row.total_platform_fee_cents,
    role: userId === row.client_id ? 'client' : 'developer',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
