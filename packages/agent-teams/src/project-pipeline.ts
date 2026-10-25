import type { ProjectHost } from './project-host.ts';
import type { BaSpec, Role, TicketStatus } from './types.ts';
import { assigneeForStatus, isTerminal, baVerdict } from './ticket-machine.ts';
import { json, rowToTicket, insertChatMessage } from './store.ts';
import { runDeployStage, MAX_DEPLOY_ATTEMPTS, DEPLOY_RETRY_BACKOFF_MS } from './deploy-stage.ts';
import { runAgentTurn } from './agent-runner.ts';
import { loadFiles, saveFiles, recallMemory } from './project-store.ts';
import { syncFromGitHub, makeDispatch } from './project-workspace.ts';
import { storeMessage } from './project-messages.ts';

/**
 * Watchdog interval. While a project is running, an alarm fires on this cadence
 * to drive the pipeline forward even if the in-process run chain stalls or the
 * DO was evicted between runs. It also re-dispatches active tickets whose
 * in-memory run flag was lost on hibernation.
 */
const WATCHDOG_MS = 60_000;

export function setPlayState(h: ProjectHost, newStatus: 'running' | 'paused'): Response {
  const now = Date.now();
  h.state.storage.sql.exec('UPDATE project SET status = ?', newStatus);

  if (newStatus === 'running') {
    // Record when we started running (for idle timeout). The column is created
    // by a migration (store.ts), so no lazy ALTER needed.
    h.state.storage.sql.exec('UPDATE project SET last_user_activity = ?', now);

    // Retry tickets parked in needs-input. They were blocked on a system
    // condition (missing API key, a prior error) — Play means "go", so
    // re-dispatch them rather than leaving them stuck (needs-input otherwise
    // only resumes via a chat reply).
    const blocked = h.state.storage.sql
      .exec("SELECT id, assignee_role FROM tickets WHERE status = 'needs-input'")
      .toArray() as { id: string; assignee_role: string | null }[];
    for (const t of blocked) {
      // null assignee means a deploy-infra block (deploy-stage.infraFail) →
      // retry the deploy directly, not Dev/BA.
      const resume = t.assignee_role === 'QA' ? 'qa-active'
        : t.assignee_role === 'Dev' ? 'dev-active'
        : t.assignee_role === 'BA' ? 'ba-refining'
        : 'deploying';
      h.state.storage.sql.exec('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', resume, now, t.id);
      // Explicit Play = "I fixed the infra" → reset the self-heal retry budget so a
      // ticket that had exhausted its auto-retries gets a fresh set.
      if (resume === 'deploying') h.state.storage.sql.exec('UPDATE tickets SET deploy_attempts = 0 WHERE id = ?', t.id);
      h.logActivity('control', `Retrying blocked ${t.assignee_role ?? 'deploy'} ticket`, t.id);
      h.broadcast({ type: 'transition', ticketId: t.id, from: 'needs-input', to: resume, reason: 'retry-on-play' });
    }
  }

  h.broadcast({ type: 'play-state', status: newStatus });
  h.logActivity('control', newStatus === 'running' ? 'Agents started' : 'Agents paused');

  if (newStatus === 'running') {
    scheduleWatchdog(h);
    autoAdvance(h);
    // If there's no work yet, tell the user (in chat AND the activity feed).
    const open = (h.state.storage.sql
      .exec("SELECT COUNT(*) AS c FROM tickets WHERE status NOT IN ('done','failed','cancelled')")
      .toArray()[0] as { c: number }).c;
    if (open === 0) {
      const msg = "Agents are on. There's no work yet — tell me what to build in the chat and I'll create tickets and get the team going.";
      const msgId = insertChatMessage(h.state.storage.sql, { role: 'po', body: msg, at: now });
      h.broadcast({ type: 'chat', role: 'po', body: msg, id: msgId });
      h.logActivity('info', 'No open tickets — describe what to build in the chat.');
    }
  } else {
    clearWatchdog(h);
  }

  return json({ status: newStatus });
}

export function scheduleWatchdog(h: ProjectHost): void {
  try { h.state.storage.setAlarm(Date.now() + WATCHDOG_MS); } catch { /* unavailable in some test envs */ }
}

export function clearWatchdog(h: ProjectHost): void {
  try { h.state.storage.deleteAlarm(); } catch { /* unavailable */ }
}

