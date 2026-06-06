/**
 * Deterministic deploy stage (no LLM). Pushes the working tree to the app repo
 * ONCE per attempt, then verifies the CI build for that exact commit:
 *   green → done (records the verified SHA)   ·   red → back to Dev with the
 *   compiler error (or `failed` at the iteration cap).
 * Extracted from ProjectDO so the DO stays an orchestrator; the DO passes a
 * small deps object (storage + the few callbacks this needs).
 */

import type { Bindings } from './index.ts';

/** How long to wait for CI to register a run for a freshly pushed commit before
 *  declaring the deploy dead (repo missing a push-triggered workflow, Actions off). */
export const DEPLOY_CI_START_TIMEOUT_MS = 4 * 60_000;

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

  try {
    // 1) Push the working tree ONCE per deploy attempt (idempotent: creates the
    //    repo if needed). Re-checks (watchdog ticks) skip straight to polling so
    //    we don't re-commit every file each cycle. The commit SHA fingerprints
    //    this attempt and is recorded on the ticket.
    // Ensure platform-level files exist (agents don't create these).
    if (!files.has('.gitignore')) files.set('.gitignore', 'node_modules/\ndist/\n.env\n.env.local\n*.local\n.DS_Store\n');
    if (!files.has('LICENSE')) files.set('LICENSE', `MIT License\n\nCopyright (c) ${new Date().getFullYear()} ${proj.name}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`);

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

    // 3) Green → done. Record the verified commit as the ticket's final SHA.
    sql.exec("UPDATE tickets SET status = 'done', final_commit_sha = ?, updated_at = ? WHERE id = ?", sha ?? null, now, ticketId);
    deps.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'done', trigger: 'system' });
    deps.logActivity('deploy', `Deployed live ✓ ${sha?.slice(0, 7) ?? ''} ${r.url ?? ''}`.trim(), ticketId);

    // 4) Ensure the data plane (D1 + data worker + app record) once per project,
    //    so agent-built apps have a working `app.data` like CLI-published ones.
    //    Best-effort: never fails the (already-green) frontend deploy.
    await ensureDataInfra(deps, proj, ticketId);

    // 5) Register the app's MCP tools from its mcp.json (if any), so the app is
    //    callable from the platform MCP server the same way `pas publish` makes
    //    CLI apps callable. Runs after the data plane exists (tools query its
    //    D1). Best-effort — never fails the green deploy.
    await registerMcpTools(deps, proj, ticketId, files);
  } catch (e) {
    fail(`Deploy error: ${e instanceof Error ? e.message : 'unknown'}`);
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
