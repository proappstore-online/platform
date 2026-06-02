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
}

export async function runDeployStage(deps: DeployDeps, ticketId: string): Promise<void> {
  const { sql, env } = deps;
  const ticket = sql
    .exec('SELECT title, iterations, deploy_pushed_at, deploy_pushed_sha FROM tickets WHERE id = ?', ticketId)
    .toArray()[0] as { title: string; iterations: number; deploy_pushed_at: number | null; deploy_pushed_sha: string | null } | undefined;
  if (!ticket) return;
  const proj = sql
    .exec('SELECT slug, name FROM project LIMIT 1')
    .toArray()[0] as { slug: string; name: string } | undefined;
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

  const fail = (reason: string) => {
    // Route back to Dev with the error, or fail at the iteration cap. Clear the
    // push marker so the next attempt re-pushes the fixed code.
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
    let sha = ticket.deploy_pushed_sha ?? undefined;
    if (!ticket.deploy_pushed_at) {
      const pushRes = await adminFetch('/api/agent-deploy', { id: proj.slug, name: proj.name, files: Object.fromEntries(files) });
      const push = await pushRes.json() as { success?: boolean; repoUrl?: string | null; commitSha?: string; steps?: { name: string; status: string; detail: string }[] };
      if (!pushRes.ok || !push.success) {
        const detail = (push.steps ?? []).filter((s) => s.status === 'fail').map((s) => `${s.name} — ${s.detail}`).join('; ');
        return fail(`Push to repo failed: ${detail || `admin ${pushRes.status}`}`);
      }
      if (push.repoUrl) sql.exec('UPDATE project SET repo_url = ? WHERE repo_url IS NULL', push.repoUrl);
      sha = push.commitSha;
      sql.exec('UPDATE tickets SET deploy_pushed_at = ?, deploy_pushed_sha = ? WHERE id = ?', now, sha ?? null, ticketId);
      deps.logActivity('deploy', `Pushed ${files.size} file(s) @ ${sha?.slice(0, 7) ?? '?'} → building…`, ticketId);
    }

    // 2) Verify the CI build for THIS commit (waits, bounded, for it to finish).
    const statusRes = await adminFetch('/api/deploy-status', { id: proj.slug, waitMs: 85_000, ...(sha ? { sha } : {}) });
    const r = await statusRes.json() as { ok: boolean; status?: string; conclusion?: string; url?: string; errorTail?: string; error?: string };
    if (r.error) return fail(`Could not verify build: ${r.error}`);

    // CI hasn't registered a run for this commit yet. Re-check next tick — but
    // give up if it never starts (repo missing a push-triggered workflow, or
    // Actions disabled) so we don't sit in 'deploying' forever.
    if (r.status === 'pending') {
      const pushedAt = ticket.deploy_pushed_at ?? now;
      if (Date.now() - pushedAt > DEPLOY_CI_START_TIMEOUT_MS) {
        return fail('CI never started for this commit. The repo needs a push-triggered workflow under .github/workflows (and Actions enabled).');
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
  } catch (e) {
    fail(`Deploy error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}
