/**
 * Deterministic deploy stage (no LLM). Pushes the working tree to the app repo
 * ONCE per attempt, then verifies the CI build for that exact commit:
 *   green → done (records the verified SHA)   ·   red → back to Dev with the
 *   compiler error (or `failed` at the iteration cap).
 * Extracted from ProjectDO so the DO stays an orchestrator; the DO passes a
 * small deps object (storage + the few callbacks this needs).
 */

import type { Bindings } from './bindings.ts';
import { buildAppSummary } from './context-summary.ts';

/** How long to wait for CI to register a run for a freshly pushed commit before
 *  declaring the deploy dead (repo missing a push-triggered workflow, Actions off). */
export const DEPLOY_CI_START_TIMEOUT_MS = 4 * 60_000;

/** How long to wait for the provisioning Workflow to reach a terminal state
 *  before declaring the deploy dead (canary path). The workflow's own CI gate
 *  caps at ~13 min, so give it a little more headroom. */
export const WORKFLOW_DEPLOY_TIMEOUT_MS = 15 * 60_000;

/** Canary gate: route this project's deploy through the durable provisioning
 *  Workflow instead of the inline push + poll. Opt-in per slug via
 *  WORKFLOW_DEPLOY_SLUGS (comma-separated, or '*' for all). Refs #24. */