/** Record user activity timestamp (for idle timeout) */
export function touchUserActivity(h: ProjectHost): void {
  try {
    h.state.storage.sql.exec('UPDATE project SET last_user_activity = ?', Date.now());
  } catch { /* column may not exist yet */ }
}

export function reconcileStuck(h: ProjectHost, now: number): boolean {
  const parked = h.state.storage.sql
    .exec("SELECT id, deploy_attempts, updated_at FROM tickets WHERE status = 'needs-input' AND assignee_role IS NULL AND stuck_reason IS NOT NULL")
    .toArray() as { id: string; deploy_attempts: number | null; updated_at: number }[];
  let pending = false;
  for (const t of parked) {
    const attempts = t.deploy_attempts ?? 0;
    if (attempts >= MAX_DEPLOY_ATTEMPTS) continue; // budget spent → escalated to the human
    pending = true;
    const backoff = DEPLOY_RETRY_BACKOFF_MS[Math.min(attempts - 1, DEPLOY_RETRY_BACKOFF_MS.length - 1)] ?? 120_000;
    if (now - t.updated_at < backoff) continue; // still waiting out the backoff
    h.state.storage.sql.exec("UPDATE tickets SET status = 'deploying', updated_at = ? WHERE id = ?", now, t.id);
    h.logActivity('control', `Self-heal: re-checking stuck deploy (retry ${attempts + 1}/${MAX_DEPLOY_ATTEMPTS})`, t.id);
    h.broadcast({ type: 'transition', ticketId: t.id, from: 'needs-input', to: 'deploying', reason: 'self-heal' });
  }
  return pending;
}

export function autoAdvance(h: ProjectHost): void {
  const proj = h.state.storage.sql
    .exec("SELECT status, last_user_activity, cost_cap_monthly_usd, cost_spent_monthly_usd, cost_month FROM project LIMIT 1")
    .toArray()[0] as { status: string; last_user_activity: number; cost_cap_monthly_usd: number; cost_spent_monthly_usd: number; cost_month: string } | undefined;
  if (!proj || proj.status !== 'running') return;

  const now = Date.now();

  // Self-heal: re-check deploy-parked tickets against CURRENT infra state and
  // auto-resume those whose blocker may have cleared (bounded retry + backoff),
  // escalating to the human only when the budget is spent. Returns true while any
  // parked ticket still has retry budget — we keep the watchdog alive for those
  // instead of idle-pausing, so recoverable work isn't stranded behind a manual Play.
  const pendingSelfHeal = reconcileStuck(h, now);

  // Idle timeout: auto-pause after 30 min of no activity. "Activity" must
  // include an in-flight agent run — otherwise a single long run (maxRunMinutes
  // can be up to 60) trips the 30-min idle check mid-run and strands its next
  // step (e.g. QA after a long Dev) until manual Play, even with the user
  // watching. Only pause when the pipeline is genuinely idle (nothing running,
  // no pending self-heal retries); runaway spend is still bounded by the cap below.
  const lastActivity = (proj.last_user_activity as number | null) ?? 0;
  const idleMs = lastActivity > 0 ? now - lastActivity : 0;
  if (lastActivity > 0 && idleMs > 30 * 60 * 1000 && h.running.size === 0 && !pendingSelfHeal) {
    h.state.storage.sql.exec("UPDATE project SET status = 'paused'");
    clearWatchdog(h);
    h.broadcast({ type: 'play-state', status: 'paused', reason: 'idle-timeout' });
    const idleMsg = 'Auto-paused: no activity for 30 minutes. Hit Play to resume.';
    const idleId = insertChatMessage(h.state.storage.sql, { role: 'system', body: idleMsg, at: now });
    h.broadcast({ type: 'chat', role: 'system', body: idleMsg, id: idleId });
    h.logActivity('control', 'Auto-paused (idle 30 min)');
    return;
  }

  // Cost cap check — spend only counts for the current month. A project that
  // capped last month must not stay paused into a new month (storeMessage
  // resets the counter on the first new-month event, but the cap gate runs
  // before any spend, so compute the effective current-month total here).
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthlySpent = proj.cost_month === currentMonth ? proj.cost_spent_monthly_usd : 0;
  if (monthlySpent >= proj.cost_cap_monthly_usd) {
    h.state.storage.sql.exec("UPDATE project SET status = 'paused'");
    clearWatchdog(h);
    h.broadcast({ type: 'play-state', status: 'paused', reason: 'cost-cap' });
    h.logActivity('control', `Auto-paused: monthly cost cap reached ($${proj.cost_cap_monthly_usd})`);
    return;
  }

  // Run any already-active agents first (they're mid-flight — don't block them).
  runPendingAgents(h);

  // Advance to a fixpoint (#2): one pass moves each ticket ONE step, but some
  // steps chain without an agent in between — awaiting-approval auto-approves
  // to ready, and ready must become dev-active before a Dev run can start.
  // Left at one pass, that hand-off waited for the next watchdog alarm (up
  // to a minute) or a user action. Bounded, so a bug can never spin here.
  for (let pass = 0; pass < 4; pass++) {
    if (!advanceOnce(h, now)) break;
  }

  // Kick off agent runs for any tickets now sitting in an active state.
  runPendingAgents(h);
}

