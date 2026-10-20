// QA test flows + runs (#38). Flow specs are stored HERE (platform D1), never
// in app repos — automation is zero burden on product code.
//
//   GET    /v1/apps/:appId/qa/flows                    — list flows
//   PUT    /v1/apps/:appId/qa/flows/:flowId            — create/update (validated)
//   DELETE /v1/apps/:appId/qa/flows/:flowId            — delete
//   GET    /v1/apps/:appId/qa/flows/:flowId/playwright — transpiled .spec.ts (CI parity)
//   POST   /v1/apps/:appId/qa/runs                     { flowId? } — queue run(s)
//   GET    /v1/apps/:appId/qa/runs[?flowId]            — list runs (latest first)
//   POST   /v1/apps/:appId/qa/runs/:runId/report       — runner page reports results
//   GET    /v1/apps/:appId/qa/runs/:runId/artifacts     — list a run's screenshots
//   GET    /v1/apps/:appId/qa/runs/:runId/artifacts/:name — stream one screenshot (PNG)
//   POST   /v1/apps/:appId/qa/keys                     — mint a scoped QA API key (owner only)
//   DELETE /v1/apps/:appId/qa/keys/:keyId              — revoke
//
// Auth: owner bearer OR a scoped QA API key (X-QA-Key) valid for this app.
// QA keys exist so the PAGS QA agent never holds an owner session token
// (full-power + 30-day expiry). Key mint/revoke is owner-bearer only.

import { type Context, Hono } from 'hono';
import { MAX_FLOWS_PER_APP, toPlaywright, validateFlow, type TestFlow } from '@proappstore/qa-spec';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { verifyGithubOidc } from '../lib/github-oidc.js';
import { isAppRepository } from '../lib/app-deploy-oidc.js';
import { sha256Hex } from '../lib/app-tokens.js';
import { queueVerifierJob, type PagsBinding } from '../lib/pags-client.js';
import { wrap, privateNoStore } from '../lib/route-wrap.js';
import type { Env } from '../types.js';

// Same trust model as deploy-credentials (routes/deploy.ts): the VERIFIED
// GitHub OIDC claims must identify the app's authorized repository, from main.
// Lets the deploy workflow trigger post-deploy QA runs
// with no stored secret.
const OIDC_AUDIENCE = 'https://api.proappstore.online';
const OIDC_REF = 'refs/heads/main';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export const qaRoutes = new Hono<{ Bindings: Env }>();
// #378: owner-only reads are never cached.
qaRoutes.use('/apps/:appId/qa/*', privateNoStore);

type Ctx = Context<{ Bindings: Env }>;

const FLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN_TRIGGERS = new Set(['manual', 'deploy', 'cron', 'browser']);
const QA_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64urlJsonPart(part: string): Record<string, unknown> | null {
  try {
    let padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    if (pad) padded += '='.repeat(4 - pad);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function looksLikeGithubOidcToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const header = b64urlJsonPart(parts[0]!);
  const payload = b64urlJsonPart(parts[1]!);
  return header?.alg === 'RS256' && payload?.iss === GITHUB_OIDC_ISSUER;
}

/**
 * Owner bearer OR scoped QA key for this app. Returns the acting identity
 * (user id for owners, `qa-key:<prefix>` for keys) for audit columns.
 */
async function requireQaAccess(c: Ctx, appId: string): Promise<string> {
  const qaKey = c.req.header('X-QA-Key');
  if (qaKey) {
    const hash = await sha256Hex(qaKey);
    const row = await c.env.DB.prepare(
      'SELECT app_id, expires_at FROM qa_api_keys WHERE key_hash = ?1 AND app_id = ?2 AND revoked_at IS NULL',
    ).bind(hash, appId).first<{ app_id: string; expires_at: number | null }>();
    if (!row) throw new HttpError('invalid QA key for this app', 403);
    if (row.expires_at !== null && row.expires_at <= Date.now()) throw new HttpError('QA key expired', 403);
    return `qa-key:${hash.slice(0, 8)}`;
  }
  const user = await requireAppOwner(c, appId);
  return user.id;
}

/**
 * Run-triggering additionally accepts a GitHub Actions OIDC token from the
 * app's own repo (post-deploy trigger, no stored secret). Flow/key management
 * stays owner/QA-key only.
 */
async function requireRunAccess(c: Ctx, appId: string): Promise<string> {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // GitHub OIDC tokens are JWTs issued by GitHub; PAS session JWTs verify via
  // requireQaAccess below. Only verified GitHub-looking tokens use the OIDC
  // path; invalid GitHub OIDC must fail closed rather than falling through to
  // session auth.
  if (token && !c.req.header('X-QA-Key') && looksLikeGithubOidcToken(token)) {
    try {
      const claims = await verifyGithubOidc(token, { audience: OIDC_AUDIENCE });
      if (!isAppRepository(claims, appId)) {
        throw new HttpError(`repository ${claims.repository} is not authorized for app ${appId}`, 403);
      }
      if (claims.ref !== OIDC_REF) throw new HttpError('runs may only be triggered from main', 403);
      return `oidc:${claims.repository}`;
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) throw err;
      throw new HttpError(`OIDC verification failed: ${err instanceof Error ? err.message : 'unknown'}`, 401);
    }
  }
  return requireQaAccess(c, appId);
}

// ── flows ────────────────────────────────────────────────────────────────────

qaRoutes.get(
  '/apps/:appId/qa/flows',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireQaAccess(c, appId);
    const rows = await c.env.DB.prepare(
      'SELECT flow_id, name, spec, updated_by, updated_at FROM app_test_flows WHERE app_id = ?1 ORDER BY flow_id',
    ).bind(appId).all<{ flow_id: string; name: string; spec: string; updated_by: string; updated_at: number }>();
    return c.json({
      flows: rows.results.map((r) => ({ ...r, spec: JSON.parse(r.spec) as TestFlow })),
    });
  }),
);

qaRoutes.put(
  '/apps/:appId/qa/flows/:flowId',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const flowId = c.req.param('flowId')!;
    if (!FLOW_ID_RE.test(flowId)) throw new HttpError('invalid flow id', 400);
    const actor = await requireQaAccess(c, appId);

    const body = (await c.req.json().catch(() => null)) as { flow?: unknown } | null;
    const flow = body?.flow as TestFlow | undefined;
    const problem = validateFlow(flow);
    if (problem) throw new HttpError(problem, 400);
    if (flow!.id !== flowId) throw new HttpError('flow.id must match the URL flow id', 400);

    // One statement admits and writes (#364): the cap is checked inside the INSERT,
    // so concurrent creates of distinct new flows cannot all see a count under it.
    // A flow that already exists is always updatable, even at (or over) the cap.
    const written = await c.env.DB.prepare(
      `INSERT INTO app_test_flows (app_id, flow_id, name, spec, updated_by, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (SELECT COUNT(*) FROM app_test_flows WHERE app_id = ?1 AND flow_id != ?2) < ?7
           OR EXISTS (SELECT 1 FROM app_test_flows WHERE app_id = ?1 AND flow_id = ?2)
       ON CONFLICT(app_id, flow_id) DO UPDATE SET name = ?3, spec = ?4, updated_by = ?5, updated_at = ?6`,
    ).bind(appId, flowId, flow!.name, JSON.stringify(flow), actor, Date.now(), MAX_FLOWS_PER_APP).run();
    if (!written.meta.changes) {
      throw new HttpError(`an app can have at most ${MAX_FLOWS_PER_APP} flows`, 400);
    }
    return c.json({ ok: true, flowId });
  }),
);