function deployViaWorkflow(env: Bindings, slug: string): boolean {
  const list = (env.WORKFLOW_DEPLOY_SLUGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(slug);
}

export interface DeployDeps {
  sql: SqlStorage;
  env: Bindings;
  broadcast(event: Record<string, unknown>): void;
  logActivity(type: string, detail: string, ticketId?: string | null, meta?: string): string;
  storeMessage(opts: { ticketId: string; author: string; body: string }): Promise<string>;
  loadFiles(): Map<string, string>;
  /** Sync the working tree from GitHub. Used to handle concurrent deploy conflicts. */
  syncFromGitHub?(reason: string): Promise<{ pulled: boolean; count?: number }>;
}

export async function runDeployStage(deps: DeployDeps, ticketId: string): Promise<void> {
  const { sql, env } = deps;
  const ticket = sql
    .exec('SELECT title, iterations, deploy_pushed_at, deploy_pushed_sha FROM tickets WHERE id = ?', ticketId)
    .toArray()[0] as { title: string; iterations: number; deploy_pushed_at: number | null; deploy_pushed_sha: string | null } | undefined;
  if (!ticket) return;
  const proj = sql
    .exec('SELECT slug, name, owner_id, data_provisioned_at FROM project LIMIT 1')
    .toArray()[0] as { slug: string; name: string; owner_id: string; data_provisioned_at: number | null } | undefined;
  if (!proj) return;
  const now = Date.now();
  const files = deps.loadFiles();

  // No deploy binding (e.g. local/dev) — can't verify; mark done with a note.
  if (!env.ADMIN || !env.INTERNAL_TOKEN || files.size === 0) {
    sql.exec("UPDATE tickets SET status = 'done', updated_at = ? WHERE id = ?", now, ticketId);
    deps.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'done', trigger: 'system' });
    deps.logActivity('deploy', files.size === 0 ? 'No files to deploy → done' : 'Deploy binding unavailable → done', ticketId);
    return;
  }

  const adminFetch = (path: string, body: unknown) => env.ADMIN!.fetch(new Request(`https://admin.proappstore.online${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN! },
    body: JSON.stringify(body),
  }));

  // Infra/provisioning failure (push rejected, CI never registered, admin
  // unreachable). Agents CAN'T fix this by editing code, so do NOT loop through
  // Dev→QA — that burns iterations + cost and QA has nothing real to verify.
  // Park the ticket in needs-input with the reason; fix the infra and press Play
  // to retry the deploy directly (resume maps a null-assignee needs-input back to
  // 'deploying'). Clears the push marker so the retry re-pushes.
  const infraFail = (reason: string) => {
    deps.storeMessage({ ticketId, author: 'system', body: `Deploy blocked — this is an infrastructure problem, not your code. Fix it and press Play to retry:\n${reason}`.slice(0, 8000) }).catch(() => {});
    sql.exec(
      "UPDATE tickets SET status = 'needs-input', assignee_role = NULL, stuck_reason = ?, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
      reason.slice(0, 500), now, ticketId,
    );
    deps.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'needs-input', trigger: 'system', reason: 'deploy-infra' });
    deps.logActivity('deploy', `Deploy BLOCKED (infra, not code) → needs-input: ${reason.slice(0, 200)}`, ticketId);
  };

  const fail = (reason: string) => {
    // CI build failed (a real code error) → route back to Dev with the error, or
    // fail at the iteration cap. Clear the push marker so the next attempt
    // re-pushes the fixed code.
    deps.storeMessage({ ticketId, author: 'system', body: `Deploy failed — fix and it will redeploy:\n${reason}`.slice(0, 8000) }).catch(() => {});
    if (ticket.iterations < 5) {
      sql.exec("UPDATE tickets SET status = 'dev-active', assignee_role = 'Dev', iterations = iterations + 1, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?", now, ticketId);
      deps.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'dev-active', trigger: 'system', reason: 'deploy-failed' });
      deps.logActivity('deploy', `Deploy FAILED → back to Dev: ${reason.slice(0, 200)}`, ticketId);
    } else {
      sql.exec("UPDATE tickets SET status = 'failed', stuck_reason = 'Deploy failed (iteration cap)', updated_at = ? WHERE id = ?", now, ticketId);
      deps.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'failed', trigger: 'system', reason: 'deploy-failed' });
      deps.logActivity('deploy', `Deploy FAILED (iteration cap) → failed: ${reason.slice(0, 200)}`, ticketId);
    }
  };

  // Canary: drive the deploy through the durable provisioning Workflow instead
  // of the inline push + poll. Reuses the same infraFail/fail routing and the
  // same green tail (finishGreenDeploy). Opt-in per slug; default off.
  if (deployViaWorkflow(env, proj.slug)) {
    const adminGet = (path: string) => env.ADMIN!.fetch(new Request(`https://admin.proappstore.online${path}`, {
      headers: { 'X-Internal-Token': env.INTERNAL_TOKEN! },
    }));
    try {
      await runDeployViaWorkflow({ deps, ticket, proj, files, ticketId, adminFetch, adminGet, infraFail, fail });
    } catch (e) {
      fail(`Deploy error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
    return;
  }

  try {
    // 1) Push the working tree ONCE per deploy attempt (idempotent: creates the
    //    repo if needed). Re-checks (watchdog ticks) skip straight to polling so
    //    we don't re-commit every file each cycle. The commit SHA fingerprints
    //    this attempt and is recorded on the ticket.
    let sha = ticket.deploy_pushed_sha ?? undefined;
    if (!ticket.deploy_pushed_at) {
      // Push with retry: if another ticket's deploy moved the branch (non-fast-forward),
      // sync from GitHub and retry once. This handles concurrent deploys gracefully.
      let pushRes = await adminFetch('/api/agent-deploy', { id: proj.slug, name: proj.name, files: Object.fromEntries(files) });
      let push = await pushRes.json() as { success?: boolean; repoUrl?: string | null; commitSha?: string; steps?: { name: string; status: string; detail: string }[] };
      if (!pushRes.ok || !push.success) {
        const detail = (push.steps ?? []).filter((s) => s.status === 'fail').map((s) => `${s.name} — ${s.detail}`).join('; ');
        // Retry on git ref conflicts (concurrent push by another ticket's deploy)
        if (detail.includes('fast forward') || detail.includes('ref update failed') || detail.includes('Reference cannot be updated')) {
          deps.logActivity('deploy', 'Push conflict (concurrent deploy) — syncing and retrying…', ticketId);
          // Sync from GitHub to get the latest commit, then retry push
          await deps.syncFromGitHub?.('deploy-retry').catch(() => {});
          // Reload files after sync (they may have been updated by the other deploy)
          const freshFiles = deps.loadFiles();
          pushRes = await adminFetch('/api/agent-deploy', { id: proj.slug, name: proj.name, files: Object.fromEntries(freshFiles) });
          push = await pushRes.json() as typeof push;
          if (!pushRes.ok || !push.success) {
            const retryDetail = (push.steps ?? []).filter((s) => s.status === 'fail').map((s) => `${s.name} — ${s.detail}`).join('; ');
            return infraFail(`Push to repo failed (after retry): ${retryDetail || `admin ${pushRes.status}`}`);
          }
        } else {
          return infraFail(`Push to repo failed: ${detail || `admin ${pushRes.status}`}`);
        }
      }
      if (push.repoUrl) sql.exec('UPDATE project SET repo_url = ? WHERE repo_url IS NULL', push.repoUrl);
      sha = push.commitSha;
      sql.exec('UPDATE tickets SET deploy_pushed_at = ?, deploy_pushed_sha = ? WHERE id = ?', now, sha ?? null, ticketId);
      deps.logActivity('deploy', `Pushed ${files.size} file(s) @ ${sha?.slice(0, 7) ?? '?'} → building…`, ticketId);
    }

    // 2) Verify the CI build for THIS commit (waits, bounded, for it to finish).
    const statusRes = await adminFetch('/api/deploy-status', { id: proj.slug, waitMs: 85_000, ...(sha ? { sha } : {}) });
    const r = await statusRes.json() as { ok: boolean; status?: string; conclusion?: string; url?: string; errorTail?: string; error?: string };
    if (r.error) return infraFail(`Could not verify build: ${r.error}`);

    // CI hasn't registered a run for this commit yet. Re-check next tick — but
    // give up if it never starts (repo missing a push-triggered workflow, or
    // Actions disabled) so we don't sit in 'deploying' forever.
    if (r.status === 'pending') {
      const pushedAt = ticket.deploy_pushed_at ?? now;
      if (Date.now() - pushedAt > DEPLOY_CI_START_TIMEOUT_MS) {
        return infraFail('CI never started for this commit. The repo needs a push-triggered workflow under .github/workflows, Actions enabled, and the admin GitHub token must have the `workflow` scope to commit it.');
      }
      deps.logActivity('deploy', 'Waiting for CI to start — will re-check', ticketId);
      return;
    }
    if (r.status !== 'completed') {
      // Build still running past our wait — stay in deploying; watchdog re-checks
      // (and now only polls, no re-push).
      deps.logActivity('deploy', `Build still running — will re-check`, ticketId);
      return;
    }
    if (!r.ok) return fail(`CI build ${r.conclusion}:\n${r.errorTail ?? r.url ?? ''}`);

    // 3) Green → done + post-deploy steps (shared with the workflow canary path).
    await finishGreenDeploy(deps, proj, ticketId, sha, files, r.url);
  } catch (e) {
    fail(`Deploy error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

/**
 * Args for the canary deploy path. Mirrors what runDeployStage already computed
 * (ticket row, project, working tree) plus the admin fetchers and the shared
 * infraFail/fail routing closures.
 */
export interface WorkflowDeployArgs {
  deps: DeployDeps;
  ticket: { iterations: number; deploy_pushed_at: number | null; deploy_pushed_sha: string | null };
  proj: { slug: string; name: string; owner_id: string; data_provisioned_at: number | null };
  files: Map<string, string>;
  ticketId: string;
  adminFetch: (path: string, body: unknown) => Promise<Response>;
  adminGet: (path: string) => Promise<Response>;
  infraFail: (reason: string) => void;
  fail: (reason: string) => void;
}

/**
 * Canary deploy: start the durable provisioning Workflow once, then poll it to a
 * terminal state across watchdog ticks. The workflow does repo + r2 + analytics +
 * push + the CI-green gate itself; we just map its outcome onto the ticket and
 * run the same post-deploy tail on green.
 *
 * The workflow's auto-generated instance id is parked in `deploy_pushed_sha`
 * (the canary path pushes INSIDE the workflow, so that column isn't holding a
 * git sha here). infraFail/fail clear it, so a retry starts a fresh instance.
 */
export async function runDeployViaWorkflow(a: WorkflowDeployArgs): Promise<void> {
  const { deps, ticket, proj, files, ticketId, adminFetch, adminGet, infraFail, fail } = a;
  const { sql } = deps;
  const now = Date.now();

  // 1) Start the workflow ONCE per attempt (watchdog re-ticks skip to polling).
  let instanceId = ticket.deploy_pushed_sha ?? undefined;
  if (!ticket.deploy_pushed_at) {
    const res = await adminFetch('/api/provision-workflow/agent', {
      id: proj.slug, name: proj.name, files: Object.fromEntries(files),
    });
    const body = await res.json().catch(() => ({})) as { id?: string; error?: string };
    if (!res.ok || !body.id) {
      return infraFail(`Could not start deploy workflow: ${body.error || `admin ${res.status}`}`);
    }
    instanceId = body.id;
    sql.exec('UPDATE tickets SET deploy_pushed_at = ?, deploy_pushed_sha = ? WHERE id = ?', now, instanceId, ticketId);
    deps.logActivity('deploy', `Deploy workflow started (${instanceId.slice(0, 8)}) — provisioning + building…`, ticketId);
    return; // poll on the next tick
  }
  if (!instanceId) return infraFail('Deploy workflow id missing — will restart the deploy.');

  // 2) Poll the instance to a terminal state.
  const res = await adminGet(`/api/provision-workflow/status?id=${encodeURIComponent(instanceId)}`);
  const startedAt = ticket.deploy_pushed_at ?? now;
  if (!res.ok) {
    // Transient status-read failure — re-check next tick, bounded by the timeout.
    if (Date.now() - startedAt > WORKFLOW_DEPLOY_TIMEOUT_MS) {
      return infraFail(`Deploy workflow status unreadable (admin ${res.status}).`);
    }
    return;
  }
  const j = await res.json().catch(() => ({})) as {
    status?: { status?: string; error?: string | { message?: string }; output?: { commitSha?: string; repoUrl?: string } };
  };
  const st = j.status?.status;

  if (st === 'complete') {
    const out = j.status?.output ?? {};
    if (out.repoUrl) sql.exec('UPDATE project SET repo_url = ? WHERE repo_url IS NULL', out.repoUrl);
    await finishGreenDeploy(deps, proj, ticketId, out.commitSha, files, out.repoUrl);
    return;
  }
  if (st === 'errored' || st === 'terminated') {
    const e = j.status?.error;
    const msg = (typeof e === 'string' ? e : e?.message) ?? 'unknown error';
    // A CI-gate failure is a CODE error → back to Dev with the compiler output.
    // Anything else (repo create, push, infra) the agent can't fix → needs-input.
    if (msg.startsWith('CI gate:')) return fail(msg);
    return infraFail(`Deploy workflow failed: ${msg}`);
  }

  // queued / running / waiting / paused → still going; re-check, bounded.
  if (Date.now() - startedAt > WORKFLOW_DEPLOY_TIMEOUT_MS) {
    return infraFail('Deploy workflow did not reach a terminal state in time.');
  }
  deps.logActivity('deploy', `Deploy workflow ${st ?? 'running'} — will re-check`, ticketId);
}

/**
 * The shared "green deploy" tail: mark the ticket done, then run the best-effort
 * post-deploy steps (context summary, CI test harvest, data plane, MCP tools).
 * Used by both the inline path and the workflow canary path.
 */
async function finishGreenDeploy(
  deps: DeployDeps,
  proj: { slug: string; owner_id: string; data_provisioned_at: number | null },
  ticketId: string,
  sha: string | undefined,
  files: Map<string, string>,
  url?: string,
): Promise<void> {
  const { sql } = deps;
  sql.exec("UPDATE tickets SET status = 'done', final_commit_sha = ?, updated_at = ? WHERE id = ?", sha ?? null, Date.now(), ticketId);
  deps.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'done', trigger: 'system' });
  deps.logActivity('deploy', `Deployed live ✓ ${sha?.slice(0, 7) ?? ''} ${url ?? ''}`.trim(), ticketId);

  // Build + cache the deterministic app context summary so Dev/QA agents can
  // skip re-reading files on subsequent tickets.
  try {
    const summary = buildAppSummary(files);
    if (summary) sql.exec('UPDATE project SET app_context_summary = ? WHERE slug = ?', summary, proj.slug);
  } catch { /* best-effort */ }

  // Harvest CI test results, ensure the data plane, register MCP tools. All
  // best-effort: never fail an already-green deploy.
  await harvestTestResults(deps, proj, ticketId, sha);
  await ensureDataInfra(deps, proj, ticketId);
  await registerMcpTools(deps, proj, ticketId, files);
}

