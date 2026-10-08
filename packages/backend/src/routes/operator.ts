/**
 * Console operator view (#240): the owner-only context for one owned app — the
 * baseline the platform already has, plus the app's declared operator-view
 * contract (child 2, lib/operator-contract.ts) when it registered one — and
 * the reads that contract declares (slice 3): a resource's rows (searchable and
 * keyset-paged for users) and one record's detail. Reads run the app's own query
 * action through runOperatorQuery (the actions route's role gate, step_up and
 * audit) and return ONLY the declared columns/fields. Writes stay on the
 * ordinary actions route.
 *
 * Admitted via requireOperatorAccess (#293): the owner (creator, a team `owner`,
 * or a platform admin), or a holder of one of the contract's `admin_access.roles`.
 * Anyone else — another app's owner, a lesser team role or an undeclared role,
 * a signed-out caller — is refused before any app data is read. Admission grants
 * no action: each read and write runs under its action's own role, step_up and audit.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireRecentAuth } from '../lib/auth.js';
import { requireOperatorAccess } from '../lib/operator-audit-marks.js';
import type { OperatorResource, OperatorViewContract } from '../lib/operator-contract.js';
import { runOperatorQuery, runOperatorWrite } from './operator-exec.js';
import { REVIEW_CONTENT_TYPES, holdsReviewRole, recordReviewAccess } from '../lib/review-access.js';
import { isSensitiveField } from '../lib/sensitive-fields.js';
import { textParam } from '../lib/text-param.js';
import { CONSOLE_RP_ID } from './passkeys.js';

export const operatorRoutes = new Hono<{ Bindings: Env }>();

const ACTIVITY_DAYS = 30;
const MAX_SEARCH = 100;
const MAX_KEY = 200;

operatorRoutes.get('/apps/:appId/operator', async (c) => {
  const appId = c.req.param('appId');
  const operator = await requireOperatorAccess(c, appId);

  const since = new Date(Date.now() - (ACTIVITY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const [app, roles, activity, contract] = await Promise.all([
    c.env.DB.prepare('SELECT id, created_at FROM apps WHERE id = ?').bind(appId).first<{ id: string; created_at: number }>(),
    c.env.DB.prepare('SELECT COUNT(DISTINCT user_id) AS users FROM app_roles WHERE app_id = ?')
      .bind(appId).first<{ users: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS users,
              COALESCE(SUM(session_seconds), 0) AS session_seconds,
              COALESCE(SUM(api_calls), 0) AS api_calls
         FROM usage_daily WHERE app_id = ? AND day >= ?`,
    ).bind(appId, since).first<{ users: number; session_seconds: number; api_calls: number }>(),
    loadContract(c.env.DB, appId),
  ]);

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    app: { id: appId, createdAt: app?.created_at ?? null },
    operator: { userId: operator.id, login: operator.login },
    baseline: {
      usersWithRoles: Number(roles?.users ?? 0),
      activity: {
        days: ACTIVITY_DAYS,
        activeUsers: Number(activity?.users ?? 0),
        sessionSeconds: Number(activity?.session_seconds ?? 0),
        apiCalls: Number(activity?.api_calls ?? 0),
      },
    },
    contract,
  });
});

/** The app's stored contract. Stored only after validation; an unreadable row falls back to the baseline. */
export async function loadContract(db: D1Database, appId: string): Promise<OperatorViewContract | null> {
  const row = await db.prepare('SELECT contract FROM app_operator_view WHERE app_id = ?').bind(appId).first<{ contract: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.contract) as OperatorViewContract;
  } catch {
    console.error('[operator] unreadable operator_view contract', { appId });
    return null;
  }
}

/** The declared resource, or 404: an app without a contract keeps the baseline and has no resources. */
export async function declaredResource(db: D1Database, appId: string, id: string): Promise<OperatorResource> {
  const resource = (await loadContract(db, appId))?.resources.find((r) => r.id === id);
  if (!resource) throw new HttpError('resource not declared', 404);
  return resource;
}

/**
 * The declared keys the operator view may return (#294): the categorical
 * sensitive-field list (lib/sensitive-fields.ts) blocks the rest, whoever asks.
 * Registration already refuses such a key; this is the second layer, for a
 * contract stored before a term joined the list. Blocked names are logged,
 * never their values, and the field is simply absent from the response.
 */
export function returnableKeys<K extends { key: string }>(keys: K[], log: { appId: string; where: string }): K[] {
  const blocked = keys.filter((k) => isSensitiveField(k.key)).map((k) => k.key);
  if (blocked.length) console.warn('[operator] blocked sensitive fields', { ...log, fields: blocked });
  return blocked.length ? keys.filter((k) => !isSensitiveField(k.key)) : keys;
}

/** Only the declared keys, in declared order: undeclared columns never leave the platform. */
function project(row: Record<string, unknown>, keys: { key: string }[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(({ key }) => [key, row[key] ?? null]));
}