qaRoutes.delete(
  '/apps/:appId/qa/flows/:flowId',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const flowId = c.req.param('flowId')!;
    await requireQaAccess(c, appId);
    await c.env.DB.prepare('DELETE FROM app_test_flows WHERE app_id = ?1 AND flow_id = ?2').bind(appId, flowId).run();
    return c.json({ ok: true });
  }),
);

qaRoutes.get(
  '/apps/:appId/qa/flows/:flowId/playwright',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const flowId = c.req.param('flowId')!;
    await requireQaAccess(c, appId);
    const row = await c.env.DB.prepare(
      'SELECT spec FROM app_test_flows WHERE app_id = ?1 AND flow_id = ?2',
    ).bind(appId, flowId).first<{ spec: string }>();
    if (!row) throw new HttpError('flow not found', 404);
    return c.text(toPlaywright(JSON.parse(row.spec) as TestFlow), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }),
);

// ── runs ─────────────────────────────────────────────────────────────────────

qaRoutes.post(
  '/apps/:appId/qa/runs',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireRunAccess(c, appId);
    const body = (await c.req.json().catch(() => ({}))) as { flowId?: string; trigger?: string; engine?: string };
    const trigger = body.trigger && RUN_TRIGGERS.has(body.trigger) ? body.trigger : 'manual';
    // #456: `engine: "pags"` asks the app's ProAgentStore agent (under the subscriber's
    // subscription) to run the flows in a real browser; anything else, or any failure to
    // hand it over, runs on the headless executor.
    if (body.engine !== undefined && body.engine !== 'headless' && body.engine !== 'pags') throw new HttpError('engine must be "headless" or "pags"', 400);
    const wantPags = body.engine === 'pags';
    if (wantPags && trigger === 'browser') throw new HttpError('a browser-triggered run is executed by the runner page; engine "pags" does not apply', 400);

    const flows = body.flowId
      ? await c.env.DB.prepare('SELECT flow_id, name, spec FROM app_test_flows WHERE app_id = ?1 AND flow_id = ?2').bind(appId, body.flowId).all<{ flow_id: string; name: string; spec: string }>()
      : await c.env.DB.prepare('SELECT flow_id, name, spec FROM app_test_flows WHERE app_id = ?1').bind(appId).all<{ flow_id: string; name: string; spec: string }>();
    if (flows.results.length === 0) throw new HttpError('no matching flows', 404);

    const binding = wantPags
      ? await c.env.DB.prepare('SELECT instance_id, repo, enabled FROM app_pags_bindings WHERE app_id = ?1').bind(appId).first<PagsBinding>()
      : null;
    const runs: { runId: string; flowId: string; engine: 'headless' | 'pags'; pagsJobId?: string; fallbackReason?: string }[] = [];
    for (const f of flows.results) {
      const runId = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO app_test_runs (run_id, app_id, flow_id, trigger_kind, status, started_at, engine)
         VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6)`,
      ).bind(runId, appId, f.flow_id, trigger, Date.now(), wantPags ? 'pags' : 'headless').run();
      if (!wantPags) { runs.push({ runId, flowId: f.flow_id, engine: 'headless' }); continue; }
      let spec: unknown = null;
      try { spec = JSON.parse(f.spec); } catch { /* validated on write; an unreadable one runs headlessly */ }
      const queued = spec === null
        ? ({ ok: false, reason: 'flow_unreadable' } as const)
        : await queueVerifierJob(c.env, binding, { appId, runId, flows: [{ flow_id: f.flow_id, name: f.name, spec }] });
      if (queued.ok) {
        await c.env.DB.prepare("UPDATE app_test_runs SET pags_job_id = ?2, pags_state = 'queued', last_event_at = ?3 WHERE run_id = ?1").bind(runId, queued.jobId, Date.now()).run();
        runs.push({ runId, flowId: f.flow_id, engine: 'pags', pagsJobId: queued.jobId });
      } else {
        await c.env.DB.prepare("UPDATE app_test_runs SET engine = 'headless', fallback_reason = ?2 WHERE run_id = ?1").bind(runId, queued.reason).run();
        runs.push({ runId, flowId: f.flow_id, engine: 'headless', fallbackReason: queued.reason });
      }
    }

    // Nudge the headless executor when present (browser-triggered runs are
    // executed by the runner page itself and reported back; pags runs by the agent).
    if (trigger !== 'browser' && runs.some((r) => r.engine === 'headless') && c.env.QA_WORKER) {
      c.executionCtx.waitUntil(
        c.env.QA_WORKER.fetch(`https://qa-worker.internal/execute?app=${encodeURIComponent(appId)}`, { method: 'POST' }).catch(() => {}),
      );
    }
    return c.json({ ok: true, runs });
  }),
);