/** One pass over the movable tickets. Returns true when anything moved. */
export function advanceOnce(h: ProjectHost, now: number): boolean {
  let moved = false;
  const tickets = h.state.storage.sql
    .exec("SELECT id, status, iterations FROM tickets WHERE status NOT IN ('done','failed','cancelled','needs-input','ba-refining','dev-active','qa-active') ORDER BY created_at")
    .toArray() as { id: string; status: string; iterations: number }[];

  for (const t of tickets) {
    // Re-query active count each iteration to prevent race condition
    const activeCount = (h.state.storage.sql
      .exec("SELECT COUNT(*) as c FROM tickets WHERE status IN ('ba-refining','dev-active','qa-active')")
      .toArray()[0] as { c: number }).c;

    // Don't exceed max concurrent active tickets
    if (activeCount >= 3 && (t.status === 'inbox' || t.status === 'ready' || t.status === 'qa-failed')) {
      break;
    }

    switch (t.status) {
      case 'inbox':
        h.state.storage.sql.exec(
          "UPDATE tickets SET status = 'ba-refining', assignee_role = 'BA', updated_at = ? WHERE id = ?",
          now, t.id,
        );
        h.broadcast({ type: 'transition', ticketId: t.id, from: 'inbox', to: 'ba-refining', auto: true });
        moved = true;
        break;

      case 'awaiting-approval':
        // Auto-approve (PO agent trusts BA — user can reject via chat)
        h.state.storage.sql.exec(
          "UPDATE tickets SET status = 'ready', assignee_role = NULL, updated_at = ? WHERE id = ?",
          now, t.id,
        );
        h.broadcast({ type: 'transition', ticketId: t.id, from: 'awaiting-approval', to: 'ready', auto: true });
        moved = true;
        break;

      case 'ready':
        h.state.storage.sql.exec(
          "UPDATE tickets SET status = 'dev-active', assignee_role = 'Dev', updated_at = ? WHERE id = ?",
          now, t.id,
        );
        h.broadcast({ type: 'transition', ticketId: t.id, from: 'ready', to: 'dev-active', auto: true });
        moved = true;
        break;

      case 'qa-failed':
        if (t.iterations < 5) {
          h.state.storage.sql.exec(
            "UPDATE tickets SET status = 'dev-active', assignee_role = 'Dev', iterations = iterations + 1, updated_at = ? WHERE id = ?",
            now, t.id,
          );
          h.broadcast({ type: 'transition', ticketId: t.id, from: 'qa-failed', to: 'dev-active', auto: true });
          moved = true;
        } else {
          h.state.storage.sql.exec(
            "UPDATE tickets SET status = 'failed', stuck_reason = 'Iteration cap reached (5)', updated_at = ? WHERE id = ?",
            now, t.id,
          );
          h.broadcast({ type: 'transition', ticketId: t.id, from: 'qa-failed', to: 'failed', auto: true });
          moved = true;
        }
        break;
    }
  }
  return moved;
}

