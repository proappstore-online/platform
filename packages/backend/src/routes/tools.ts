/**
 * App tool CRUD — apps register MCP tools via `pas publish` (reads mcp.json).
 *
 * The MCP server reads them back through GET /v1/apps/:appId/tools for one
 * app (an app-scoped session registers that app's tools; the shared session
 * reaches them through list_app_tools / call_app_tool, #157). Callers outside
 * the app's team get only the allowlisted public view — never SQL (#158).
 * There is no cross-app listing: GET /v1/tools was retired (#193).
 */

import { Hono } from 'hono';
import { evaluateUnscoped, validateApprovals, validatePermissions, type UnscopedPolicyTool } from '@proappstore/compliance';
import { declaredPermissionsStatement } from '../lib/app-permissions.js';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireAppAccess, requireAppOwner, requireUser } from '../lib/auth.js';
import { forgetAppVisibility, PUBLIC_VISIBILITY, requireVisible, visibilityFromRow } from '../lib/visibility.js';
import { type ActionState, type ToolManifest } from '../lib/action-sql.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import { inspectAdminConsole, operatorCapabilities, previewAdminConsole, proposeAdminUpdate, securityReview, type RoleContext } from '../lib/operator-authoring.js';
import { loadContract } from './operator.js';
import { refuseAppMediated } from '../lib/operator-audit-marks.js';
import { MAX_TOOLS_PER_APP, MANIFEST_BYTES_SOFT_LIMIT, TOOLS_WARN_THRESHOLD, measureManifestCost, openUnscopedWrite, type ToolSource } from '../lib/manifest/tool.js';
import { toolStatements, validateToolSet } from '../lib/manifest/tool-set.js';
import { siteManifestFrom, validateSiteManifest, type SiteManifest } from '../lib/manifest/site.js';
import { validateOperatorGate } from '../lib/manifest/operator.js';
import { validateVisibility } from '../lib/manifest/visibility.js';
import { validateWorkerManifest } from '../lib/manifest/worker.js';
import { validateHooks } from '../lib/manifest/hooks.js';
import { validateConnectors } from '../lib/manifest/connectors.js';
import { validateRooms } from '../lib/manifest/rooms.js';
import { validateEmbed } from '../lib/manifest/embed.js';

export const toolsRoutes = new Hono<{ Bindings: Env }>();

/** An app's code action as registered now: its manifest and its state (#428). */
export interface RegisteredTool { manifest: ToolManifest; state: ActionState }

/** The app's registered code actions, by name. An unreadable manifest is left out: it counts as new. */
async function readRegisteredTools(db: D1Database, appId: string): Promise<Map<string, RegisteredTool>> {
  const { results } = await db.prepare("SELECT name, manifest, state FROM app_tools WHERE app_id = ? AND source = 'code'")
    .bind(appId).all<{ name: string; manifest: string; state?: string | null }>();
  const registered = new Map<string, RegisteredTool>();
  for (const row of results ?? []) {
    try {
      registered.set(row.name, { manifest: JSON.parse(row.manifest) as ToolManifest, state: row.state === 'staged' ? 'staged' : 'live' });
    } catch { /* unreadable */ }
  }
  return registered;
}

/**
 * #428: what decides who may call an action — its statements and its access.
 * A change to any of them is a new action as far as staging is concerned;
 * descriptions, params docs and the like are not.
 */
function actionShape(tool: ToolManifest): string {
  return JSON.stringify({
    statements: toolStatements(tool).map((st) => st.trim()),
    requires_auth: tool.requires_auth,
    auth: tool.auth ?? null,
    callers: tool.callers ?? null,
    schedule: tool.schedule ?? null,
  });
}

/**
 * #428: the state each submitted action registers in. An unchanged action keeps
 * its state. A new or changed one is live when the app is live — `wentLive` (its
 * worker is enabled, or its go-live is recorded in app_go_live), or it already
 * serves a live action — and staged otherwise, so an app's actions are not
 * callable by its users before it goes live.
 */
export function stagedStates(
  tools: ToolManifest[],
  registered: Map<string, RegisteredTool>,
  wentLive: boolean,
): Map<string, ActionState> {
  const appLive = wentLive || [...registered.values()].some((r) => r.state === 'live');
  const states = new Map<string, ActionState>();
  for (const tool of tools) {
    const before = registered.get(tool.name);
    states.set(tool.name, before && actionShape(before.manifest) === actionShape(tool) ? before.state : appLive ? 'live' : 'staged');
  }
  return states;
}

/**
 * Deny-by-default for open unscoped actions (#426), the policy in
 * `@proappstore/compliance` lib/unscoped-policy.ts. An action any signed-in user can
 * run without `:__user_id` needs a reviewed `approved_unscoped` entry and may not
 * return personal data. What is registered now, unchanged, is grandfathered with a
 * warning, so this lands without breaking the next deploy of every app that has one.
 */