/** A KPI row: the declared columns as finite numbers (numeric strings parsed); anything else is null. */
export function kpiRow(row: Record<string, unknown>, keys: { key: string }[]): Record<string, number | null> {
  return Object.fromEntries(keys.map(({ key }) => {
    const v = row[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return [key, Number.isFinite(n) ? n : null];
  }));
}

/** requireOperatorAccess has already verified the `Bearer` session; the data worker gets the same token the actions route forwards. */
export const sessionToken = (header: string | undefined) => (header ?? '').slice(7).trim();

// ── Rows of one declared resource (#240) ─────────────────────────
// ?q= searches (resource.search), ?cursor= continues (resource.page), ?status=
// filters by a declared state (resource.status.param) and ?related= lists the
// rows for one record of another resource (resource.related, e.g. a user's
// suspension history). Each is refused on a resource that does not declare it.
// `next_cursor` is the last row's cursor column when the page came back full.
operatorRoutes.get('/apps/:appId/operator/resources/:resourceId', async (c) => {
  const appId = c.req.param('appId');
  const caller = await requireOperatorAccess(c, appId);
  const resource = await declaredResource(c.env.DB, appId, c.req.param('resourceId'));
  if (resource.series) throw new HttpError('this metric is a time series: read it from /operator/metrics/:id', 400);

  const input: Record<string, unknown> = {};
  const q = textParam(c.req.query('q'), MAX_SEARCH, 'q');
  if (q !== null) {
    if (!resource.search) throw new HttpError('resource is not searchable', 400);
    input[resource.search.param] = q;
  }
  const cursor = textParam(c.req.query('cursor'), MAX_KEY, 'cursor');
  if (cursor !== null) {
    if (!resource.page) throw new HttpError('resource is not paged', 400);
    input[resource.page.param] = cursor;
  }
  const status = textParam(c.req.query('status'), MAX_KEY, 'status');
  if (status !== null) {
    if (!resource.status?.param) throw new HttpError('resource has no status filter', 400);
    if (!resource.status.states.some((s) => s.value === status)) throw new HttpError('unknown status', 400);
    input[resource.status.param] = status;
  }
  const related = textParam(c.req.query('related'), MAX_KEY, 'related');
  if (related !== null) {
    if (!resource.related) throw new HttpError('resource is not listed per record', 400);
    input[resource.related.param] = related;
  }

  const rows = await runOperatorQuery(
    c.env, appId, resource.action, input, caller, sessionToken(c.req.header('Authorization')),
    { operatorAction: `read:${resource.id}`, target: related, request: c.req.raw },
  );
  c.header('Cache-Control', 'private, no-store');
  // A KPI panel (#245) is one row of aggregate numbers, whatever the app's query
  // returns: never a second row, never a string (an email, a name) in a tile.
  const columns = returnableKeys(resource.columns, { appId, where: `resource:${resource.id}` });
  if (resource.kind === 'metrics') return c.json({ rows: rows.slice(0, 1).map((row) => kpiRow(row, columns)), next_cursor: null });
  const page = resource.page;
  const bounded = rows.slice(0, page?.size ?? rows.length);
  const last = bounded[bounded.length - 1];
  const next = page && last && bounded.length >= page.size ? last[page.column] : null;
  return c.json({
    rows: bounded.map((row) => project(row, columns)),
    next_cursor: next === null || next === undefined ? null : String(next),
  });
});

// ── One record's detail (#240 slice 3) ────────────────────────────
// `key` is the value of the resource's `detail.key` column; it is handed to the
// app's detail action as `detail.param`, whose own SQL and role gate decide
// what it may return. Only the declared fields come back.
operatorRoutes.get('/apps/:appId/operator/resources/:resourceId/records/:key', async (c) => {
  const appId = c.req.param('appId');
  const caller = await requireOperatorAccess(c, appId);
  const resource = await declaredResource(c.env.DB, appId, c.req.param('resourceId'));
  if (!resource.detail) throw new HttpError('resource has no detail', 404);
  const key = textParam(c.req.param('key'), MAX_KEY, 'key');
  if (key === null) throw new HttpError('key is required', 400);

  const rows = await runOperatorQuery(
    c.env, appId, resource.detail.action, { [resource.detail.param]: key }, caller, sessionToken(c.req.header('Authorization')),
    { operatorAction: `detail:${resource.id}`, target: key, request: c.req.raw },
  );
  if (rows.length === 0) throw new HttpError('record not found', 404);
  const record = project(rows[0]!, returnableKeys(resource.detail.fields, { appId, where: `detail:${resource.id}` }));
  // Evidence fields hold storage paths: the console gets only whether a document is there.
  for (const { field } of resource.detail.evidence ?? []) if (field in record) record[field] = reviewPath(record[field]) !== null;
  c.header('Cache-Control', 'private, no-store');
  return c.json({ record });
});

/** A `_review/u/<uid>/<path>` document path from an app row, or null for anything else. */
function reviewPath(value: unknown): { ownerId: string; path: string } | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  const m = /^_review\/u\/([^/]+)\/(.+)$/.exec(value);
  const ownerId = m?.[1];
  const path = m?.[2];
  if (!ownerId || !path) return null;
  if ([ownerId, ...path.split('/')].some((seg) => !seg || seg === '.' || seg === '..') || /[\\\u0000]/.test(value)) return null;
  return { ownerId, path };
}