/**
 * Harvest CI test results from the KB host into the DO's test_runs/test_results
 * tables so the console Test tab has data. After a green CI build, the workflow
 * publishes a summary.json to R2; we fetch it and INSERT into the DO's SQLite.
 *
 * NOTE: summary.json may contain results from a PREVIOUS deploy because the e2e
 * job runs after the deploy job. This is expected — the dedup check below prevents
 * double-ingestion, and the next deploy will pick up the current results. The
 * primary ingest path is the e2e job POSTing directly to /test-history.
 *
 * Best-effort: failures are logged and silently ignored.
 */
async function harvestTestResults(
  deps: DeployDeps,
  proj: { slug: string },
  ticketId: string,
  sha: string | undefined,
): Promise<void> {
  try {
    const res = await fetch(`https://kb.proappstore.online/${proj.slug}/.e2e/summary.json`);
    if (!res.ok) return; // no summary published (e.g. no e2e tests yet)

    const summary = await res.json() as {
      passed?: number; failed?: number; skipped?: number; flaky?: number;
      ok?: boolean; durationMs?: number;
      specs?: { title: string; ok: boolean; durationMs?: number; error?: string }[];
    };

    const { sql } = deps;

    // Deduplicate: skip if we already have a recent run for this commit SHA
    // (the same summary.json is served until the next test run overwrites it).
    // When sha is undefined, dedup against the most recent run's timestamp
    // to prevent duplicates on repeated watchdog ticks.
    if (sha) {
      const existing = sql.exec('SELECT id FROM test_runs WHERE commit_sha = ? LIMIT 1', sha).toArray();
      if (existing.length > 0) return;
    } else {
      const recent = sql.exec('SELECT triggered_at FROM test_runs ORDER BY triggered_at DESC LIMIT 1').toArray() as { triggered_at: number }[];
      if (recent.length > 0 && Date.now() - recent[0]!.triggered_at < 60_000) return;
    }

    const runId = crypto.randomUUID();
    const passed = summary.passed ?? 0;
    const failed = summary.failed ?? 0;
    const status = summary.ok !== false && failed === 0 ? 'passed' : 'failed';

    sql.exec(
      `INSERT OR REPLACE INTO test_runs (id, triggered_at, source, commit_sha, status, passed, failed, skipped, flaky, duration_ms, coverage_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId, Date.now(), 'ci', sha ?? null, status,
      passed, failed, summary.skipped ?? 0, summary.flaky ?? 0,
      summary.durationMs ?? null, null,
    );

    if (summary.specs) {
      for (const spec of summary.specs.slice(0, 500)) {
        sql.exec(
          'INSERT INTO test_results (id, run_id, spec_file, test_name, status, duration_ms, error_text) VALUES (?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), runId,
          spec.title.slice(0, 500), spec.title.slice(0, 500),
          spec.ok ? 'pass' : 'fail',
          spec.durationMs ?? null, spec.error ? spec.error.slice(0, 5000) : null,
        );
      }
    }

    deps.logActivity('test', `Test results harvested: ${passed} passed, ${failed} failed`, ticketId);
  } catch {
    // Best-effort — never fails a green deploy
  }
}

/**
 * Provision the app's data plane via the PAS backend's internal endpoint, ONCE
 * per project (gated by `project.data_provisioned_at`). Runs after a green
 * frontend deploy; failures are logged and retried on the next deploy rather
 * than blocking the deploy. Mirrors what `pas publish` → /v1/provision does for
 * CLI apps, so both paths yield the same data layer.
 */
async function ensureDataInfra(
  deps: DeployDeps,
  proj: { slug: string; owner_id: string; data_provisioned_at: number | null },
  ticketId: string,
): Promise<void> {
  const { sql, env } = deps;
  if (proj.data_provisioned_at) return; // already provisioned
  if (!env.PAS_BACKEND || !env.INTERNAL_TOKEN) return; // no backend binding (dev)
  try {
    const res = await env.PAS_BACKEND.fetch(new Request('https://api.proappstore.online/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN },
      body: JSON.stringify({ appId: proj.slug, creatorId: proj.owner_id }),
    }));
    const r = await res.json() as { success?: boolean; dataWorkerUrl?: string; steps?: { name: string; status: string; detail: string }[] };
    if (res.ok && r.success) {
      sql.exec('UPDATE project SET data_provisioned_at = ? WHERE slug = ?', Date.now(), proj.slug);
      deps.logActivity('deploy', `Data layer ready (D1 + data worker)${r.dataWorkerUrl ? ` → ${r.dataWorkerUrl}` : ''}`, ticketId);
    } else {
      const detail = (r.steps ?? []).filter((s) => s.status === 'fail').map((s) => `${s.name} — ${s.detail}`).join('; ');
      deps.logActivity('deploy', `Data layer not ready (will retry next deploy): ${detail || `backend ${res.status}`}`, ticketId);
    }
  } catch (e) {
    deps.logActivity('deploy', `Data layer provisioning error (will retry next deploy): ${e instanceof Error ? e.message : 'unknown'}`, ticketId);
  }
}

/**
 * Register the app's MCP tool manifest (`mcp.json` at the repo root) with the
 * platform backend so the app's tools show up on the platform MCP server
 * (`mcp.proappstore.online/mcp`) as `<app>/<tool>`. This is what makes an
 * agent-built app callable by an external Claude — the same registration the
 * CLI's `pas publish` does. Re-runs every green deploy (cheap DELETE+INSERT) so
 * the registered tools stay in sync with the shipped manifest. No-op (and no
 * network call) when the app ships no `mcp.json`. Best-effort.
 */
async function registerMcpTools(
  deps: DeployDeps,
  proj: { slug: string },
  ticketId: string,
  files: Map<string, string>,
): Promise<void> {
  const { env } = deps;
  const raw = files.get('mcp.json');
  if (!raw) return; // app declares no tools — nothing to register
  if (!env.PAS_BACKEND || !env.INTERNAL_TOKEN) return; // no backend binding (dev)

  let tools: unknown;
  try {
    const parsed = JSON.parse(raw) as { tools?: unknown };
    tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  } catch {
    deps.logActivity('deploy', 'mcp.json is not valid JSON — skipped tool registration', ticketId);
    return;
  }
  if (!Array.isArray(tools) || tools.length === 0) return;

  try {
    const res = await env.PAS_BACKEND.fetch(new Request(`https://api.proappstore.online/v1/apps/${proj.slug}/tools/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN },
      body: JSON.stringify({ tools }),
    }));
    const r = await res.json().catch(() => ({})) as { registered?: number; error?: string };
    if (res.ok) {
      deps.logActivity('deploy', `MCP tools registered: ${r.registered ?? 0} tool(s) → callable at mcp.proappstore.online`, ticketId);
    } else {
      deps.logActivity('deploy', `MCP tools not registered (will retry next deploy): ${r.error ?? `backend ${res.status}`}`, ticketId);
    }
  } catch (e) {
    deps.logActivity('deploy', `MCP tool registration error (will retry next deploy): ${e instanceof Error ? e.message : 'unknown'}`, ticketId);
  }
}