function gateUnscoped(
  appId: string,
  tools: ToolManifest[],
  approvedUnscoped: unknown,
  registered: Map<string, RegisteredTool>,
): { error: string } | { warnings: string[] } {
  const approvals = validateApprovals(approvedUnscoped);
  if ('error' in approvals) return { error: approvals.error };
  const previous = new Map<string, UnscopedPolicyTool>();
  for (const [name, row] of registered) previous.set(name, row.manifest as UnscopedPolicyTool);
  const verdict = evaluateUnscoped({ tools: tools as UnscopedPolicyTool[], approvals: approvals.approvals, previous });
  if (verdict.errors.length) return { error: verdict.errors.join('; ') };
  if (verdict.grandfathered.length) console.warn(`[unscoped] grandfathered app=${appId} ${verdict.grandfathered.join(',')}`);
  return { warnings: verdict.warnings };
}

export async function replaceAppTools(
  db: D1Database,
  appId: string,
  tools: unknown,
  env?: Env,
  site: SiteManifest = {},
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!tools || !Array.isArray(tools)) {
    return { status: 400, payload: { error: 'tools array required' } };
  }
  // Abuse bound, not a design target. Data-heavy apps register one tool per
  // parameterized statement (chess-academy needs ~80, a real CRM/ERP surface
  // crosses 120), so the cap sits well above any legitimate manifest (#116).
  // Payload size is bounded separately by the byte-cost soft warning above.
  // Counts the submitted code tools only; console endpoints have their own cap.
  if (tools.length > MAX_TOOLS_PER_APP) {
    return {
      status: 400,
      payload: { error: `too many tools: received ${tools.length}, max ${MAX_TOOLS_PER_APP} per app` },
    };
  }
  const invalid = await validateToolSet(tools as ToolManifest[], env, appId, { source: 'code' });
  if (invalid) return invalid;
  const siteResult = validateSiteManifest(tools as ToolManifest[], site);
  if ('error' in siteResult) return { status: 400, payload: { error: siteResult.error } };
  const operatorResult = validateOperatorGate(site.operator);
  if ('error' in operatorResult) return { status: 400, payload: { error: operatorResult.error } };
  const operatorView = validateOperatorView(tools as ToolManifest[], site.operator_view);
  if ('error' in operatorView) return { status: 400, payload: { error: operatorView.error } };
  const visibilityResult = validateVisibility(site.visibility, tools as ToolManifest[]);
  if ('error' in visibilityResult) return { status: 400, payload: { error: visibilityResult.error } };
  const workerResult = validateWorkerManifest(site.worker);
  if ('error' in workerResult) return { status: 400, payload: { error: workerResult.error } };
  const hooksResult = validateHooks(site.hooks, tools as ToolManifest[]);
  if ('error' in hooksResult) return { status: 400, payload: { error: hooksResult.error } };
  const connectorsResult = validateConnectors(site.connectors, hooksResult.hooks);
  if ('error' in connectorsResult) return { status: 400, payload: { error: connectorsResult.error } };
  const roomsResult = validateRooms(site.rooms, tools as ToolManifest[]);
  if ('error' in roomsResult) return { status: 400, payload: { error: roomsResult.error } };
  const permissionsResult = validatePermissions(site.permissions);
  if ('error' in permissionsResult) return { status: 400, payload: { error: permissionsResult.error } };
  const embedResult = validateEmbed(site.embed);
  if ('error' in embedResult) return { status: 400, payload: { error: embedResult.error } };
  // `to: "worker"` needs app workers turned on for this app — the flag, not a
  // finished deploy, so registration never depends on the worker step's order.
  if (hooksResult.hooks.some((h) => h.to === 'worker')) {
    const flag = await db.prepare('SELECT enabled FROM app_workers WHERE app_id = ?').bind(appId).first<{ enabled: number }>()
      .catch(() => null);
    if (flag?.enabled !== 1) return { status: 400, payload: { error: 'hooks: to "worker" needs app workers enabled for this app' } };
  }
  const registered = await readRegisteredTools(db, appId);
  const unscoped = gateUnscoped(appId, tools as ToolManifest[], site.approved_unscoped, registered);
  if ('error' in unscoped) return { status: 400, payload: { error: unscoped.error } };
  // Live by its worker, or by a recorded go-live (#429: migration 0109): a deploy that
  // cleared the app's tools must not make a live app's next actions staged.
  const appLive = await db.prepare(
    'SELECT (SELECT enabled FROM app_workers WHERE app_id = ?1) AS worker, (SELECT 1 FROM app_go_live WHERE app_id = ?1) AS marked',
  ).bind(appId).first<{ worker: number | null; marked: number | null }>()
    .then((r) => r?.worker === 1 || r?.marked === 1, () => false);
  const states = stagedStates(tools as ToolManifest[], registered, appLive);

  // A deploy replaces the CODE tools only (#155): console-defined endpoints live
  // in the same table under source = 'console' and are never touched here — a
  // push with no mcp.json clears the code set and leaves the console's work.
  const now = Date.now();
  const stmts = [
    // #443: upsert, not delete-and-reinsert (console endpoints are api_*, which code tools may not use, so no clash). A promote (or worker enable) that landed after
    // `registered` was read must survive, so for an action whose shape is unchanged the row's
    // state is decided here at write time: staged only if it is still staged now.
    db.prepare("DELETE FROM app_tools WHERE app_id = ? AND source = 'code' AND name NOT IN (SELECT value FROM json_each(?))")
      .bind(appId, JSON.stringify((tools as ToolManifest[]).map((t) => t.name))),
    // Re-registration is the explicit breaker reset: a deploy confirms that
    // the owner reviewed the manifest before unattended work resumes.
    db.prepare("DELETE FROM scheduled_action_state WHERE app_id = ? AND source = 'code'").bind(appId),
    ...(tools as ToolManifest[]).map(tool => {
      const before = registered.get(tool.name);
      const unchanged = before !== undefined && actionShape(before.manifest) === actionShape(tool);
      return db.prepare(
        `INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source, state) VALUES (?1, ?2, ?3, ?4, ?4, 'code', ?5)
         ON CONFLICT(app_id, name) DO UPDATE SET manifest = excluded.manifest, created_at = excluded.created_at, updated_at = excluded.updated_at,
           state = CASE WHEN ?6 = 1 AND excluded.state = 'staged' AND app_tools.state = 'live' THEN 'live' ELSE excluded.state END
           WHERE app_tools.source = 'code'`,
      ).bind(appId, tool.name, JSON.stringify(tool), now, states.get(tool.name) ?? 'staged', unchanged ? 1 : 0);
    }),
    // Page meta and sitemap are part of the manifest (#210): replaced with it,
    // so they can never name an action the app no longer registers.
    db.prepare('DELETE FROM app_page_meta WHERE app_id = ?').bind(appId),
    db.prepare('DELETE FROM app_sitemap WHERE app_id = ?').bind(appId),
    // #437: what the app declares it asks the browser for, for its storefront listing.
    declaredPermissionsStatement(db, appId, permissionsResult.permissions, now),
    ...siteResult.routes.map((r, i) =>
      db.prepare(
        'INSERT INTO app_page_meta (app_id, position, path_pattern, action_name, param_name, created_at, not_found_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(appId, i, r.path, r.action, r.param, now, r.not_found ?? null),
    ),
    ...(siteResult.sitemap
      ? [db.prepare('INSERT INTO app_sitemap (app_id, action_name, created_at) VALUES (?, ?, ?)').bind(appId, siteResult.sitemap, now)]
      : []),
    // The operator gate (#229) is part of the manifest too: replaced with it.
    db.prepare('DELETE FROM app_operator_gate WHERE app_id = ?').bind(appId),
    ...(operatorResult.gate
      ? [db.prepare('INSERT INTO app_operator_gate (app_id, path_prefix, role_name, created_at) VALUES (?, ?, ?, ?)').bind(appId, operatorResult.gate.prefix, operatorResult.gate.role, now)]
      : []),
    // So is the console operator-view contract (#240): it can only name actions this manifest registers.
    db.prepare('DELETE FROM app_operator_view WHERE app_id = ?').bind(appId),
    ...(operatorView.contract
      ? [db.prepare('INSERT INTO app_operator_view (app_id, version, contract, created_at) VALUES (?, ?, ?, ?)').bind(appId, operatorView.contract.version, JSON.stringify(operatorView.contract), now)]
      : []),
    // And visibility (#259): a manifest that no longer declares it makes the app public again.
    db.prepare('DELETE FROM app_visibility WHERE app_id = ?').bind(appId),
    ...(visibilityResult.visibility
      ? [db.prepare('INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, ?, ?, ?)').bind(appId, visibilityResult.visibility.mode, JSON.stringify(visibilityResult.visibility.roles), now)]
      : []),
    // And opt-in embedding (#453): a manifest that no longer declares it closes the app to other sites again.
    db.prepare('DELETE FROM app_embed WHERE app_id = ?').bind(appId),
    ...(embedResult.embed
      ? [db.prepare('INSERT INTO app_embed (app_id, origins, created_at) VALUES (?, ?, ?)').bind(appId, JSON.stringify(embedResult.embed.allow), now)]
      : []),
    // And the worker section (#254): a manifest without it leaves the worker no secrets.
    db.prepare('DELETE FROM app_worker_manifest WHERE app_id = ?').bind(appId),
    ...(workerResult.worker
      ? [db.prepare('INSERT INTO app_worker_manifest (app_id, secrets, created_at) VALUES (?, ?, ?)').bind(appId, JSON.stringify(workerResult.worker.secrets), now)]
      : []),
    // Worker schedules (#255) are replaced with the manifest too. Their run
    // history and breaker state live in scheduled_action_runs/_state under
    // 'worker:<name>' (source 'code'), reset by the DELETE above like actions'.
    db.prepare('DELETE FROM app_worker_schedules WHERE app_id = ?').bind(appId),
    // Inbound hooks (#256), replaced with the manifest. Deliveries keep their history.
    db.prepare('DELETE FROM app_hooks WHERE app_id = ?').bind(appId),
    ...hooksResult.hooks.map((h) => {
      const { kind, secret, ...opts } = h.verify;
      return db.prepare('INSERT INTO app_hooks (app_id, name, verify_kind, secret_name, verify_opts, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(appId, h.name, kind, secret ?? null, Object.keys(opts).length ? JSON.stringify(opts) : null, JSON.stringify(h.to), now);
    }),
    // Connector declarations (#258) are replaced with the manifest; bound installations are not.
    db.prepare('DELETE FROM app_connectors WHERE app_id = ?').bind(appId),
    ...connectorsResult.connectors.map((k) =>
      db.prepare('INSERT INTO app_connectors (app_id, name, kind, modes, pat_secret, events, hook, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(appId, k.name, k.kind, JSON.stringify(k.modes), k.pat_secret, JSON.stringify(k.events), k.hook, now)),
    // Room rules (#351), replaced with the manifest: a manifest without `rooms` leaves every room open again.
    db.prepare('DELETE FROM app_room_rules WHERE app_id = ?').bind(appId),
    ...roomsResult.rules.map((r) =>
      db.prepare('INSERT INTO app_room_rules (app_id, prefix, authorize, created_at) VALUES (?, ?, ?, ?)').bind(appId, r.prefix, r.authorize, now)),
    ...(workerResult.worker?.schedules ?? []).map((sch) =>
      db.prepare('INSERT INTO app_worker_schedules (app_id, name, cron, params, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(appId, sch.name, sch.cron, JSON.stringify(sch.params), now)),
  ];
  await db.batch(stmts);
  // This isolate's remembered visibility (lib/visibility.ts) is now stale.
  forgetAppVisibility(appId);

  // Report the model-facing cost beside the count (#117). A soft warning above the
  // threshold — never a rejection: the deploy workflow prints `warnings[]` as
  // `::warning::mcp.json: …`, so the author sees the number where the deploy is.
  const cost = measureManifestCost(tools as ToolManifest[]);
  const schedules = (tools as ToolManifest[])
    .filter((tool) => tool.schedule)
    .map((tool) => ({ name: tool.name, cron: tool.schedule!.cron }));
  if (schedules.length) console.log(`[schedule] registered app=${appId} ${schedules.map((s) => `${s.name}@${s.cron}`).join(', ')}`);
  const warnings: string[] =
    cost.bytes > MANIFEST_BYTES_SOFT_LIMIT
      ? [
          `Manifest model-facing payload is ${cost.bytes} bytes (~${cost.estimatedTokens} tokens) across ${tools.length} tool(s); ` +
            'every MCP session on this app carries it in context on every call — consider slimming descriptions or adopting progressive disclosure',
        ]
      : [];
  // Count headroom (#109): a second, independent warning as the manifest nears
  // the hard cap, so the limit is announced while there is still room to plan.
  // A hook whose secret the owner has not set yet registers, but cannot verify a delivery until they do.
  const hookSecrets = [...new Set(hooksResult.hooks.map((h) => h.verify.secret).filter((n): n is string => !!n))];
  if (hookSecrets.length) {
    const present = await db.prepare('SELECT name FROM app_secrets WHERE app_id = ?').bind(appId).all<{ name: string }>()
      .then((r) => new Set((r.results ?? []).map((x) => x.name)), () => null);
    for (const name of hookSecrets) {
      if (present && !present.has(name)) warnings.push(`hooks: secret ${name} is not set yet; deliveries to the hooks that use it are refused (401) until it is`);
    }
  }
  warnings.push(...unscoped.warnings);
  const staged = [...states].filter(([, st]) => st === 'staged').map(([name]) => name);
  if (staged.length) {
    warnings.push(`${staged.length} action(s) are staged: only the app's owner and team, its worker, hooks and the scheduler can call them until the app goes live (enable its worker, or POST /v1/apps/${appId}/tools/promote)`);
  }
  for (const tool of (tools as ToolManifest[]).filter(openUnscopedWrite)) {
    warnings.push(`action "${tool.name}" is an unscoped write any signed-in user can run; if only the app's worker should, declare "callers": ["worker"]`);
  }
  if (tools.length >= TOOLS_WARN_THRESHOLD) {
    warnings.push(
      `Manifest registers ${tools.length} of ${MAX_TOOLS_PER_APP} tools (${Math.round((tools.length / MAX_TOOLS_PER_APP) * 100)}% of the per-app cap, ${MAX_TOOLS_PER_APP - tools.length} left); ` +
        'registration fails above the cap — consolidate near-duplicate actions (one list_* with optional filters instead of one per column), ' +
        'or open a platform issue with these numbers to raise the cap for this app (docs: mcp-app-tools → Budgeting for larger apps)',
    );
  }
  return {
    status: 200,
    payload: { ok: true, registered: tools.length, staged, ...cost, schedules, page_meta: siteResult.routes.length, sitemap: siteResult.sitemap !== null, permissions: permissionsResult.permissions.map((p) => p.id), operator: operatorResult.gate,
      operator_view: operatorView.contract
        ? { version: operatorView.contract.version, resources: operatorView.contract.resources.length, actions: operatorView.contract.actions.length }
        : null,
      visibility: visibilityResult.visibility ?? PUBLIC_VISIBILITY,
      worker: workerResult.worker,
      hooks: hooksResult.hooks.map((h) => ({ name: h.name, kind: h.verify.kind, to: h.to === 'worker' ? 'worker' : { action: h.to.action } })),
      connectors: connectorsResult.connectors.map((k) => ({ name: k.name, kind: k.kind, modes: k.modes })),
      rooms: roomsResult.rules.map((r) => ({ pattern: `${r.prefix}*`, authorize: r.authorize })),
      warnings },
  };
}

// ── PUT /v1/apps/:appId/tools — bulk register tools from mcp.json ──
toolsRoutes.put('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);

  const body = await c.req.json<{ tools?: ToolManifest[] } & SiteManifest>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools, c.env, siteManifestFrom(body));
  return c.json(payload, status as 200 | 400 | 422);
});

// ── POST /v1/apps/:appId/tools/internal — register tools service-to-service ──
// Called by the Agent Teams deploy stage over the PAS_BACKEND binding so
// agent-built apps register their mcp.json the same way `pas publish` does for
// CLI apps. Auth is the shared INTERNAL_TOKEN (the agent flow has no session).
// An empty/missing tools array clears the app's tools (the manifest was removed).
toolsRoutes.post('/apps/:appId/tools/internal', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const appId = c.req.param('appId')!;
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }
  const body = await c.req.json<{ tools?: ToolManifest[] } & SiteManifest>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools ?? [], c.env, siteManifestFrom(body));
  return c.json(payload, status as 200 | 400 | 422);
});

