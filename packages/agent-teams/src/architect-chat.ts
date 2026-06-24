/**
 * Architect (Knowledge Base) chat handler — the founder-facing KB agent for the
 * Research tab, on the SEPARATE 'research' chat thread. Distinct from the PO
 * (build) chat by design: the Architect owns ONLY the Knowledge Base
 * (KNOWLEDGE.md + docs/), so the KB is authored — and the build is checked —
 * against an independently-owned source of truth. It brainstorms, researches
 * (read-only code tools + read_docs), records decisions (remember), and writes/
 * refines the KB files. It does NOT create build tickets (that's the PO).
 */

import type { Bindings } from './bindings.ts';
import { json, insertChatMessage } from './store.ts';
import { slidingWindowAllow, CHAT_LIMIT, CHAT_WINDOW_MS } from './rate-limit.ts';
import { formatMemory, type MemoryEntry } from './memory.ts';
import { buildArchitectChatSystemPrompt } from './prompts.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { resolveByoKey } from './byo-key.ts';
import { executeFileTool } from './spine.ts';
import { toolActivityDetail } from './tool-activity.ts';
import { sliceDocs } from './platform-skill.ts';
import { isKbPath, KbIndex } from './kb-rag.ts';
import { estimateCost } from './runtimes/cf-native-pricing.ts';
import { parseAnthropicStream } from './runtimes/cf-native-stream.ts';

/** The Architect's chat thread (kept out of the PO/build transcript). */
export const RESEARCH_THREAD = 'research';

/** The Architect's model — also used for spend estimation. */
const ARCHITECT_MODEL = 'claude-sonnet-4-6';

/** Record the run's spend (like the build agents' 'cost' activity) so the
 *  Research tab shows what authoring the KB cost. No-op when nothing was spent. */
function logArchitectCost(deps: ArchitectChatDeps, tokensIn: number, tokensOut: number): void {
  if (tokensIn <= 0 && tokensOut <= 0) return;
  const usd = estimateCost(ARCHITECT_MODEL, tokensIn, tokensOut);
  deps.logActivity('cost', `Architect · $${usd.toFixed(4)} · ${tokensIn}+${tokensOut} tok`, null);
}

export interface ArchitectChatDeps {
  sql: SqlStorage;
  env: Bindings;
  getChatWindow(): number[];
  setChatWindow(w: number[]): void;
  touchUserActivity(): void;
  syncFromGitHub(reason: string): Promise<unknown>;
  broadcast(event: Record<string, unknown>): void;
  loadFiles(): Map<string, string>;
  saveFiles(files: Map<string, string>): void;
  recallMemory(): MemoryEntry[];
  rememberFact(category: string, key: string, value: string): void;
  fetchDocs(): Promise<string>;
  logActivity(type: string, detail: string, ticketId?: string | null, meta?: string): string;
  /** Publish the KB as a shareable Zensical site (best-effort, non-blocking). */
  publishKb(): void;
}

function save(deps: ArchitectChatDeps, text: string, now: number): Response {
  const id = insertChatMessage(deps.sql, { role: 'Architect', body: text, at: now, thread: RESEARCH_THREAD });
  deps.broadcast({ type: 'chat', role: 'Architect', body: text, id, thread: RESEARCH_THREAD });
  return json({ id, role: 'Architect', body: text, createdAt: now });
}

/** True when a chat message asks the Architect to AUTHOR the Knowledge Base
 *  (not just answer a question). Gates the "you must actually write KNOWLEDGE.md
 *  before finishing" enforcement so plain Q&A chat is never forced to write. */
export function wantsKbAuthoring(text: string): boolean {
  return /knowledge base|KNOWLEDGE\.md/i.test(text) && /\b(write|author|create|build|research|draft|generate|document)\b/i.test(text);
}

/** What to do after the model's turn. Extracted so the control flow that caused
 *  the orphaned-tool_use 400 is unit-tested in isolation. */
export type ArchitectTurnAction = 'process' | 'nudge' | 'finish';

/**
 * Decide the next step after a model turn:
 * - 'process' — there are pending tool_use blocks; ALWAYS answer them (push
 *   tool_results) regardless of stop_reason. Nudging/finishing here would leave a
 *   tool_use unanswered → Anthropic 400 ("tool_use ids without tool_result").
 * - 'nudge'   — no tool calls, but the user asked to author the KB and nothing
 *   was written yet (and we haven't nudged) → push one hard "write it now" prompt.
 * - 'finish'  — no tool calls and nothing left to insist on.
 */
