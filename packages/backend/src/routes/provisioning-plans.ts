/**
 * Creator Console provisioning preview and explicit confirmation (#367).
 *
 *   POST /v1/provisioning/plans                    read-only preview → a stored plan
 *   POST /v1/provisioning/plans/:planId/confirm    execute exactly that plan, once
 *   GET  /v1/provision-operations/:appId           progress (existing, provision.ts)
 *   GET  /v1/apps/:appId/record-state                  whose PAS app record this is (#370)
 *
 * The workflow is the `provision_pas_app` one, run by the MCP worker (which holds
 * the org GitHub credential) over the MCP service binding with INTERNAL_TOKEN and
 * the caller's own PAS session. This route adds no credential, permission or
 * override: normal compliance always runs, only approved templates are accepted,
 * and the existing ownership / untouched-scaffold rules decide what may happen.
 *
 * The plan the user saw is stored here, bound to that user, and expires. A
 * confirmation re-plans; if any bound fact changed it answers 409 with the fresh
 * plan and nothing runs. Concurrent or repeated confirmations join the one
 * durable receipt (#358) instead of starting a second execution.
 * Contract: docs/provisioning-api.md.
 */
import { Hono, type Context } from 'hono';
import { TEMPLATE_REV_RE } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { getProvisionOperation } from '../lib/provision-operation.js';
import { operationResponse } from './provision.js';
import { APP_ID_RE } from './validation.js';

export const provisioningPlanRoutes = new Hono<{ Bindings: Env }>();

/** A preview is good for this long; confirm after it means previewing again. */
export const PLAN_TTL_MS = 10 * 60 * 1000;
/** One confirmation at a time per plan; longer than a full bootstrap takes. */
export const EXECUTION_LEASE_MS = 15 * 60 * 1000;
const ORG = 'proappstore-online';

interface PlanRow {
  plan_id: string;
  user_id: string;
  app_id: string;
  input_json: string;
  plan_json: string;
  expires_at: number;
  receipt_id: string | null;
}

/** The plan as the MCP worker returns it; only the fields this route reads are typed. */
interface StoredPlan {
  appId: string;
  blockers: { code: string; message: string }[];
  [key: string]: unknown;
}

function sessionToken(c: Context<{ Bindings: Env }>): string {
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) throw new HttpError('Missing or invalid Authorization header', 401);
  return header.slice(7).trim();
}