/**
 * SECURITY (#158): what an unauthenticated caller may see of a manifest —
 * everything needed to CALL a tool, never how it is implemented. The SQL is
 * the app's authorization model (docs/mcp-app-tools.md), and app repos are
 * private, so it goes only to the app's team.
 *
 * An allowlist, not a `delete m.sql` denylist: a field added to the manifest
 * later (statements, auth.caller_unscoped.reason) is private until listed here.
 */
function publicToolView(m: ToolManifest) {
  return {
    name: m.name,
    description: m.description,
    operation: m.operation,
    // The platform verifier a verify tool runs (#148) — a public module id, not app SQL.
    ...(m.verifier !== undefined ? { verifier: m.verifier } : {}),
    params: m.params,
    requires_auth: m.requires_auth,
    // Which tools stay resident on a large app's MCP session (#117) — not sensitive.
    ...(m.core !== undefined ? { core: m.core } : {}),
    // Only that one is scheduled, so MCP can hide it (#203) — never its cron or fixed params.
    ...(m.schedule !== undefined ? { scheduled: true } : {}),
    // Who may run it (#254), so MCP can hide what a user session cannot call.
    ...(m.callers !== undefined ? { callers: m.callers } : {}),
    // Lets a client or MCP host step up before calling, rather than after a refusal (#231).
    ...(m.step_up ? { step_up: true } : {}),
    ...(m.auth
      ? { auth: { required: m.auth.required, platform_roles: m.auth.platform_roles, app_roles: m.auth.app_roles } }
      : {}),
  };
}