export function decideArchitectTurn(opts: {
  toolUseCount: number;
  wantsKb: boolean;
  wrote: boolean;
  alreadyNudged: boolean;
  askedQuestion: boolean;
  kbExists: boolean;
}): ArchitectTurnAction {
  if (opts.toolUseCount > 0) return 'process';
  if (opts.askedQuestion) {
    // Normally let a clarifying question continue the conversation. EXCEPT when a
    // KB already exists and the user is in a KB session: they're answering to
    // UPDATE the KB, so "another question, no write" is the "why aren't you
    // updating it when I answer?" stall — nudge once to write first (alreadyNudged
    // stops loops; on a brand-new KB we still let it gather the idea first).
    if (opts.wantsKb && !opts.wrote && !opts.alreadyNudged && opts.kbExists) return 'nudge';
    return 'finish';
  }
  if (opts.wantsKb && !opts.wrote && !opts.alreadyNudged) return 'nudge';
  return 'finish';
}

/** True when the Architect's message ends by asking the founder something — used
 *  to keep the "must write the KB" nudge/fallback from firing mid-conversation. */
export function looksLikeQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim());
}

/**
 * Last-resort KNOWLEDGE.md when the user asked for a KB but the model never wrote
 * one (refused, hit the turn cap, or the run aborted). Synthesizes a draft from
 * the facts the Architect *did* gather (its `remember` calls) so the Research tab
 * is never empty after a build — exactly the coffeerating symptom. Only used when
 * nothing real was written, so it never overwrites a genuine KB.
 */
export function buildFallbackKnowledge(
  appName: string,
  appIdea: string | undefined,
  memory: readonly MemoryEntry[],
): string {
  const facts = memory.length
    ? memory.map((e) => `- **${e.key.replace(/_/g, ' ')}**: ${e.value}`).join('\n')
    : '_No durable facts were captured during research._';
  return `# ${appName}

${appIdea ? `${appIdea.trim()}\n\n` : ''}> ⚠️ **Draft Knowledge Base.** The Architect researched this app but didn't finish writing the full KB. These are the facts it gathered — re-run "research & write the KB" to expand into a complete source of truth.

## What we know

${facts}
`;
}

/** KB file paths touched by a write tool call (for re-embedding into Vectorize).
 *  Reads the same `path` / `files[].path` shape executeFileTool consumes. */
export function writtenKbPaths(toolName: string, input: unknown): string[] {
  const a = (input ?? {}) as { path?: string; files?: { path?: string }[] };
  const paths = toolName === 'batch_write_files'
    ? (a.files ?? []).map((f) => f.path)
    : [a.path];
  return paths.filter((p): p is string => typeof p === 'string' && isKbPath(p));
}

const KB_WRITE_NUDGE =
  "Stop — you haven't written to the Knowledge Base yet this turn. Before you ask anything else or reply, call write_file for KNOWLEDGE.md (and batch_write_files for any docs/*.md) to capture/update what you've gathered: the app's purpose, users, core features, data model, and the SDK capabilities it uses. If a KB already exists, read it and edit the sections that changed. The written KB is the only acceptable next action — not a summary, not 'done', not another question.";

/** Overall wall-clock budget for one Architect run. Past this we abort the
 *  in-flight model fetch so the request can't hang forever and leak the DO's
 *  architectChatBusy lock (which would 409 every future KB build).
 *  6 min (was 4) — a full "re-research + refresh the whole KB" pass legitimately
 *  needs more than 4 min (8 web searches + fetches + writing several docs). The
 *  run is mostly I/O wait + streams live over WS, so the user sees progress; the
 *  write-early prompt means a real KB is saved well before this cap anyway. */
const ARCHITECT_RUN_TIMEOUT_MS = 6 * 60_000;

