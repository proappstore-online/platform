/**
 * One autonomous agent turn for a ticket: resolve the owner's BYO key,
 * instantiate the configured runtime, stream the turn (persisting messages +
 * cost and broadcasting events), then transition the ticket based on the
 * outcome. Extracted from ProjectDO; the DO passes a deps object (storage +
 * the orchestration callbacks). Behaviour-identical to the former method.
 */

import type { Bindings } from './index.ts';
import type { AgentRuntime, Role, TicketStatus, ToolCall, ToolResult } from './types.ts';
import { rowToTicket, rowToRoleConfig, insertChatMessage } from './store.ts';
import { MAX_RUN_MINUTES as DEFAULT_MAX_RUN_MINUTES, assigneeForStatus, isTerminal } from './ticket-machine.ts';
import { runtimeToProvider, resolveByoKey } from './byo-key.ts';
import { CFNativeRuntime } from './runtimes/cf-native.ts';
import { OpenAIResponsesRuntime } from './runtimes/openai-responses.ts';
import { buildSeedMessages } from './prompts.ts';
import { formatMemory, type MemoryEntry } from './memory.ts';
import { toolActivityDetail } from './tool-activity.ts';

export interface AgentRunDeps {
  sql: SqlStorage;
  env: Bindings;
  broadcast(event: Record<string, unknown>): void;
  logActivity(type: string, detail: string, ticketId?: string | null, meta?: string): string;
  setActivityMeta(id: string, meta: string): void;
  syncFromGitHub(reason: string): Promise<unknown>;
  loadFiles(): Map<string, string>;
  saveFiles(files: Map<string, string>): void;
  recallMemory(): MemoryEntry[];
  storeMessage(opts: {
    ticketId: string; author: string; body: string;
    toolCalls?: ToolCall[] | undefined; costUsd?: number | undefined;
    tokensIn?: number | undefined; tokensOut?: number | undefined; model?: string | undefined;
  }): Promise<string>;
  makeDispatch(files: Map<string, string>): (call: ToolCall) => Promise<ToolResult>;
  failTicket(ticketId: string, from: TicketStatus, reason: string): void;
  blockForInput(ticketId: string, role: Role, message: string): void;
  applyAgentOutcome(ticketId: string, role: Role, output: string): void;
}