qaRoutes.get(
  '/apps/:appId/qa/runs',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireQaAccess(c, appId);
    const flowId = c.req.query('flowId');
    const rows = flowId
      ? await c.env.DB.prepare(
          'SELECT * FROM app_test_runs WHERE app_id = ?1 AND flow_id = ?2 ORDER BY started_at DESC LIMIT 50',
        ).bind(appId, flowId).all()
      : await c.env.DB.prepare(
          'SELECT * FROM app_test_runs WHERE app_id = ?1 ORDER BY started_at DESC LIMIT 50',
        ).bind(appId).all();
    return c.json({ runs: rows.results });
  }),
);

// One run, in full, with what the ProAgentStore agent last reported (#456): its state
// (queued | running | needs-you | done | failed), its question when it needs a person, a
// link to its report, and why a run that asked for the agent ran headlessly instead.
qaRoutes.get(
  '/apps/:appId/qa/runs/:runId',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const runId = c.req.param('runId')!;
    await requireQaAccess(c, appId);
    const run = await c.env.DB.prepare('SELECT * FROM app_test_runs WHERE app_id = ?1 AND run_id = ?2').bind(appId, runId).first<Record<string, unknown>>();
    if (!run) throw new HttpError('run not found', 404);
    let detail: unknown = null;
    try { detail = typeof run.pags_detail === 'string' ? JSON.parse(run.pags_detail) : null; } catch { detail = null; }
    return c.json({
      run: { ...run, pags_detail: undefined },
      pags: run.engine === 'pags' || run.fallback_reason
        ? { engine: run.engine, jobId: run.pags_job_id, state: run.pags_state, lastEventAt: run.last_event_at, fallbackReason: run.fallback_reason, detail }
        : null,
    });
  }),
);

// ── run artifacts (screenshots) ────────────────────────────────────────────────
// The headless executor writes PNGs under qa/<appId>/<runId>/ in the shared
// STORAGE bucket. These list/serve them (same owner/QA-key auth as everything
// else). The run row must belong to this app — the artifact key is derived from
// the DB-stored artifacts_prefix, never from client input, so there is no path
// traversal surface.

async function runArtifactsPrefix(c: Ctx, appId: string, runId: string): Promise<string | null> {
  const row = await c.env.DB.prepare(
    'SELECT artifacts_prefix FROM app_test_runs WHERE app_id = ?1 AND run_id = ?2',
  ).bind(appId, runId).first<{ artifacts_prefix: string | null }>();
  return row?.artifacts_prefix ?? null;
}

qaRoutes.get(
  '/apps/:appId/qa/runs/:runId/artifacts',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const runId = c.req.param('runId')!;
    await requireQaAccess(c, appId);
    const prefix = await runArtifactsPrefix(c, appId, runId);
    if (!prefix) return c.json({ artifacts: [] });
    const listed = await c.env.STORAGE.list({ prefix: `${prefix}/`, limit: 100 });
    const artifacts = listed.objects
      .filter((o) => o.key.endsWith('.png'))
      .map((o) => ({ name: o.key.slice(prefix.length + 1), size: o.size, uploaded: o.uploaded.toISOString() }));
    return c.json({ artifacts });
  }),
);