export async function handleArchitectChat(deps: ArchitectChatDeps, request: Request): Promise<Response> {
  const { sql, env } = deps;
  const body = (await request.json()) as { message: string; apiKey?: string };
  if (!body.message?.trim()) return json({ error: 'message required' }, 400);
  if (body.message.length > 8192) return json({ error: 'message too long (max 8KB)' }, 413);

  const limit = slidingWindowAllow(deps.getChatWindow(), Date.now(), CHAT_LIMIT, CHAT_WINDOW_MS);
  deps.setChatWindow(limit.times);
  if (!limit.allowed) return json({ error: 'Too many messages — please slow down.' }, 429);

  const userText = body.message.trim();
  const now = Date.now();
  deps.touchUserActivity();
  // Pull the latest committed code so the Architect researches the real app.
  await deps.syncFromGitHub('KB chat');

  const userMsgId = insertChatMessage(sql, { role: 'user', body: userText, at: now, thread: RESEARCH_THREAD });
  deps.broadcast({ type: 'chat', role: 'user', body: userText, id: userMsgId, thread: RESEARCH_THREAD });
  deps.broadcast({ type: 'agent-run-started', role: 'Architect' });

  const proj = sql
    .exec('SELECT name, slug, app_idea, owner_id FROM project LIMIT 1')
    .toArray()[0] as { name: string; slug: string; app_idea: string | null; owner_id: string } | undefined;
  const appName = proj?.name ?? proj?.slug ?? 'this app';
  const appIdea = proj?.app_idea?.trim();
  const fileList = [...deps.loadFiles().keys()].sort();

  const recentChat = sql
    .exec('SELECT role, body FROM chat_history WHERE thread = ? ORDER BY created_at DESC LIMIT 20', RESEARCH_THREAD)
    .toArray()
    .reverse()
    .map((r) => ({ role: r.role as string, body: r.body as string }));

  let apiKey = body.apiKey;
  if (!apiKey && proj) apiKey = (await resolveByoKey(env, proj.owner_id, 'anthropic')) ?? undefined;
  if (!apiKey) {
    const hint = proj ? `(looked up owner ${proj.owner_id} for provider 'anthropic')` : '(no project found in DO)';
    return save(deps, `I need an Anthropic API key to research and write the Knowledge Base. Go to your Profile (top-right avatar) and add an Anthropic key, then come back here. ${hint}`, now);
  }

  // The Architect's identity is tunable per project (its role_configs row,
  // shared with its build-role run) — honor it here so the Research-tab chat and
  // the KB-build agent are the same "soul".
  const personaRow = sql
    .exec("SELECT persona FROM role_configs WHERE role = 'Architect'")
    .toArray()[0] as { persona: string | null } | undefined;
  const systemPrompt = buildArchitectChatSystemPrompt({
    appName, slug: proj?.slug ?? 'app', appIdea, memoryBlock: formatMemory(deps.recallMemory()), fileList,
    persona: personaRow?.persona ?? undefined,
  });

  // KB tools: read + WRITE the KB markdown, search, docs, remember. No tickets.
  // The union admits Anthropic's server tools (web_search/web_fetch), which are
  // shaped { type, name, ... } rather than { name, description, input_schema }.
  type ArchitectTool =
    | { name: string; description: string; input_schema: unknown }
    | { type: string; name: string; max_uses?: number; max_content_tokens?: number };
  const tools: ArchitectTool[] =
    (['list_files', 'read_file', 'search_files', 'write_file', 'batch_write_files'] as const).map((name) => ({
      name, description: TOOL_SCHEMAS[name]!.description, input_schema: TOOL_SCHEMAS[name]!.parameters,
    }));
  tools.push({
    name: 'remember',
    description: 'Record a durable decision/fact about this app (target users, key flows, tech choices) so the whole team treats it as ground truth. Upserts by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'short stable label, e.g. "target_users"' },
        value: { type: 'string', description: 'the decision/fact' },
        category: { type: 'string', description: 'decision | fact | preference | architecture' },
      },
      required: ['key', 'value'],
    },
  });
  tools.push({
    name: 'read_docs',
    description: 'Read the official ProAppStore platform/SDK docs (skills.md). Use to confirm a real SDK capability/signature BEFORE writing it into the KB. Pass a topic (e.g. "database", "rooms") for just that section.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'optional section/keyword' } } },
  });
  // Real web research (Anthropic server tools — executed model-side, billed to
  // the BYO key). web_search finds current sources; web_fetch reads a specific
  // page. This is what makes "research the competition / find the market gap"
  // actual research rather than recall from the model's training cutoff.
  tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 8 });
  tools.push({ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, max_content_tokens: 8000 });

  const files = deps.loadFiles();
  let wrote = false;
  // KB files written this run — re-embedded into Vectorize at the end so build
  // agents retrieve fresh knowledge (kb-rag.ts).
  const changedKb = new Set<string>();
  // Did the user ask the Architect to AUTHOR the KB (vs. just chat / answer a
  // question)? Sticky across the conversation: once they've asked to build/refresh
  // the KB, their follow-up ANSWERS are still part of that KB work — so the
  // "actually write it" enforcement keeps applying instead of letting answers turn
  // into endless Q&A with no write (the "why aren't you updating the KB when I
  // answer?" complaint).
  const wantsKb = wantsKbAuthoring(userText) || recentChat.some((m) => m.role === 'user' && wantsKbAuthoring(m.body));
  let nudgedToWrite = false;
  // Re-embed the KB files written this run into Vectorize (best-effort; no-op
  // when AI/Vectorize aren't bound). Called on every terminal path.
  const reindexChangedKb = async (): Promise<void> => {
    if (!env.AI || !env.VECTORIZE || !changedKb.size) return;
    const idx = new KbIndex(env.AI, env.VECTORIZE, proj?.slug ?? 'app');
    for (const p of changedKb) await idx.indexFile(p, files.get(p) ?? '').catch(() => {});
  };
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = recentChat.map((m) => ({
    role: m.role === 'user' ? 'user' as const : 'assistant' as const,
    content: m.body,
  }));

  // Abort the in-flight model fetch if the whole run overruns its budget — a
  // hung stream would otherwise never settle, so the caller's `finally` that
  // releases architectChatBusy never runs and every future KB build 409s.
  const ac = new AbortController();
  const runTimeout = setTimeout(() => ac.abort(), ARCHITECT_RUN_TIMEOUT_MS);
  // Track spend like the build agents, so the Research tab shows the KB cost.
  let totalIn = 0;
  let totalOut = 0;
  let text = '';
  try {
    for (let turn = 0; turn < 25; turn++) { // room for reads + writes + follow-up tools
      deps.broadcast({ type: 'agent-heartbeat', role: 'Architect', costUsd: estimateCost(ARCHITECT_MODEL, totalIn, totalOut), tokensIn: totalIn, tokensOut: totalOut });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-fetch-2025-09-10',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: ARCHITECT_MODEL, max_tokens: 8192, system: systemPrompt, tools, messages, stream: true }),
      });
      if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); const b = JSON.parse(t) as { error?: { message?: string } }; detail = b?.error?.message ?? t.slice(0, 200); } catch { /* already captured what we could */ }
        console.error(`[architect] Anthropic ${res.status}: ${detail.slice(0, 500)}`);
        const safe = res.status === 401 ? 'API key rejected - check your Anthropic key in Profile > API Keys'
          : res.status === 429 ? 'Rate limited by Anthropic - wait a moment and try again'
          : `Anthropic error: ${detail.slice(0, 200) || `status ${res.status}`}`;
        if (wrote) { deps.saveFiles(files); deps.broadcast({ type: 'files-synced', count: files.size }); }
        return save(deps, `Sorry, I couldn't finish that: ${safe}`, Date.now());
      }
      if (!res.body) return save(deps, 'No response body from Anthropic.', Date.now());
      // Stream the response — prevents Cloudflare 524 timeout on large contexts.
      // parseAnthropicStream yields text-delta events (which we broadcast live)
      // and returns the full AnthropicResponse at the end.
      const stream = parseAnthropicStream(res.body);
      let streamResult = await stream.next();
      while (!streamResult.done) {
        const ev = streamResult.value;
        if (ev.type === 'text-delta') {
          deps.broadcast({ type: 'agent-text', role: 'Architect', text: ev.text });
        }
        streamResult = await stream.next();
      }
      const aiRes = streamResult.value;
      totalIn += aiRes.usage?.input_tokens ?? 0;
      totalOut += aiRes.usage?.output_tokens ?? 0;
      const contentArr = aiRes.content;
      messages.push({ role: 'assistant', content: contentArr });
      text = (contentArr as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

      // web_search/web_fetch are SERVER tools: Anthropic runs them and returns
      // server_tool_use + *_tool_result blocks already resolved (never type
      // 'tool_use'), so they don't appear here and need no client handling. If a
      // long search made the model pause, resume by re-invoking with the turn so
      // far (no client tool_result to add).
      if (aiRes.stop_reason === 'pause_turn' as string) continue;
      const toolUses = contentArr.filter((c) => c.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: unknown }[];
      // Pending tool calls are ALWAYS answered below — regardless of stop_reason.
      // Two reasons: (1) a user message after an unanswered tool_use is an invalid
      // history → Anthropic 400 ("tool_use ids without tool_result"); (2) a
      // completed write_file in a max_tokens-truncated turn must still execute,
      // not be abandoned (that would silently lose the KB write).
      const action = decideArchitectTurn({ toolUseCount: toolUses.length, wantsKb, wrote, alreadyNudged: nudgedToWrite, askedQuestion: looksLikeQuestion(text), kbExists: files.has('KNOWLEDGE.md') });
      if (action === 'finish') break;
      if (action === 'nudge') {
        // No pending tool_use to orphan (toolUseCount === 0). One hard "write it
        // now" prompt — the coffeerating fix (researched, wrote nothing, "Done").
        nudgedToWrite = true;
        messages.push({ role: 'user', content: KB_WRITE_NUDGE });
        deps.logActivity('tool', 'Architect: nudged to write KNOWLEDGE.md (researched but wrote nothing)', null);
        continue;
      }
      // action === 'process': fall through to answer every pending tool_use.

      const toolResults = await Promise.all(toolUses.map(async (tu) => {
        if (tu.name === 'remember') {
          const a = (tu.input ?? {}) as { key?: string; value?: string; category?: string };
          if (a.key && a.value) {
            deps.rememberFact(a.category ?? 'decision', a.key, a.value);
            return { type: 'tool_result' as const, tool_use_id: tu.id!, content: `Remembered: ${a.key} = ${a.value}` };
          }
          return { type: 'tool_result' as const, tool_use_id: tu.id!, content: 'remember needs key and value' };
        }
        if (tu.name === 'read_docs') {
          const topic = (tu.input as { topic?: string } | undefined)?.topic;
          const out = sliceDocs(await deps.fetchDocs(), topic) || 'docs unavailable';
          deps.logActivity('tool', `Architect: read_docs${topic ? ` ${topic}` : ''}`, null, JSON.stringify({ args: tu.input, result: out }));
          return { type: 'tool_result' as const, tool_use_id: tu.id!, content: out };
        }
        const r = executeFileTool({ id: tu.id!, name: tu.name!, args: tu.input }, files);
        if (r.ok && (tu.name === 'write_file' || tu.name === 'batch_write_files')) {
          wrote = true;
          for (const p of writtenKbPaths(tu.name!, tu.input)) changedKb.add(p);
          // Save immediately after each write — don't wait for the loop to end.
          // This prevents data loss if the DO is evicted or the loop errors later.
          deps.saveFiles(files);
        }
        const out = (r.ok ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : (r.errorMessage ?? 'error')) || '(no output)';
        deps.logActivity('tool', `Architect: ${toolActivityDetail(tu.name!, tu.input)}`, null, JSON.stringify({ args: tu.input, ok: r.ok, result: out }));
        return { type: 'tool_result' as const, tool_use_id: tu.id!, content: out };
      }));
      messages.push({ role: 'user', content: toolResults });
    }

    // Guarantee a KB exists when one was requested: if the model researched but
    // never wrote a file (the coffeerating failure — refused, hit the 25-turn
    // cap, or finished early), synthesize a draft KNOWLEDGE.md from the facts it
    // gathered. Never overwrites a real KB (only runs when nothing was written).
    // Don't synthesize a draft if the Architect is mid-conversation asking the
    // founder a question — only when it stalled (didn't write, isn't asking).
    if (wantsKb && !wrote && !looksLikeQuestion(text)) {
      files.set('KNOWLEDGE.md', buildFallbackKnowledge(appName, appIdea, deps.recallMemory()));
      deps.saveFiles(files);
      wrote = true;
      changedKb.add('KNOWLEDGE.md');
      deps.logActivity('tool', 'Architect: wrote a fallback KNOWLEDGE.md from gathered facts (model wrote none)', null);
      if (!text) text = "I've captured what I researched into a draft KNOWLEDGE.md. Ask me to expand any section.";
    }

    // Files are saved immediately after each write. Only broadcast the sync event,
    // re-embed the KB into Vectorize, and publish at the end.
    if (wrote) {
      deps.broadcast({ type: 'files-synced', count: files.size });
      await reindexChangedKb();
      deps.publishKb();
    }
    logArchitectCost(deps, totalIn, totalOut);
    return save(deps, text || 'Done.', Date.now());
  } catch (err) {
    // On error/abort too, leave a draft KB if one was requested and nothing was
    // written — a timed-out research run shouldn't be a total loss.
    if (wantsKb && !wrote && !looksLikeQuestion(text)) {
      try {
        files.set('KNOWLEDGE.md', buildFallbackKnowledge(appName, appIdea, deps.recallMemory()));
        wrote = true;
        changedKb.add('KNOWLEDGE.md');
      } catch { /* best-effort */ }
    }
    if (wrote) {
      deps.saveFiles(files);
      deps.broadcast({ type: 'files-synced', count: files.size });
      await reindexChangedKb().catch(() => {});
    }
    logArchitectCost(deps, totalIn, totalOut);
    const aborted = err instanceof Error && err.name === 'AbortError';
    const msg = aborted
      ? `That took too long and I stopped at the ${Math.round(ARCHITECT_RUN_TIMEOUT_MS / 60_000)}-minute limit${wrote ? ' (a draft KB was saved from what I gathered)' : ''}. Try again.`
      : `I had trouble with that. Error: ${err instanceof Error ? err.message : 'unknown'}`;
    return save(deps, msg, Date.now());
  } finally {
    clearTimeout(runTimeout);
  }
}