function runPendingAgents(h: ProjectHost): void {
  const proj = h.state.storage.sql
    .exec('SELECT status FROM project LIMIT 1')
    .toArray()[0] as { status: string } | undefined;
  if (!proj || proj.status !== 'running') return;

  const active = h.state.storage.sql
    .exec("SELECT id FROM tickets WHERE status IN ('ba-refining','dev-active','qa-active') ORDER BY updated_at")
    .toArray() as { id: string }[];

  // SERIALIZE agent runs. Every run does loadFiles → LLM → saveFiles, and
  // saveFiles rewrites the WHOLE shared project_files tree (DELETE + re-INSERT).
  // Two concurrent runs each load a snapshot, then the later save clobbers the
  // earlier run's writes → silent code loss. This is the same shared-tree
  // hazard the deploy stage below is serialized for. Dispatch ONE run at a
  // time; dispatchRun's finally re-enters autoAdvance → runPendingAgents, so
  // the next active ticket is picked up as soon as this one settles.
  if (!active.some((t) => h.running.has(t.id))) {
    const next = active.find((t) => !h.running.has(t.id));
    if (next) dispatchRun(h, next.id);
  }

  // Deterministic deploy stage (no LLM): push + verify the CI build, then route
  // done | back-to-dev. "done" is only reachable through a verified green build.
  // SERIALIZE deploys: every ticket pushes to the SAME repo branch, so concurrent
  // deploys race (ref non-fast-forward) and deploy.yml's `cancel-in-progress`
  // cancels the losers' CI runs — stranding those tickets even though the app
  // deployed fine. Dispatch ONE deploy at a time; the next tick picks up the next.
  const deploying = h.state.storage.sql
    .exec("SELECT id FROM tickets WHERE status = 'deploying' ORDER BY updated_at")
    .toArray() as { id: string }[];
  if (!deploying.some((t) => h.running.has(t.id))) {
    const next = deploying.find((t) => !h.running.has(t.id));
    if (next) dispatchDeploy(h, next.id);
  }
}

/** One agent turn — see agent-runner.ts. The DO supplies storage + callbacks. */
function runAgentInternal(h: ProjectHost, ticketId: string): Promise<void> {
  return runAgentTurn({
    sql: h.state.storage.sql,
    env: h.env,
    broadcast: (e) => h.broadcast(e),
    logActivity: (type, detail, tid, meta) => h.logActivity(type, detail, tid, meta),
    setActivityMeta: (id, meta) => h.setActivityMeta(id, meta),
    syncFromGitHub: (reason) => syncFromGitHub(h, reason),
    loadFiles: () => loadFiles(h.state.storage.sql),
    saveFiles: (files) => saveFiles(h.state.storage.sql, files),
    recallMemory: () => recallMemory(h.state.storage.sql),
    storeMessage: (opts) => storeMessage(h, opts),
    makeDispatch: (files) => makeDispatch(h, files),
    failTicket: (tid, from, reason) => failTicket(h, tid, from, reason),
    blockForInput: (tid, role, message) => blockForInput(h, tid, role, message),
    applyAgentOutcome: (tid, role, output) => applyAgentOutcome(h, tid, role, output),
  }, ticketId);
}

function dispatchRun(h: ProjectHost, ticketId: string): void {
  const startingStatus = (h.state.storage.sql
    .exec('SELECT status FROM tickets WHERE id = ?', ticketId)
    .toArray()[0] as { status: TicketStatus } | undefined)?.status;
  const startingRole = startingStatus ? assigneeForStatus(startingStatus) : null;
  let runError: string | undefined;

  h.running.add(ticketId);
  // Fire-and-forget. The DO stays alive while the promise has pending I/O; the
  // alarm watchdog re-dispatches active tickets if the DO is ever evicted
  // mid-run (so we don't rely on a waitUntil, which DO state doesn't have).
  void runAgentInternal(h, ticketId)
    .catch((e) => {
      // Surface any uncaught run crash — full transparency, never silent.
      const msg = e instanceof Error ? e.message : String(e);
      runError = msg;
      try {
        h.logActivity('error', `Run crashed: ${msg}`, ticketId);
        blockForInput(h, ticketId, assigneeForStatus(
          (h.state.storage.sql.exec('SELECT status FROM tickets WHERE id = ?', ticketId).toArray()[0] as { status: TicketStatus } | undefined)?.status ?? 'inbox',
        ) ?? 'BA', `Run crashed: ${msg}`);
      } catch { /* last-resort: don't throw from the error handler */ }
    })
    .finally(() => {
      h.running.delete(ticketId);
      if (startingRole) {
        h.broadcast({ type: 'agent-run-ended', ticketId, role: startingRole, ...(runError ? { error: runError } : {}) });
      }
      // A completed run is pipeline progress — reset the idle timer so a long
      // autonomous build (no user chat) isn't auto-paused mid-flight.
      touchUserActivity(h);
      try { autoAdvance(h); } catch { /* keep the watchdog as backstop */ }
    });
}