// ── GET /v1/apps/:appId/tools — list tools for one app ──────────
//
// Public: names, descriptions, params (the MCP's per-app session calls this
// with no credential and never reads the SQL). Full manifests, SQL included,
// only for the app's team — creator, any team_members role, or a platform
// admin — which is what the console's "show SQL" sends a bearer for.
toolsRoutes.get('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  const teamMember = await requireAppAccess(c, appId, 'viewer').then(() => true, () => false);

  // `source` tells the console which rows are code (mcp.json) and which are its
  // own endpoints (#155). The console `config` column is never listed here.
  // The app's visibility (#259) rides on the same read: an app with no tools has
  // nothing to list, so the join loses nothing.
  const result = await c.env.DB.prepare(
    `SELECT t.name, t.manifest, t.updated_at, t.source, t.state, v.mode AS visibility_mode, v.roles AS visibility_roles
       FROM app_tools t LEFT JOIN app_visibility v ON v.app_id = t.app_id
      WHERE t.app_id = ? ORDER BY t.name`,
  ).bind(appId).all<{ name: string; manifest: string; updated_at: number; source: ToolSource | null; state?: string | null; visibility_mode?: string | null; visibility_roles?: string | null }>();

  // A private app's tool list is part of the app: its team and allowed roles only.
  const first = result.results?.[0];
  const visibility = visibilityFromRow(first?.visibility_mode ?? null, first?.visibility_roles ?? null);
  if (visibility.mode === 'private') {
    const caller = c.req.header('Authorization') ? await requireUser(c) : null;
    await requireVisible(c.env, appId, visibility, caller);
  }

  const tools: unknown[] = [];
  for (const r of result.results ?? []) {
    if (!teamMember && r.state === 'staged') continue;
    let manifest: ToolManifest;
    try {
      manifest = JSON.parse(r.manifest);
    } catch { continue; /* skip corrupted row */ }
    const source: ToolSource = r.source === 'console' ? 'console' : 'code';
    tools.push(
      teamMember
        // #428: staged vs live is the team's to see; everyone else is shown live actions only.
        ? { ...manifest, updated_at: r.updated_at, source, state: r.state === 'staged' ? 'staged' : 'live' }
        : { ...publicToolView(manifest), updated_at: r.updated_at, source },
    );
  }

  // The full variant is per-caller, and a private app's list is per-caller too;
  // no cache layer may hand either to anyone else.
  if (teamMember || visibility.mode === 'private') c.header('Cache-Control', 'private, no-store');
  return c.json({ tools });
});