// ── One evidence document of a verification record (#240) ─────────
// Only after a recent passkey step-up (#244). The document path is never taken
// from the client: the record's detail action runs again (its role gate,
// step_up and audit apply) and the named evidence field of the fresh row must
// be a `_review/u/<uid>/<path>` path in THIS app's storage. The caller must
// also hold one of the app's review roles (#208), so the operator view never
// widens who may open review documents. Only document types are served, never
// cached, and the read joins the #208 access trail.
operatorRoutes.get('/apps/:appId/operator/resources/:resourceId/records/:key/evidence/:field', async (c) => {
  const appId = c.req.param('appId');
  const caller = await requireOperatorAccess(c, appId);
  const resource = await declaredResource(c.env.DB, appId, c.req.param('resourceId'));
  const field = c.req.param('field');
  const detail = resource.detail;
  if (!detail?.evidence?.some((e) => e.field === field)) throw new HttpError('evidence not declared', 404);
  const key = textParam(c.req.param('key'), MAX_KEY, 'key');
  if (key === null) throw new HttpError('key is required', 400);
  // An identity document needs a recent passkey step-up (#244), not just a recent
  // sign-in — before the review role is read, the record re-run or R2 touched.
  requireRecentAuth(caller, c.env, { method: 'passkey', rpId: CONSOLE_RP_ID });
  if (!(await holdsReviewRole(c.env.DB, appId, caller))) throw new HttpError('not a reviewer for this app', 403);

  const rows = await runOperatorQuery(
    c.env, appId, detail.action, { [detail.param]: key }, caller, sessionToken(c.req.header('Authorization')),
    { operatorAction: `evidence:${resource.id}.${field}`, target: key, request: c.req.raw },
  );
  const doc = rows.length ? reviewPath(rows[0]![field]) : null;
  if (!doc) throw new HttpError('no document for this record', 404);
  const object = await c.env.STORAGE.get(`${appId}/_review/u/${doc.ownerId}/${doc.path}`);
  if (!object) throw new HttpError('no document for this record', 404);
  const type = object.httpMetadata?.contentType ?? '';
  if (!REVIEW_CONTENT_TYPES.has(type)) throw new HttpError('document type is not viewable', 415);
  await recordReviewAccess(c.env.DB, appId, doc.ownerId, doc.path, caller.id, 'read');
  return new Response(object.body, {
    headers: {
      'content-type': type,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'content-disposition': 'inline',
    },
  });
});

/** A row value the console may send back as an action param: a bounded scalar. */
function scalar(value: unknown, column: string): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= MAX_KEY) return value;
  throw new HttpError(`row.${column} must be a string (max ${MAX_KEY} chars), number, boolean or null`, 400);
}

// ── Run one declared row action (#240 reports & suspensions) ────────
// Body: { row } — the row as the console displayed it. Only the declared
// columns the action maps are read from it; everything else is ignored. A
// transition is refused unless the row's status is one it leaves from, and the
// app's SQL re-checks that status (a guard that matches nothing is a 409). The
// write runs under the action's own role gate, step_up and audit, and the audit
// row names the contract action and its target.
operatorRoutes.post('/apps/:appId/operator/actions/:actionId', async (c) => {
  const appId = c.req.param('appId');
  const caller = await requireOperatorAccess(c, appId);
  const contract = await loadContract(c.env.DB, appId);
  const action = contract?.actions.find((a) => a.id === c.req.param('actionId'));
  const resource = contract?.resources.find((r) => r.id === action?.resource);
  if (!action || !resource) throw new HttpError('action not declared', 404);

  const body = await c.req.json<{ row?: unknown }>().catch(() => null);
  const row = body?.row;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError('row must be an object', 400);
  const cells = row as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  for (const [param, column] of Object.entries(action.params)) {
    if (!(column in cells)) throw new HttpError(`row.${column} is required`, 400);
    input[param] = scalar(cells[column], column);
  }
  if (action.transition) {
    const current = resource.status ? cells[resource.status.column] : undefined;
    if (typeof current !== 'string' || !action.transition.from.includes(current)) {
      throw new HttpError(`"${action.title}" is not available from status ${JSON.stringify(current ?? null)}`, 409);
    }
  }
  const target = action.target ? scalar(cells[action.target] ?? null, action.target) : null;

  const changes = await runOperatorWrite(
    c.env, appId, action.action, input, caller, sessionToken(c.req.header('Authorization')),
    { operatorAction: action.id, target: target === null ? null : String(target), request: c.req.raw }, Boolean(action.transition),
  );
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, changes });
});
