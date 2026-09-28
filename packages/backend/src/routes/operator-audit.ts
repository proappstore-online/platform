/**
 * The operator audit trail (#240): what the app's owner did in the console
 * operator view, from `app_action_audit` rows that carry an `operator_action`.
 *
 * - Entry: POST /v1/apps/:appId/operator/entries { visit } records entering
 *   the view once per visit — a console tab session per app, whose id the
 *   console keeps in sessionStorage. A repeated POST (rerender, remount, tab
 *   switch, poll) for the same visit writes nothing: the insert is guarded in
 *   the same statement.
 * - Refusals: operatorRefusalAudit records every refused operator request by a
 *   verified owner (role missing, step-up, conflict, validation…) once, unless
 *   the request already wrote its row. Callers who never passed the ownership
 *   check are not recorded, so a stranger cannot fill an app's trail.
 * - Trail: GET /v1/apps/:appId/operator/audit — owner-only (plus the
 *   contract's `audit.app_roles` when declared), 50 rows a page, newest first,
 *   keyset-paged and filterable. Rows carry who, what, which record, the
 *   outcome and when — never tokens, params, document paths or results.
 *   Targets of identity-verification reads and document views are hidden
 *   unless the session is recent (step-up), and reading the trail is itself
 *   recorded.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireRecentAuth, type FasUser } from '../lib/auth.js';
import { markAudited, operatorOwnerOf, requireOperatorOwner, wasAudited } from '../lib/operator-audit-marks.js';
import { loadContract } from './operator.js';

export const operatorAuditRoutes = new Hono<{ Bindings: Env }>();

const PAGE = 50;
const DAY = 86_400_000;
const MAX_DAYS = 366;
const MAX_TARGET = 200;
const KINDS = ['enter', 'audit', 'read', 'detail', 'evidence', 'series', 'action'] as const;
type Kind = (typeof KINDS)[number];
const PREFIXED: Kind[] = ['read', 'detail', 'evidence', 'series'];
const VISIT = /^[A-Za-z0-9_-]{8,64}$/;
/** The platform-held users list (#246). Contract resource ids cannot contain '-', so this never collides with one. */
export const PLATFORM_USERS_READ = 'read:platform-users';

export async function writeRow(
  db: D1Database,
  row: { appId: string; actorId: string; role: string; status: number; operatorAction: string; target: string | null },
): Promise<void> {
  try {
    await db.prepare(
      'INSERT INTO app_action_audit (app_id, action_name, actor_id, role_name, status, created_at, operator_action, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(row.appId, '', row.actorId, row.role, row.status, Date.now(), row.operatorAction, row.target).run();
  } catch (e) {
    console.error('[operator-audit] write failed', { appId: row.appId, operatorAction: row.operatorAction, err: String(e) });
  }
}

/** An operator_action as the trail shows it: its kind, the resource it touched and, for evidence, the field. */
export function parseOperatorAction(op: string): { kind: Kind; resource: string | null; field: string | null } {
  if (op === 'enter' || op === 'audit') return { kind: op, resource: null, field: null };
  const m = /^(read|detail|evidence|series):([^.]+)(?:\.(.+))?$/.exec(op);
  if (m) return { kind: m[1] as Kind, resource: m[2] ?? null, field: m[3] ?? null };
  return { kind: 'action', resource: null, field: null };
}

/** What a refused operator request was attempting, from its path (the handler never got to say). */
function attempted(path: string): { operatorAction: string; target: string | null } | null {
  const seg = path.split('/').slice(path.split('/').indexOf('operator') + 1).map((s) => {
    try { return decodeURIComponent(s).slice(0, 100); } catch { return s.slice(0, 100); }
  });
  const [a, id, b, key, c, field] = seg;
  if (!a || a === 'entries') return { operatorAction: 'enter', target: null };
  if (a === 'audit') return { operatorAction: 'audit', target: null };
  if (a === 'users' && !id) return { operatorAction: PLATFORM_USERS_READ, target: null };
  if (a === 'metrics' && id) return { operatorAction: `series:${id}`, target: null };
  if (a === 'actions' && id) return { operatorAction: id, target: null };
  if (a === 'resources' && id && !b) return { operatorAction: `read:${id}`, target: null };
  if (a === 'resources' && id && b === 'records' && key && !c) return { operatorAction: `detail:${id}`, target: key.slice(0, MAX_TARGET) };
  if (a === 'resources' && id && b === 'records' && key && c === 'evidence' && field) return { operatorAction: `evidence:${id}.${field}`, target: key.slice(0, MAX_TARGET) };
  return null;
}

/** Records a refused operator request by a verified owner — once, and only if nothing was recorded for it yet. */
export const operatorRefusalAudit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  const owner = operatorOwnerOf(c.req.raw);
  if (!owner || c.res.status < 400 || wasAudited(c.req.raw)) return;
  const what = attempted(c.req.path);
  if (!what) return;
  await writeRow(c.env.DB, { appId: c.req.param('appId') ?? '', actorId: owner.id, role: '', status: c.res.status, ...what });
};

