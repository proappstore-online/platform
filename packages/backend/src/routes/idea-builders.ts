import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

/**
 * "I'm building this" claims on the storefront's App ideas page
 * (https://proappstore.online/ideas).
 *
 * Store-level and owned by the platform: one claim per platform user per idea,
 * enforced by PRIMARY KEY (idea_id, user_id). Ideas are the storefront's static
 * data, so an idea id is only checked for shape, never looked up.
 *
 * Only claims made (or refreshed) in the last 90 days count: an abandoned claim
 * must not keep an idea looking like someone is working on it.
 *
 * Same contract as FreeAppStore's idea-builders routes — the storefront's
 * ideas page is shared between the two stores.
 */

/** A claim older than this is stale: not counted, not held against the user's cap. */
export const CLAIM_ACTIVE_S = 90 * 24 * 60 * 60;
/** Most active claims one user may hold at once. */
export const MAX_ACTIVE_CLAIMS = 10;
/** Most new claims one user may make within RATE_LIMIT_WINDOW_S. */
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX = 10;

const IDEA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const nowS = () => Math.floor(Date.now() / 1000);

function ideaIdParam(raw: string | undefined): string {
  if (!raw || !IDEA_ID.test(raw)) throw new HttpError('invalid idea id', 400);
  return raw;
}

async function activeCount(db: D1Database, ideaId: string, now: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS cnt FROM idea_builders WHERE idea_id = ? AND created_at > ?')
    .bind(ideaId, now - CLAIM_ACTIVE_S)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export const ideaBuildersRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/store/idea-builders
 * Public. { builders: { [ideaId]: count } } over active claims.
 * With a valid bearer token, also { mine: { [ideaId]: true } } — personal state,
 * so that response is never shared-cacheable. A bad token is a 401, not a
 * silent anonymous answer (the client drops it and retries without).
 */
ideaBuildersRoutes.get('/store/idea-builders', async (c) => {
  const since = nowS() - CLAIM_ACTIVE_S;
  const { results } = await c.env.DB.prepare(
    'SELECT idea_id, COUNT(*) AS count FROM idea_builders WHERE created_at > ? GROUP BY idea_id',
  ).bind(since).all<{ idea_id: string; count: number }>();

  const builders: Record<string, number> = {};
  for (const row of results ?? []) builders[row.idea_id] = row.count;

  if (!c.req.header('authorization')) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ builders });
  }

  const user = await requireUser(c);
  const { results: mineRows } = await c.env.DB.prepare(
    'SELECT idea_id FROM idea_builders WHERE user_id = ? AND created_at > ?',
  ).bind(user.id, since).all<{ idea_id: string }>();
  const mine: Record<string, true> = {};
  for (const row of mineRows ?? []) mine[row.idea_id] = true;

  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization');
  return c.json({ builders, mine });
});

/**
 * POST /v1/store/ideas/:ideaId/builder
 * Auth. Idempotent: claiming again refreshes the claim's age.
 * 409 past MAX_ACTIVE_CLAIMS active claims, 429 past RATE_LIMIT_MAX new claims
 * per RATE_LIMIT_WINDOW_S. Refreshing a claim already held is neither.
 * → { building: true, count }
 */
ideaBuildersRoutes.post('/store/ideas/:ideaId/builder', async (c) => {
  const ideaId = ideaIdParam(c.req.param('ideaId'));
  const user = await requireUser(c);
  const db = c.env.DB;
  const now = nowS();

  const held = await db.prepare(
    'SELECT 1 FROM idea_builders WHERE idea_id = ? AND user_id = ? AND created_at > ?',
  ).bind(ideaId, user.id, now - CLAIM_ACTIVE_S).first();

  if (!held) {
    const active = await db.prepare(
      'SELECT COUNT(*) AS cnt FROM idea_builders WHERE user_id = ? AND created_at > ?',
    ).bind(user.id, now - CLAIM_ACTIVE_S).first<{ cnt: number }>();
    if ((active?.cnt ?? 0) >= MAX_ACTIVE_CLAIMS) {
      return c.json({ error: `You can build at most ${MAX_ACTIVE_CLAIMS} ideas at once` }, 409);
    }
    // Counted per attempted new claim in its own table: a claim/release loop
    // leaves nothing in idea_builders to count. One atomic upsert opens or rolls
    // the window and increments, so parallel requests each see a distinct count.
    const rate = await db.prepare(
      `INSERT INTO idea_builder_rate (user_id, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
         count        = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END
       RETURNING count`,
    ).bind(user.id, now, RATE_LIMIT_WINDOW_S).first<{ count: number }>();
    if ((rate?.count ?? 0) > RATE_LIMIT_MAX) {
      return c.json({ error: 'Too many claims — try again in a minute' }, 429);
    }
  }

  await db.prepare(
    `INSERT INTO idea_builders (idea_id, user_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(idea_id, user_id) DO UPDATE SET created_at = excluded.created_at`,
  ).bind(ideaId, user.id, now).run();

  return c.json({ building: true, count: await activeCount(db, ideaId, now) });
});

/**
 * DELETE /v1/store/ideas/:ideaId/builder
 * Auth. Idempotent: removing a claim that is not there is still a 200.
 * → { building: false, count }
 */
ideaBuildersRoutes.delete('/store/ideas/:ideaId/builder', async (c) => {
  const ideaId = ideaIdParam(c.req.param('ideaId'));
  const user = await requireUser(c);
  const db = c.env.DB;

  await db.prepare('DELETE FROM idea_builders WHERE idea_id = ? AND user_id = ?').bind(ideaId, user.id).run();

  return c.json({ building: false, count: await activeCount(db, ideaId, nowS()) });
});