// ── POST /v1/apps/:appId/tools/promote — staged actions go live (#428) ──
// Body `{ names?: string[] }`: those actions, or every staged one. The owner (or
// a platform admin) decides when the app's users may call what is registered;
// enabling the app worker does the same for every later deploy.
toolsRoutes.post('/apps/:appId/tools/promote', async (c) => {
  const appId = c.req.param('appId')!;
  const owner = await requireAppOwner(c, appId);
  const body = await c.req.json<{ names?: unknown }>().catch(() => ({} as { names?: unknown }));
  const names = body?.names;
  if (names !== undefined && (!Array.isArray(names) || names.length === 0 || names.length > MAX_TOOLS_PER_APP
    || !names.every((n) => typeof n === 'string' && /^[a-z][a-z0-9_]*$/.test(n)))) {
    return c.json({ error: 'names must be a non-empty array of action names' }, 400);
  }
  const list = names as string[] | undefined;
  const promoted = list
    ? await c.env.DB.prepare(
        `UPDATE app_tools SET state = 'live' WHERE app_id = ? AND source = 'code' AND state = 'staged'
           AND name IN (SELECT value FROM json_each(?)) RETURNING name`,
      ).bind(appId, JSON.stringify(list)).all<{ name: string }>()
    : await c.env.DB.prepare("UPDATE app_tools SET state = 'live' WHERE app_id = ? AND source = 'code' AND state = 'staged' RETURNING name")
      .bind(appId).all<{ name: string }>();
  const done = (promoted.results ?? []).map((r) => r.name).sort();
  // Promoting is the app going live (#429): recorded, so later deploys register live
  // even after the app's tools were cleared.
  await c.env.DB.prepare('INSERT OR IGNORE INTO app_go_live (app_id, went_live_at, went_live_by) VALUES (?, ?, ?)')
    .bind(appId, Date.now(), owner.id).run();
  const remaining = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM app_tools WHERE app_id = ? AND state = 'staged'")
    .bind(appId).first<{ n: number }>();
  console.log(`[tools] promoted app=${appId} ${done.join(',') || '(none)'}`);
  return c.json({ ok: true, promoted: done, not_staged: (list ?? []).filter((n) => !done.includes(n)).sort(), staged_remaining: remaining?.n ?? 0 });
});