// ── Entry into the operator view, once per visit ──────────────────────
operatorAuditRoutes.post('/apps/:appId/operator/entries', async (c) => {
  const appId = c.req.param('appId');
  const owner = await requireOperatorOwner(c, appId);
  const body = await c.req.json<{ visit?: unknown }>().catch(() => null);
  const visit = body?.visit;
  if (typeof visit !== 'string' || !VISIT.test(visit)) throw new HttpError('visit must be 8-64 characters of [A-Za-z0-9_-]', 400);
  const result = await c.env.DB.prepare(
    `INSERT INTO app_action_audit (app_id, action_name, actor_id, role_name, status, created_at, operator_action, target)
     SELECT ?1, '', ?2, '', 200, ?3, 'enter', ?4
      WHERE NOT EXISTS (SELECT 1 FROM app_action_audit WHERE app_id = ?1 AND actor_id = ?2 AND operator_action = 'enter' AND target = ?4)`,
  ).bind(appId, owner.id, Date.now(), visit).run();
  markAudited(c.req.raw);
  return c.json({ recorded: (result.meta?.changes ?? 0) > 0 });
});

/** A strict YYYY-MM-DD as UTC ms, or null. */
function day(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value) ? ms : null;
}

type Clause = { sql: string; binds: unknown[] };

/** kind → a clause over operator_action (constant SQL; the kind itself is bound). */
function kindClause(kind: string | undefined): Clause | null {
  if (kind === undefined) return null;
  if (!KINDS.includes(kind as Kind)) throw new HttpError(`kind must be one of ${KINDS.join(', ')}`, 400);
  if (kind === 'enter' || kind === 'audit') return { sql: 'a.operator_action = ?', binds: [kind] };
  if (PREFIXED.includes(kind as Kind)) return { sql: 'substr(a.operator_action, 1, ?) = ?', binds: [kind.length + 1, `${kind}:`] };
  return { sql: "a.operator_action NOT IN ('enter', 'audit') AND instr(a.operator_action, ':') = 0", binds: [] };
}

function outcomeClause(outcome: string | undefined): Clause | null {
  if (outcome === undefined) return null;
  if (outcome !== 'success' && outcome !== 'refused') throw new HttpError('outcome must be success or refused', 400);
  return { sql: outcome === 'success' ? 'a.status < 400' : 'a.status >= 400', binds: [] };
}

function exactClause(value: string | undefined, column: string, name: string, max: number): Clause | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > max) throw new HttpError(`${name} is too long (max ${max} chars)`, 400);
  return { sql: `${column} = ?`, binds: [v] };
}

function dateClause(from: string | undefined, to: string | undefined): Clause | null {
  if (from === undefined && to === undefined) return null;
  const toMs = to ? day(to) : Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const fromMs = from ? day(from) : (toMs ?? 0) - (MAX_DAYS - 1) * DAY;
  if (toMs === null || fromMs === null) throw new HttpError('from and to must be dates (YYYY-MM-DD)', 400);
  if (fromMs > toMs) throw new HttpError('from must not be after to', 400);
  if ((toMs - fromMs) / DAY + 1 > MAX_DAYS) throw new HttpError(`the date range may span at most ${MAX_DAYS} days`, 400);
  return { sql: 'a.created_at >= ? AND a.created_at < ?', binds: [fromMs, toMs + DAY] };
}