/** Fire-and-forget the deterministic deploy stage for a `deploying` ticket. */
function dispatchDeploy(h: ProjectHost, ticketId: string): void {
  h.running.add(ticketId);
  void runDeploy(h, ticketId)
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        h.logActivity('error', `Deploy crashed: ${msg}`, ticketId);
        // Transition out of 'deploying' to prevent infinite crash-redispatch
        // via the watchdog alarm. Match the pattern in dispatchRun's catch.
        const now = Date.now();
        // Bump deploy_attempts here too — the infra-fail path counts attempts,
        // but a crash outside runDeployStage's try parked without counting, so
        // reconcileStuck saw attempts=0 < MAX and re-dispatched forever. Consume
        // the retry budget so a persistently-crashing deploy escalates to a human.
        h.state.storage.sql.exec(
          "UPDATE tickets SET status = 'needs-input', assignee_role = NULL, stuck_reason = ?, deploy_attempts = COALESCE(deploy_attempts, 0) + 1, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
          `Deploy crashed: ${msg}`.slice(0, 500), now, ticketId,
        );
        h.broadcast({ type: 'transition', ticketId, from: 'deploying', to: 'needs-input', trigger: 'system', reason: 'deploy-crash' });
      } catch { /* last-resort: don't throw from the error handler */ }
    })
    .finally(() => {
      h.running.delete(ticketId);
      touchUserActivity(h);
      try { autoAdvance(h); } catch { /* watchdog backstop */ }
    });
}

function runDeploy(h: ProjectHost, ticketId: string): Promise<void> {
  return runDeployStage({
    sql: h.state.storage.sql,
    env: h.env,
    broadcast: (e) => h.broadcast(e),
    logActivity: (type, detail, tid, meta) => h.logActivity(type, detail, tid, meta),
    storeMessage: (opts) => storeMessage(h, opts),
    loadFiles: () => loadFiles(h.state.storage.sql),
    syncFromGitHub: (reason) => syncFromGitHub(h, reason),
  }, ticketId);
}

/** Transition a ticket forward after a successful agent run. */
function applyAgentOutcome(h: ProjectHost, ticketId: string, role: Role, output: string): void {
  const now = Date.now();
  if (role === 'BA') {
    // BA can block on the founder when a buildable spec needs a product/scope
    // decision — park in needs-input with the questions instead of loosing Dev
    // on an unspecced ticket (which just burns Dev/QA/deploy iterations).
    if (baVerdict(output) === 'blocked') {
      blockForInput(h, ticketId, 'BA', output.slice(0, 8000));
      return;
    }
    // Stash the BA's analysis as a minimal spec and await approval.
    const spec: BaSpec = {
      summary: output.slice(0, 4000),
      acceptanceCriteria: [],
      sdkPrimitives: [],
      filesToCreate: [],
      outOfScope: [],
      approvedBy: null,
      approvedAt: null,
      revisionOf: null,
    };
    h.state.storage.sql.exec(
      "UPDATE tickets SET status = 'awaiting-approval', assignee_role = NULL, spec_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(spec), now, ticketId,
    );
    h.broadcast({ type: 'transition', ticketId, from: 'ba-refining', to: 'awaiting-approval', trigger: 'BA' });
  } else if (role === 'Dev') {
    // First pass → QA writes unit/integration tests. On a re-fix (Dev
    // addressing a failed CI build or test run) tests already exist, so
    // skip QA and go straight to the deploy stage to re-run them.
    const hasTests = [...loadFiles(h.state.storage.sql).keys()].some((p) => /^tests\/(unit|integration)\/.+\.test\.[tj]sx?$/i.test(p));
    if (hasTests) {
      h.state.storage.sql.exec(
        "UPDATE tickets SET status = 'deploying', assignee_role = NULL, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      h.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'deploying', trigger: 'system', reason: 'tests-exist' });
    } else {
      h.state.storage.sql.exec(
        "UPDATE tickets SET status = 'qa-active', assignee_role = 'QA', updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      h.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'qa-active', trigger: 'Dev' });
    }
  } else if (role === 'QA') {
    // QA's job is to WRITE unit/integration tests (to tests/), not to opine.
    // It can still block on a genuine untestable-without-a-decision case
    // (READY/BLOCKED, same parser as the BA). Otherwise hand to the deploy
    // stage, which pushes + runs CI; a failing test routes back to Dev.
    if (baVerdict(output) === 'blocked') {
      blockForInput(h, ticketId, 'QA', output.slice(0, 8000));
      return;
    }
    h.state.storage.sql.exec(
      "UPDATE tickets SET status = 'deploying', assignee_role = NULL, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
      now, ticketId,
    );
    h.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'deploying', trigger: 'QA' });
  }
}