qaRoutes.get(
  '/apps/:appId/qa/runs/:runId/artifacts/:name',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const runId = c.req.param('runId')!;
    const name = c.req.param('name')!;
    // Names come from R2 listing (e.g. final.png, signed-in.png); constrain to a
    // safe single filename regardless, so ':name' can never escape the prefix.
    if (!/^[a-z0-9][a-z0-9._-]{0,79}\.png$/i.test(name)) throw new HttpError('invalid artifact name', 400);
    await requireQaAccess(c, appId);
    const prefix = await runArtifactsPrefix(c, appId, runId);
    if (!prefix) throw new HttpError('run has no artifacts', 404);
    const object = await c.env.STORAGE.get(`${prefix}/${name}`);
    if (!object) throw new HttpError('artifact not found', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'private, max-age=86400');
    return new Response(object.body, { headers });
  }),
);

qaRoutes.post(
  '/apps/:appId/qa/runs/:runId/report',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const runId = c.req.param('runId')!;
    await requireQaAccess(c, appId);
    const body = (await c.req.json().catch(() => null)) as {
      status?: string;
      stepsTotal?: number;
      stepsPassed?: number;
      failedStep?: number | null;
      error?: string | null;
    } | null;
    if (!body || !['passed', 'failed', 'error', 'running'].includes(body.status ?? '')) {
      throw new HttpError('status must be running | passed | failed | error', 400);
    }
    const run = await c.env.DB.prepare(
      'SELECT trigger_kind FROM app_test_runs WHERE run_id = ?1 AND app_id = ?2',
    ).bind(runId, appId).first<{ trigger_kind: string }>();
    if (!run) throw new HttpError('run not found', 404);
    if (run.trigger_kind !== 'browser') {
      throw new HttpError('only browser-triggered runs can report through this endpoint', 409);
    }
    const done = body.status !== 'running';
    const result = await c.env.DB.prepare(
      `UPDATE app_test_runs
       SET status = ?3, steps_total = ?4, steps_passed = ?5, failed_step = ?6, error = ?7,
           finished_at = CASE WHEN ?8 THEN ?9 ELSE finished_at END
       WHERE run_id = ?1 AND app_id = ?2 AND trigger_kind = 'browser'`,
    ).bind(
      runId, appId, body.status, body.stepsTotal ?? null, body.stepsPassed ?? null,
      body.failedStep ?? null, body.error ?? null, done ? 1 : 0, Date.now(),
    ).run();
    if (result.meta.changes === 0) throw new HttpError('run not found', 404);
    return c.json({ ok: true });
  }),
);

// ── QA API keys (owner-bearer only — never key-authenticated) ────────────────

qaRoutes.post(
  '/apps/:appId/qa/keys',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const user = await requireAppOwner(c, appId);
    const key = `qak_${crypto.randomUUID().replaceAll('-', '')}`;
    const hash = await sha256Hex(key);
    const now = Date.now();
    const expiresAt = now + QA_KEY_TTL_MS;
    await c.env.DB.prepare(
      'INSERT INTO qa_api_keys (key_hash, app_id, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(hash, appId, user.id, now, expiresAt).run();
    // The key is returned ONCE; only its hash is stored.
    return c.json({ ok: true, key, keyId: hash.slice(0, 8), expiresAt });
  }),
);

qaRoutes.delete(
  '/apps/:appId/qa/keys/:keyId',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    const keyId = c.req.param('keyId')!;
    await requireAppOwner(c, appId);
    const result = await c.env.DB.prepare(
      "UPDATE qa_api_keys SET revoked_at = ?3 WHERE app_id = ?1 AND key_hash LIKE ?2 || '%' AND revoked_at IS NULL",
    ).bind(appId, keyId, Date.now()).run();
    if (result.meta.changes === 0) throw new HttpError('key not found', 404);
    return c.json({ ok: true });
  }),
);