// ── DELETE /v1/apps/:appId/tools — remove all tools for an app ──
toolsRoutes.delete('/apps/:appId/tools', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  // Code rows only: console endpoints are removed through the audited endpoints route (#155).
  // Page meta, sitemap, the operator gate, the operator view and the worker section go with the code manifest that declared them (#210, #229, #240, #254).
  // Visibility (#259) deliberately does not: removing an app's tools must never
  // make a private app public. Only a registration that omits it does that.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM app_tools WHERE app_id = ? AND source = 'code'").bind(appId),
    c.env.DB.prepare('DELETE FROM app_page_meta WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_sitemap WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_operator_gate WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_operator_view WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_worker_manifest WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_worker_schedules WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_hooks WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_connectors WHERE app_id = ?').bind(appId),
    c.env.DB.prepare('DELETE FROM app_room_rules WHERE app_id = ?').bind(appId),
  ]);
  return c.json({ ok: true });
});

/**
 * What still runs action `name` (#348): the stored operator_view (a resource's
 * read or detail, a row action), the app's hooks (`to.action`) and its room
 * rules (#351, `rooms[].authorize`). Deleting it
 * would leave those pointing at nothing: the console 404s, a re-registered
 * action of the same name could slip in without a role, and every verified
 * hook delivery fails while still spending the hook quota.
 */