export async function runAgentTurn(deps: AgentRunDeps, ticketId: string): Promise<void> {
  const { sql, env } = deps;
  const row = sql
    .exec('SELECT * FROM tickets WHERE id = ?', ticketId)
    .toArray()[0] as Record<string, unknown> | undefined;
  if (!row) return;
  const ticket = rowToTicket(row);
  const role = assigneeForStatus(ticket.status);
  if (!role) return;

  const proj = sql
    .exec('SELECT owner_id, slug, owner_session_token FROM project LIMIT 1')
    .toArray()[0] as { owner_id: string; slug: string; owner_session_token: string | null } | undefined;
  if (!proj) return;
  // max_run_minutes was added by a migration; read it separately so DOs that
  // haven't applied the migration yet don't crash the whole run.
  let maxRunMinutes = DEFAULT_MAX_RUN_MINUTES;
  try {
    const m = sql.exec('SELECT max_run_minutes FROM project LIMIT 1').toArray()[0] as { max_run_minutes?: number } | undefined;
    if (m?.max_run_minutes) maxRunMinutes = m.max_run_minutes;
  } catch { /* column doesn't exist yet — use default */ }

  const rcRow = sql
    .exec('SELECT * FROM role_configs WHERE role = ?', role)
    .toArray()[0] as Record<string, unknown> | undefined;
  if (!rcRow) {
    deps.failTicket(ticketId, ticket.status, `Role ${role} is not configured`);
    return;
  }
  const roleConfig = rowToRoleConfig(rcRow);
  // Deploy is now a deterministic system stage (after QA), not an agent action —
  // strip the deploy tools so Dev/QA don't push un-QA'd code or self-declare
  // "deployed". Every role may consult the official docs (union, no migration).
  const DEPLOY_TOOLS = new Set(['scaffold_app', 'provision_app', 'get_deploy_status']);
  roleConfig.spineTools = roleConfig.spineTools.filter((t) => !DEPLOY_TOOLS.has(t));
  if (!roleConfig.spineTools.includes('read_docs')) roleConfig.spineTools = [...roleConfig.spineTools, 'read_docs'];
  // QA authors E2E specs (e2e/specs/) rather than reviewing prose, so it needs
  // write_file. Ensure it here too — covers projects seeded before QA gained it
  // (union, no migration), matching the read_docs pattern above.
  if (role === 'QA' && !roleConfig.spineTools.includes('write_file')) roleConfig.spineTools = [...roleConfig.spineTools, 'write_file'];

  // Resolve the owner's BYO key for this runtime's provider.
  const provider = runtimeToProvider(roleConfig.runtime);
  const byoKey = await resolveByoKey(env, proj.owner_id, provider);
  if (!byoKey) {
    deps.blockForInput(
      ticketId,
      role,
      `${role} needs a ${provider} API key. Add one in the platform key vault (Settings → API Keys), then hit Play.`,
    );
    return;
  }

  deps.broadcast({ type: 'agent-run-started', ticketId, role, runtime: roleConfig.runtime });
  deps.logActivity('agent', `${role} started`, ticketId);

  const runtime: AgentRuntime = roleConfig.runtime === 'openai-responses'
    ? new OpenAIResponsesRuntime()
    : new CFNativeRuntime();

  const prior = sql
    .exec('SELECT author, body FROM messages WHERE ticket_id = ? ORDER BY created_at', ticket.id)
    .toArray() as { author: string; body: string }[];
  // Pull the latest committed code before the agent reads/edits (GitHub = truth).
  await deps.syncFromGitHub(`before ${role} run`);
  const files = deps.loadFiles();
  // The Architect's KB (KNOWLEDGE.md) grounds every build role — inject its content.
  const kb = files.get('KNOWLEDGE.md') ?? '';
  const messages = buildSeedMessages(role, ticket, proj.slug, prior, [...files.keys()].sort(), formatMemory(deps.recallMemory()), kb);

  let assistantText = '';
  const toolCalls: ToolCall[] = [];
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let errorMessage: string | null = null;

  try {
    const handle = await runtime.prepare({
      projectId: proj.slug,
      ticketId,
      role: roleConfig,
      byoKey,
      userToken: proj.owner_session_token ?? undefined,
      dispatch: deps.makeDispatch(files),
    });

    // Consume the stream, but cap wall-clock time so a hung model call can't
    // wedge the ticket forever. On timeout we keep whatever was accumulated
    // and route the ticket to needs-input. `aborted` stops the loop from
    // mutating shared state (files map, DB) after we've moved on.
    let aborted = false;
    // Aborts the in-flight model fetch on timeout so the runtime generator
    // actually stops — otherwise a hung request keeps calling the model (and
    // billing the BYO key) after the ticket has already moved to needs-input.
    const ac = new AbortController();
    const toolActivityIds = new Map<string, string>(); // callId → activity row id
    const consume = (async () => {
     try {
      for await (const ev of runtime.run(handle, messages, ac.signal)) {
        if (aborted) break;
        switch (ev.type) {
          case 'text-delta':
            assistantText += ev.text;
            deps.broadcast({ type: 'agent-text', ticketId, role, text: ev.text });
            break;
          case 'tool-call': {
            toolCalls.push(ev.call);
            deps.broadcast({ type: 'agent-tool-call', ticketId, role, name: ev.call.name });
            const actId = deps.logActivity('tool', `${role}: ${toolActivityDetail(ev.call.name, ev.call.args)}`, ticketId,
              JSON.stringify({ args: ev.call.args }));
            toolActivityIds.set(ev.call.id, actId);
            break;
          }
          case 'tool-result': {
            // Attach the result to its call so persisted toolCalls carry it
            // (a future replay of history into the model needs matched pairs).
            const tc = toolCalls.find((c) => c.id === ev.result.callId);
            if (tc) tc.result = ev.result;
            deps.broadcast({ type: 'agent-tool-result', ticketId, role, ok: ev.result.ok });
            // Capture the tool's output on its activity row for the audit log.
            const actId = toolActivityIds.get(ev.result.callId);
            if (actId) {
              const out = ev.result.ok ? (typeof ev.result.data === 'string' ? ev.result.data : JSON.stringify(ev.result.data)) : (ev.result.errorMessage ?? 'error');
              deps.setActivityMeta(actId, JSON.stringify({ args: tc?.args, ok: ev.result.ok, result: out ?? '(no output)' }));
            }
            break;
          }
          case 'done':
            costUsd = ev.costUsd;
            tokensIn = ev.tokensIn;
            tokensOut = ev.tokensOut;
            break;
          case 'error':
            errorMessage = ev.message;
            break;
          case 'heartbeat':
            deps.broadcast({ type: 'agent-heartbeat', ticketId, role,
              costUsd: ev.costUsd ?? 0, tokensIn: ev.tokensIn ?? 0, tokensOut: ev.tokensOut ?? 0 });
            break;
        }
      }
     } catch (e) {
       // On timeout we abort the model fetch, which makes the generator throw —
       // that's expected, swallow it. A throw when NOT aborted is a genuine
       // failure, so re-raise it to the outer try/catch.
       if (!aborted) throw e;
     }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), maxRunMinutes * 60_000);
    });
    const outcome = await Promise.race([consume.then(() => 'ok' as const), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      aborted = true; // stop the orphaned loop from further state mutation
      ac.abort();     // and actually cancel the in-flight model fetch (stop the spend)
      errorMessage = errorMessage ?? `Run timed out after ${maxRunMinutes} min. The task may be too large for one pass. Fix: increase the timeout (board header dropdown, max 60m) or break the ticket into smaller pieces.`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'agent run failed';
  }

  // Persist the working tree — Dev's files must survive into the QA run.
  deps.saveFiles(files);

  // Persist the agent's output + cost.
  if (assistantText.trim() || toolCalls.length > 0) {
    await deps.storeMessage({
      ticketId,
      author: role,
      body: assistantText.trim() || `(${role} ran ${toolCalls.length} tool call(s))`,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      costUsd,
      tokensIn,
      tokensOut,
      model: roleConfig.model,
    });
  }
  // Mirror the agent's output into the team chat so the collaboration is
  // visible (the chat panel renders BA/Dev/QA roles). Full text lives on the
  // ticket message; the chat copy is capped for readability.
  if (assistantText.trim()) {
    const chatBody = assistantText.trim().slice(0, 4000);
    const cid = insertChatMessage(sql, { role, body: chatBody });
    deps.broadcast({ type: 'chat', role, body: chatBody, id: cid });
  }
  if (costUsd > 0 || tokensIn > 0) {
    deps.logActivity('cost', `${role} finished · $${costUsd.toFixed(4)} · ${tokensIn}+${tokensOut} tok`, ticketId);
  }
  if (errorMessage) deps.logActivity('error', `${role}: ${errorMessage}`, ticketId);

  // If the cap auto-failed this ticket mid-run, stop here.
  const post = sql
    .exec('SELECT status FROM tickets WHERE id = ?', ticketId)
    .toArray()[0] as { status: string } | undefined;
  if (!post || isTerminal(post.status as TicketStatus)) {
    return; // dispatcher's finally re-advances the pipeline
  }

  if (errorMessage) {
    deps.blockForInput(ticketId, role, `${role} hit an error: ${errorMessage}`);
    return;
  }

  deps.applyAgentOutcome(ticketId, role, assistantText);
}