function cursorClause(cursor: string | undefined): Clause | null {
  if (cursor === undefined) return null;
  if (!/^[1-9]\d{0,15}$/.test(cursor)) throw new HttpError('cursor is invalid', 400);
  return { sql: 'a.id < ?', binds: [Number(cursor)] };
}

/** The trail's WHERE clause and binds for the validated filters. Clauses are constants; every value is bound. */
function filters(q: (name: string) => string | undefined): Clause {
  const clauses = [
    kindClause(q('kind')),
    outcomeClause(q('outcome')),
    exactClause(q('actor'), 'a.actor_id', 'actor', 100),
    exactClause(q('target'), 'a.target', 'target', MAX_TARGET),
    dateClause(q('from'), q('to')),
    cursorClause(q('cursor')),
  ].filter((cl): cl is Clause => cl !== null);
  return { sql: clauses.map((cl) => ` AND ${cl.sql}`).join(''), binds: clauses.flatMap((cl) => cl.binds) };
}

/** The role that lets `owner` read the trail: '' without an audit declaration, else a declared role they hold. */
async function trailRole(db: D1Database, appId: string, owner: FasUser, roles: string[] | undefined): Promise<string> {
  if (!roles?.length) return '';
  const row = await db.prepare(
    `SELECT role_name FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?) AND role_name IN (${roles.map(() => '?').join(', ')}) LIMIT 1`,
  ).bind(appId, owner.id, owner.login, ...roles).first<{ role_name: string }>();
  if (!row) throw new HttpError('requires app role', 403);
  return row.role_name;
}

interface AuditRow {
  id: number; created_at: number; actor_id: string; actor_login: string | null; role_name: string;
  action_name: string; operator_action: string; target: string | null; status: number;
}

// ── The trail ───────────────────────────────────────────────────────────
operatorAuditRoutes.get('/apps/:appId/operator/audit', async (c) => {
  const appId = c.req.param('appId');
  const owner = await requireOperatorOwner(c, appId);
  const contract = await loadContract(c.env.DB, appId);
  const role = await trailRole(c.env.DB, appId, owner, contract?.audit?.app_roles);
  const where = filters((name) => c.req.query(name));

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.created_at, a.actor_id, u.login AS actor_login, a.role_name, a.action_name, a.operator_action, a.target, a.status
       FROM app_action_audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.app_id = ? AND a.operator_action IS NOT NULL${where.sql}
      ORDER BY a.id DESC LIMIT ?`,
  ).bind(appId, ...where.binds, PAGE + 1).all<AuditRow>();

  // Identity data: who opened which verification record or document is shown only after a recent sign-in.
  const sensitive = new Set((contract?.resources ?? []).filter((r) => r.kind === 'verification').map((r) => r.id));
  let recent = true;
  try { requireRecentAuth(owner, c.env); } catch { recent = false; }
  const page = (results ?? []).slice(0, PAGE);
  let hidden = false;
  const rows = page.map((r) => {
    const parsed = parseOperatorAction(r.operator_action);
    const hide = !recent && r.target !== null && (parsed.kind === 'evidence' || (parsed.resource !== null && sensitive.has(parsed.resource)));
    hidden ||= hide;
    return {
      id: r.id,
      at: r.created_at,
      actor: { id: r.actor_id, login: r.actor_login },
      role: r.role_name || null,
      ...parsed,
      operation: r.operator_action,
      action: r.action_name || null,
      target: hide ? null : r.target,
      target_hidden: hide,
      status: r.status,
      outcome: r.status < 400 ? 'success' : 'refused',
    };
  });

  await writeRow(c.env.DB, { appId, actorId: owner.id, role, status: 200, operatorAction: 'audit', target: null });
  markAudited(c.req.raw);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    rows,
    next_cursor: (results?.length ?? 0) > PAGE ? String(page[page.length - 1]!.id) : null,
    targets_hidden: hidden,
  });
});