async function toolReferences(db: D1Database, appId: string, name: string): Promise<string[]> {
  const [contract, hooks, rooms] = await Promise.all([
    loadContract(db, appId),
    db.prepare('SELECT name, target FROM app_hooks WHERE app_id = ? ORDER BY name').bind(appId).all<{ name: string; target: string }>(),
    db.prepare('SELECT prefix FROM app_room_rules WHERE app_id = ? AND authorize = ? ORDER BY prefix').bind(appId, name).all<{ prefix: string }>(),
  ]);
  const refs: string[] = [];
  for (const r of contract?.resources ?? []) {
    if (r.action === name) refs.push(`operator_view resource "${r.id}"`);
    if (r.detail?.action === name) refs.push(`operator_view resource "${r.id}" detail`);
  }
  for (const a of contract?.actions ?? []) if (a.action === name) refs.push(`operator_view action "${a.id}"`);
  for (const h of hooks.results ?? []) {
    let target: unknown;
    try { target = JSON.parse(h.target); } catch { continue; }
    if (target && typeof target === 'object' && (target as { action?: unknown }).action === name) refs.push(`hook "${h.name}"`);
  }
  // #351: a room's authorize action; without it the room would refuse everyone.
  for (const r of rooms.results ?? []) refs.push(`room pattern "${r.prefix}*"`);
  return refs;
}

// ── DELETE /v1/apps/:appId/tools/:name — remove one tool ─────────
// Refused with 409 while the operator view or a hook still uses it (#348):
// remove the reference in mcp.json and redeploy, which replaces both.
toolsRoutes.delete('/apps/:appId/tools/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  await requireAppOwner(c, appId);
  const references = await toolReferences(c.env.DB, appId, name);
  if (references.length) {
    return c.json({ error: `tool "${name}" is still used by ${references.join(', ')}; remove those references from mcp.json and redeploy first`, references }, 409);
  }
  await c.env.DB.prepare("DELETE FROM app_tools WHERE app_id = ? AND name = ? AND source = 'code'").bind(appId, name).run();
  return c.json({ ok: true });
});

// ── Admin-console authoring, read-only (#295) ───────────────────────────────
// The MCP admin-authoring tools call these: capabilities (the validator's
// kinds, limits and JSON Schema), a validate-only preview of a proposed
// operator_view (the real validateOperatorView, never a second validator), and
// an inspection of the stored contract against today's tools. None reads app
// data, so no field value can appear in a response. Owner-only, except the
// capabilities, which are the same for every app.

/** The app's registered tools (code and console), as the operator executor would load them. */
async function registeredTools(db: D1Database, appId: string): Promise<ToolManifest[]> {
  const { results } = await db.prepare('SELECT manifest FROM app_tools WHERE app_id = ? ORDER BY name').bind(appId).all<{ manifest: string }>();
  return (results ?? []).flatMap((r) => {
    try { return [JSON.parse(r.manifest) as ToolManifest]; } catch { return []; }
  });
}

toolsRoutes.get('/operator-view/capabilities', async (c) => {
  await requireUser(c);
  return c.json(operatorCapabilities());
});

toolsRoutes.get('/apps/:appId/operator-view/inspect', async (c) => {
  const appId = c.req.param('appId')!;
  refuseAppMediated(c);
  await requireAppOwner(c, appId);
  const [contract, tools, stored] = await Promise.all([
    loadContract(c.env.DB, appId),
    registeredTools(c.env.DB, appId),
    c.env.DB.prepare('SELECT created_at FROM app_operator_view WHERE app_id = ?').bind(appId).first<{ created_at: number }>(),
  ]);
  c.header('Cache-Control', 'private, no-store');
  // registered_at: when the stored contract was last registered (each deploy re-registers it), so a caller can tell a fresh deploy's.
  return c.json({ app_id: appId, registered_at: stored?.created_at ?? null, ...inspectAdminConsole(contract, tools) });
});