async function callWorkflow(
  c: Context<{ Bindings: Env }>,
  step: 'plan' | 'execute',
  token: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  if (!c.env.MCP || !c.env.INTERNAL_TOKEN) throw new HttpError('provisioning service is not configured', 503);
  let res: Response;
  try {
    res = await c.env.MCP.fetch(`https://mcp/internal/provisioning/${step}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': c.env.INTERNAL_TOKEN, 'X-PAS-Session': token },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError('provisioning service is unreachable — retry later', 503);
  }
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { status: res.status, data };
}

function stringField(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(`${field} is required`, 400);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(`${field} must be at most ${max} characters`, 400);
  return trimmed;
}

/**
 * #370: the caller's relation to an app record, read from the apps and
 * team_members tables — `owner` (the creator, or the team `owner` role),
 * `other` (it exists and is not theirs), `none` (no record). A platform admin's
 * role is deliberately ignored: being allowed to operate an app is not owning
 * it, and an admin-authorised read must not stand in for existence (the
 * listing route answers an admin 200 with an empty DTO for any id). Read-only.
 */
provisioningPlanRoutes.get('/apps/:appId/record-state', wrap(async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId') ?? '';
  if (!APP_ID_RE.test(appId)) throw new HttpError('Invalid app ID', 400);
  const row = await c.env.DB.prepare(
    `SELECT a.creator_id, tm.role AS team_role
       FROM apps a LEFT JOIN team_members tm ON tm.app_id = a.id AND tm.user_id = ?
      WHERE a.id = ?`,
  ).bind(user.id, appId).first<{ creator_id: string; team_role: string | null }>();
  const state = !row ? 'none' : row.creator_id === user.id || row.team_role === 'owner' ? 'owner' : 'other';
  c.header('Cache-Control', 'private, no-store');
  return c.json({ appId, state });
}));

provisioningPlanRoutes.post('/provisioning/plans', wrap(async (c) => {
  const user = await requireUser(c);
  const token = sessionToken(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('JSON body required', 400);

  const appId = typeof body.appId === 'string' ? body.appId : '';
  if (!APP_ID_RE.test(appId)) throw new HttpError('Invalid app ID', 400);
  const name = stringField(body.name, 'name', 80);
  const description = stringField(body.description, 'description', 300);
  const template = stringField(body.template, 'template', 100);
  // The repository is named explicitly and must be the one the platform
  // provisions for this app id: no other repository is ever inferred or used.
  const repoUrl = `https://github.com/${ORG}/${appId}`;
  if (body.repoUrl !== repoUrl) throw new HttpError(`repoUrl must be ${repoUrl}`, 400);
  if (body.templateRev !== undefined && (typeof body.templateRev !== 'string' || !TEMPLATE_REV_RE.test(body.templateRev))) {
    throw new HttpError('templateRev must be a git object id (7–40 hex chars)', 400);
  }
  const input = { appId, name, description, template, repoUrl, ...(body.templateRev ? { templateRev: body.templateRev as string } : {}) };

  const planned = await callWorkflow(c, 'plan', token, { input });
  if (planned.status === 400) return c.json({ error: String(planned.data?.error ?? 'invalid provisioning request') }, 400);
  const plan = planned.data?.plan as StoredPlan | undefined;
  if (planned.status !== 200 || !plan || plan.appId !== appId || !Array.isArray(plan.blockers)) {
    return c.json({ error: 'provisioning preview is unavailable — retry later' }, 502);
  }

  const planId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + PLAN_TTL_MS;
  await c.env.DB.prepare(
    `INSERT INTO provisioning_plans (plan_id, user_id, app_id, input_json, plan_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(planId, user.id, appId, JSON.stringify(input), JSON.stringify(plan), now, expiresAt).run();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ planId, expiresAt, plan }, 201);
}));

provisioningPlanRoutes.post('/provisioning/plans/:planId/confirm', wrap(async (c) => {
  const user = await requireUser(c);
  const token = sessionToken(c);
  const planId = c.req.param('planId');
  c.header('Cache-Control', 'private, no-store');
  const row = await c.env.DB.prepare(
    'SELECT plan_id, user_id, app_id, input_json, plan_json, expires_at, receipt_id FROM provisioning_plans WHERE plan_id = ?',
  ).bind(planId).first<PlanRow>();
  // Someone else's plan is indistinguishable from no plan.
  if (!row || row.user_id !== user.id) return c.json({ error: 'plan_not_found' }, 404);
  const plan = JSON.parse(row.plan_json) as StoredPlan;
  const now = Date.now();

  /** The caller's own receipt for this app, as the existing progress route shows it. */
  const ownOperation = async () => {
    const operation = await getProvisionOperation(c.env.DB, row.app_id);
    return operation && operation.creatorId === user.id ? operation : null;
  };

  // Already confirmed and still running, or done: a repeat joins it.
  if (row.receipt_id) {
    const operation = await ownOperation();
    if (operation && operation.receiptId === row.receipt_id && (operation.status === 'pending' || operation.status === 'completed')) {
      return c.json({ planId, ...operationResponse(operation, true) });
    }
  }
  if (row.expires_at <= now) return c.json({ error: 'plan_expired' }, 410);
  if (plan.blockers.length > 0) return c.json({ error: 'plan_blocked', plan }, 422);

  // One execution at a time: a concurrent confirm joins the one in flight.
  const claimed = await c.env.DB.prepare(
    `UPDATE provisioning_plans SET executing_until = ?
      WHERE plan_id = ? AND user_id = ? AND (executing_until IS NULL OR executing_until <= ?)`,
  ).bind(now + EXECUTION_LEASE_MS, planId, user.id, now).run();
  if (!claimed.meta.changes) {
    const operation = await ownOperation();
    return c.json({ planId, ...(operation ? operationResponse(operation, true) : { appId: row.app_id, status: 'pending', receipt: null, steps: [], joined: true }) }, 202);
  }

  let executed: Awaited<ReturnType<typeof callWorkflow>>;
  try {
    executed = await callWorkflow(c, 'execute', token, { plan });
  } finally {
    await c.env.DB.prepare('UPDATE provisioning_plans SET executing_until = NULL WHERE plan_id = ?').bind(planId).run();
  }
  const data = executed.data ?? {};
  if (executed.status === 409) return c.json({ error: 'plan_changed', plan: data.plan }, 409);
  if (executed.status === 422) return c.json({ error: 'plan_blocked', plan: data.plan }, 422);
  if (executed.status === 400) return c.json({ error: String(data.error ?? 'invalid plan') }, 400);
  if (executed.status === 503) return c.json({ error: String(data.error ?? 'provisioning is temporarily unavailable — retry later') }, 503);
  if (executed.status !== 200 || typeof data.receipt !== 'string') {
    return c.json({ error: 'provisioning service returned an unexpected response' }, 502);
  }

  await c.env.DB.prepare('UPDATE provisioning_plans SET receipt_id = ?, confirmed_at = COALESCE(confirmed_at, ?) WHERE plan_id = ?')
    .bind(data.receipt, now, planId).run();
  const operation = await ownOperation();
  return c.json({
    planId,
    ...(operation ? operationResponse(operation, data.joined === true) : { appId: row.app_id, receipt: data.receipt, status: 'pending', steps: [], joined: data.joined === true }),
    ...(typeof data.repoAction === 'string' ? { repoAction: data.repoAction } : {}),
    ...(typeof data.succeeded === 'boolean' ? { succeeded: data.succeeded } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(Array.isArray(data.lines) ? { log: data.lines } : {}),
  });
}));