/** Park a ticket in needs-input with a message to the user. */
export function blockForInput(h: ProjectHost, ticketId: string, role: Role, message: string): void {
  const now = Date.now();
  // Persist the blocking role so the chat resume restarts the right stage
  // (resume keys off assignee_role).
  h.state.storage.sql.exec(
    "UPDATE tickets SET status = 'needs-input', assignee_role = ?, updated_at = ? WHERE id = ?",
    role, now, ticketId,
  );
  const blockId = insertChatMessage(h.state.storage.sql, { role: 'system', body: message, at: now });
  h.logActivity('blocked', message, ticketId);
  h.broadcast({ type: 'transition', ticketId, to: 'needs-input', reason: 'agent-blocked', role });
  h.broadcast({ type: 'chat', role: 'system', body: message, id: blockId });
}

/** Hard-fail a ticket (system trigger). */
export function failTicket(h: ProjectHost, ticketId: string, from: TicketStatus, reason: string): void {
  const now = Date.now();
  h.state.storage.sql.exec(
    "UPDATE tickets SET status = 'failed', stuck_reason = ?, updated_at = ? WHERE id = ?",
    reason, now, ticketId,
  );
  h.broadcast({ type: 'transition', ticketId, from, to: 'failed', trigger: 'system', reason });
}

export function directDeploy(h: ProjectHost): Response {
  // The deploy stage provisions the repo on first deploy (push → admin worker
  // creates the repo + CF Pages + DNS), so no repo is required up front — just a
  // non-empty working tree to ship.
  const fileCount = (h.state.storage.sql.exec('SELECT COUNT(*) AS n FROM project_files').toArray()[0] as { n: number }).n;
  if (fileCount === 0) return json({ error: 'Working tree is empty — write files before deploying.' }, 409);
  const seq = (h.state.storage.sql.exec('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tickets').toArray()[0] as { n: number }).n;
  const id = crypto.randomUUID();
  const now = Date.now();
  h.state.storage.sql.exec(
    `INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at)
     VALUES (?, ?, 'Direct deploy', 'Deploy the current working tree (direct build).', 'deploying', ?, ?)`,
    id, seq, now, now,
  );
  h.broadcast({ type: 'transition', ticketId: id, from: 'inbox', to: 'deploying', trigger: 'system', reason: 'direct-deploy' });
  dispatchDeploy(h, id);
  return json({ ok: true, ticketId: id, status: 'deploying' });
}

export function runAgent(h: ProjectHost, ticketId: string, _request: Request): Response {
  const row = h.state.storage.sql
    .exec('SELECT * FROM tickets WHERE id = ?', ticketId)
    .toArray()[0];
  if (!row) return json({ error: 'ticket_not_found' }, 404);

  const ticket = rowToTicket(row);
  if (isTerminal(ticket.status)) {
    return json({ error: 'ticket_is_terminal', status: ticket.status }, 400);
  }

  const role = assigneeForStatus(ticket.status);
  if (!role) {
    return json({ error: 'no_assignee_for_status', status: ticket.status }, 400);
  }

  if (h.running.has(ticketId)) {
    return json({ status: 'already_running', ticketId, role }, 409);
  }

  const rcRow = h.state.storage.sql
    .exec('SELECT runtime FROM role_configs WHERE role = ?', role)
    .toArray()[0] as { runtime: string } | undefined;

  dispatchRun(h, ticketId);

  return json({ status: 'started', ticketId, role, runtime: rcRow?.runtime ?? null }, 202);
}

/** The Durable Object alarm: the backstop that keeps a running project moving. */
export function runWatchdogAlarm(h: ProjectHost): void {
  const proj = h.state.storage.sql
    .exec('SELECT status FROM project LIMIT 1')
    .toArray()[0] as { status: string } | undefined;
  if (!proj || proj.status !== 'running') return; // paused → stop the watchdog

  // Drive the pipeline + re-dispatch any active tickets that lost their
  // in-memory run flag (e.g. after hibernation/eviction).
  autoAdvance(h);

  // Re-arm only while still running (autoAdvance may have auto-paused).
  const after = h.state.storage.sql
    .exec('SELECT status FROM project LIMIT 1')
    .toArray()[0] as { status: string } | undefined;
  if (after?.status === 'running') scheduleWatchdog(h);
}