/**
 * Body: `{ operator_view, tools? }`. Validates `operator_view` against `tools`
 * when given — a proposed mcp.json `tools` array, checked by the same tool-set
 * validation a deploy runs — else against the app's registered tools. Nothing
 * is stored: `valid: false` with the validator's error, or the render.
 */
/** The tools a proposal is checked against: a proposed `tools` array (validated as a deploy would), else the registered ones. */
async function proposalTools(db: D1Database, appId: string, raw: unknown): Promise<{ tools: ToolManifest[] } | { error: string; details: unknown }> {
  if (raw === undefined) return { tools: await registeredTools(db, appId) };
  if (!Array.isArray(raw)) return { error: 'tools must be an array of tool manifests', details: null };
  const invalid = await validateToolSet(raw as ToolManifest[], undefined, appId);
  if (invalid) return { error: `tools: ${String(invalid.payload.error)}`, details: invalid.payload.details ?? null };
  return { tools: raw as ToolManifest[] };
}

/** The proposal body, or a 400 answer. */
async function proposalBody(c: { req: { json: <T>() => Promise<T> } }): Promise<{ operator_view: unknown; tools?: unknown; validate_against_actions?: unknown } | null> {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  return body && typeof body === 'object' && 'operator_view' in body ? body as { operator_view: unknown } : null;
}

toolsRoutes.post('/apps/:appId/operator-view/preview', async (c) => {
  const appId = c.req.param('appId')!;
  refuseAppMediated(c);
  await requireAppOwner(c, appId);
  const body = await proposalBody(c);
  if (!body) return c.json({ error: 'body must be { operator_view, tools? }' }, 400);
  const resolved = await proposalTools(c.env.DB, appId, body.tools);
  if ('error' in resolved) return c.json({ valid: false, error: resolved.error, details: resolved.details });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ app_id: appId, ...previewAdminConsole(resolved.tools, body.operator_view) });
});

/** Who holds which app roles today — anyone, and the app's creator (by id, or a GitHub creator's login alias, #272). */
async function roleContext(db: D1Database, appId: string): Promise<RoleContext> {
  const { results } = await db.prepare(
    `SELECT r.role_name, MAX(CASE WHEN r.user_id = a.creator_id OR (a.creator_id LIKE 'gh:%' AND r.user_id = u.login) THEN 1 ELSE 0 END) AS owner_holds
       FROM app_roles r JOIN apps a ON a.id = r.app_id LEFT JOIN users u ON u.id = a.creator_id
      WHERE r.app_id = ? GROUP BY r.role_name`,
  ).bind(appId).all<{ role_name: string; owner_holds: number }>();
  const rows = results ?? [];
  return { granted: new Set(rows.map((r) => r.role_name)), ownerHolds: new Set(rows.filter((r) => r.owner_holds).map((r) => r.role_name)) };
}

/**
 * #296: validate a proposal without applying it. Body `{ operator_view, tools?,
 * validate_against_actions? }`. `valid` is the backend validator's verdict, so a
 * proposal this refuses is one a deploy would refuse; errors, warnings, missing
 * requirements and security issues each carry a path.
 */
toolsRoutes.post('/apps/:appId/operator-view/propose', async (c) => {
  const appId = c.req.param('appId')!;
  refuseAppMediated(c);
  await requireAppOwner(c, appId);
  const body = await proposalBody(c);
  if (!body) return c.json({ error: 'body must be { operator_view, tools?, validate_against_actions? }' }, 400);
  const resolved = await proposalTools(c.env.DB, appId, body.tools);
  if ('error' in resolved) return c.json({ valid: false, errors: [{ path: 'tools', message: resolved.error }], details: resolved.details });
  const report = proposeAdminUpdate(resolved.tools, body.operator_view, {
    validateAgainstActions: body.validate_against_actions !== false,
    roles: await roleContext(c.env.DB, appId),
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ app_id: appId, ...report });
});

/** #296: the security and compatibility checks alone. Body `{ operator_view, tools? }`. */
toolsRoutes.post('/apps/:appId/operator-view/security', async (c) => {
  const appId = c.req.param('appId')!;
  refuseAppMediated(c);
  await requireAppOwner(c, appId);
  const body = await proposalBody(c);
  if (!body) return c.json({ error: 'body must be { operator_view, tools? }' }, 400);
  const resolved = await proposalTools(c.env.DB, appId, body.tools);
  if ('error' in resolved) return c.json({ passes_security_gates: false, issues: [{ path: 'tools', code: 'invalid_tools', severity: 'error', message: resolved.error }] });
  c.header('Cache-Control', 'private, no-store');
  return c.json({ app_id: appId, ...securityReview(resolved.tools, body.operator_view, await roleContext(c.env.DB, appId)) });
});
