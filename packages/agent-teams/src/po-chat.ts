/**
 * PO (Product Owner) chat handler — the founder-facing agent. Triages a chat
 * message: answers factual questions (grounded by read-only file tools +
 * read_docs), records decisions (remember), and turns feature requests into
 * tickets. Extracted from ProjectDO; the DO passes a deps object (storage + the
 * callbacks this needs). The explicit deps list is the honest coupling surface.
 */

import type { Bindings } from './index.ts';
import { json, uuid, insertChatMessage } from './store.ts';
import { slidingWindowAllow, CHAT_LIMIT, CHAT_WINDOW_MS } from './rate-limit.ts';
import { formatMemory, type MemoryEntry } from './memory.ts';
import { buildPOSystemPrompt } from './prompts.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { resolveByoKey } from './byo-key.ts';
import { parseAnthropicStream } from './runtimes/cf-native-stream.ts';
import { executeFileTool } from './spine.ts';
import { toolActivityDetail } from './tool-activity.ts';
import { sliceDocs } from './platform-skill.ts';

/**
 * Extract the first complete JSON object beginning at `startToken`, balancing
 * braces while respecting string literals so a `}` inside a value (e.g. the PO
 * writing "{ id, login, avatarUrl, dateOfBirth }" in rawIdea) doesn't truncate
 * it. A naive `/\{"tool":"create_ticket".*?\}/` matched only to the first `}` —
 * any brace in the ticket text broke JSON.parse and silently dropped the ticket.
 * Returns the JSON substring, or null if no balanced object is found.
 */
export function extractJsonObject(text: string, startToken: string): string | null {
  const start = text.indexOf(startToken);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Extract EVERY balanced JSON object starting at `startToken` (capped). The PO
 * can file a whole backlog in one reply (one create_ticket object per line, in
 * priority order) — extractJsonObject only finds the first, so multi-ticket
 * backlogs were silently truncated to a single ticket.
 */
export function extractAllJsonObjects(text: string, startToken: string, cap = 25): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < cap) {
    const slice = text.slice(from);
    const obj = extractJsonObject(slice, startToken);
    if (!obj) break;
    out.push(obj);
    from += slice.indexOf(obj) + obj.length;
  }
  return out;
}

export interface PoChatDeps {
  sql: SqlStorage;
  env: Bindings;
  getChatWindow(): number[];
  setChatWindow(w: number[]): void;
  touchUserActivity(): void;
  syncFromGitHub(reason: string): Promise<unknown>;
  broadcast(event: Record<string, unknown>): void;
  autoAdvance(): void;
  loadFiles(): Map<string, string>;
  recallMemory(): MemoryEntry[];
  rememberFact(category: string, key: string, value: string): void;
  fetchDocs(): Promise<string>;
  logActivity(type: string, detail: string, ticketId?: string | null, meta?: string): string;
  nextSeq(): number;
}

export async function handlePOChat(deps: PoChatDeps, request: Request): Promise<Response> {
  const { sql, env } = deps;
  const body = (await request.json()) as { message: string; apiKey?: string };
  if (!body.message?.trim()) return json({ error: 'message required' }, 400);
  if (body.message.length > 8192) return json({ error: 'message too long (max 8KB)' }, 413);

  // Per-project chat throttle (each message triggers a PO LLM call).
  const limit = slidingWindowAllow(deps.getChatWindow(), Date.now(), CHAT_LIMIT, CHAT_WINDOW_MS);
  deps.setChatWindow(limit.times);
  if (!limit.allowed) return json({ error: 'Too many messages — please slow down.' }, 429);

  const userText = body.message.trim();
  const now = Date.now();

  // Record user activity (resets idle timeout)
  deps.touchUserActivity();

  // Sync the working tree with GitHub so the PO answers from the latest code.
  await deps.syncFromGitHub('PO chat');

  // Check if any tickets are in needs-input — user's message might be the answer
  const blockedTickets = sql
    .exec("SELECT id, assignee_role FROM tickets WHERE status = 'needs-input' ORDER BY updated_at LIMIT 1")
    .toArray() as { id: string; assignee_role: string }[];

  if (blockedTickets.length > 0) {
    const blocked = blockedTickets[0]!;
    // Save the user's answer as a message on the ticket
    sql.exec(
      'INSERT INTO messages (id, ticket_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      uuid(), blocked.id, 'po', userText, now,
    );
    // Resume to a "pending" state so autoAdvance picks it up and re-assigns.
    // Don't go directly to an active state — the agent needs to restart.
    const resumeStatus = blocked.assignee_role === 'BA' ? 'ba-refining'
      : blocked.assignee_role === 'QA' ? 'qa-active'
      : 'dev-active';
    sql.exec('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', resumeStatus, now, blocked.id);
    deps.broadcast({ type: 'transition', ticketId: blocked.id, from: 'needs-input', to: resumeStatus, reason: 'user-answered' });
    deps.autoAdvance();
  }

  // Save user message to chat history
  const userMsgId = insertChatMessage(sql, { role: 'user', body: userText, at: now });
  deps.broadcast({ type: 'chat', role: 'user', body: userText, id: userMsgId });

  // Signal "PO is working" to the UI (the agent loop below can take many seconds
  // with no other events). The console's working indicator keys off this + the
  // per-turn heartbeats and clears on staleness — same model as the BA/Dev/QA
  // runner (no explicit finished event needed).
  deps.broadcast({ type: 'agent-run-started', role: 'PO' });

  // Get current project state for context
  const ticketRows = sql
    .exec('SELECT id, seq, title, status, assignee_role FROM tickets ORDER BY created_at DESC LIMIT 20')
    .toArray();
  const backlogSummary = ticketRows.map((t) =>
    `- #${t.seq ?? '?'} [${t.status}] ${t.title}${t.assignee_role ? ` (${t.assignee_role})` : ''}`
  ).join('\n');

  // The app's current files — so the PO can answer questions about the actual
  // app ("do we use google or github?") instead of guessing generically.
  const fileList = [...deps.loadFiles().keys()].sort();

  // App identity — the PO must reason about THIS app, not the ProAppStore
  // platform it's hosted on. Name from the project; "what it is" from the
  // founding idea: the persisted project idea (brainstorm-first projects have no
  // seeded ticket), falling back to the oldest ticket for older projects.
  const proj = sql
    .exec('SELECT name, slug, app_idea FROM project LIMIT 1')
    .toArray()[0] as { name: string; slug: string; app_idea: string | null } | undefined;
  const founding = sql
    .exec('SELECT raw_idea FROM tickets ORDER BY created_at ASC LIMIT 1')
    .toArray()[0] as { raw_idea: string } | undefined;
  const appName = proj?.name ?? proj?.slug ?? 'this app';
  const appIdea = proj?.app_idea?.trim() || founding?.raw_idea?.trim();

  // Get recent chat history for context
  const recentChat = sql
    .exec("SELECT role, body FROM chat_history WHERE thread = 'build' ORDER BY created_at DESC LIMIT 20")
    .toArray()
    .reverse()
    .map((r) => ({ role: r.role as string, body: r.body as string }));

  // Resolve the PO's model key: prefer a client-supplied key, else fall back
  // to the owner's BYO key in the vault. Only drop to the rule-based PO if
  // neither is available.
  let apiKey = body.apiKey;
  if (!apiKey) {
    const owner = sql
      .exec('SELECT owner_id FROM project LIMIT 1')
      .toArray()[0] as { owner_id: string } | undefined;
    if (owner) {
      apiKey = (await resolveByoKey(env, owner.owner_id, 'anthropic')) ?? undefined;
    }
  }
  if (!apiKey) {
    return poTriageWithoutAI(deps, userText, backlogSummary, now);
  }

  const memoryBlock = formatMemory(deps.recallMemory());

  // Call Anthropic for real PO agent response (prompt built by a pure helper).
  const systemPrompt = buildPOSystemPrompt({
    appName,
    slug: proj?.slug ?? 'app',
    appIdea,
    memoryBlock,
    backlogSummary,
    fileList,
  });

  // Read-only code tools + a memory-write tool for the PO.
  const poTools: { name: string; description: string; input_schema: unknown }[] = (['list_files', 'read_file', 'search_files'] as const).map((name) => ({
    name, description: TOOL_SCHEMAS[name]!.description, input_schema: TOOL_SCHEMAS[name]!.parameters,
  }));
  poTools.push({
    name: 'remember',
    description: 'Record a durable decision or fact about this app (e.g. auth provider, target users, tech choice) so the whole team treats it as ground truth. Upserts by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'short stable label, e.g. "auth" or "target_users"' },
        value: { type: 'string', description: 'the decision/fact' },
        category: { type: 'string', description: 'decision | fact | preference | architecture' },
      },
      required: ['key', 'value'],
    },
  });
  poTools.push({
    name: 'read_docs',
    description: 'Read the official ProAppStore platform/SDK docs (the same skills.md the user can read). Use to confirm a real SDK/API capability before answering, and cite the doc URL to the founder. Pass a topic (e.g. "database", "rooms", "subscription") to get just that section.',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'optional section/keyword to focus on' } },
    },
  });
  const poFiles = deps.loadFiles();
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = recentChat.map((m) => ({
    role: m.role === 'user' ? 'user' as const : 'assistant' as const,
    content: m.body,
  }));

  try {
    let text = '';
    // Tool loop: let the PO read/search the code, capped to keep it cheap.
    for (let turn = 0; turn < 8; turn++) { // room to research + self-verify before answering
      deps.broadcast({ type: 'agent-heartbeat', role: 'PO' }); // keep the UI's working indicator alive across LLM turns
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: systemPrompt,
          tools: poTools,
          messages,
          stream: true,
        }),
      });

      if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); const b = JSON.parse(t) as { error?: { message?: string } }; detail = b?.error?.message ?? t.slice(0, 200); } catch { /* already captured what we could */ }
        const safeError = res.status === 401 ? 'API key rejected - check your Anthropic key in Profile > API Keys'
          : res.status === 429 ? 'Rate limited by Anthropic - wait a moment'
          : `Anthropic error: ${detail.slice(0, 200) || `status ${res.status}`}`;
        return savePOResponse(deps, `Sorry, I couldn't process that: ${safeError}`, now, undefined);
      }
      if (!res.body) return savePOResponse(deps, 'No response from Anthropic.', now, undefined);

      // Stream the response — prevents CF 524 timeout on large contexts.
      const stream = parseAnthropicStream(res.body);
      let sr = await stream.next();
      while (!sr.done) {
        if (sr.value.type === 'text-delta') deps.broadcast({ type: 'agent-text', role: 'PO', text: sr.value.text });
        sr = await stream.next();
      }
      const aiRes = sr.value;
      const contentArr = aiRes.content;
      messages.push({ role: 'assistant', content: contentArr });
      text = (contentArr as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

      const toolUses = contentArr.filter((c) => c.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: unknown }[];
      if (toolUses.length === 0 || aiRes.stop_reason !== 'tool_use') break;

      // Execute tool calls: remember → memory write; read_docs → official docs;
      // everything else → read-only file tools.
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
          deps.logActivity('tool', `PO: read_docs${topic ? ` ${topic}` : ''}`, null, JSON.stringify({ args: tu.input, result: out }));
          return { type: 'tool_result' as const, tool_use_id: tu.id!, content: out };
        }
        const r = executeFileTool({ id: tu.id!, name: tu.name!, args: tu.input }, poFiles);
        const out = (r.ok ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : (r.errorMessage ?? 'error')) || '(no output)';
        deps.logActivity('tool', `PO: ${toolActivityDetail(tu.name!, tu.input)}`, null,
          JSON.stringify({ args: tu.input, ok: r.ok, result: out }));
        return { type: 'tool_result' as const, tool_use_id: tu.id!, content: out };
      }));
      messages.push({ role: 'user', content: toolResults });
    }

    // The PO can file a WHOLE backlog in one reply (one create_ticket object per
    // line, in dependency/priority order). Create EVERY one — not just the first
    // (brace-balanced extract so a `}` inside the ticket text doesn't truncate).
    const toolJsons = extractAllJsonObjects(text, '{"tool":"create_ticket"');
    if (toolJsons.length > 0) {
      const created: { seq: number; title: string }[] = [];
      const ticketNow = Date.now();
      let cleanText = text;
      for (const tj of toolJsons) {
        cleanText = cleanText.replace(tj, '');
        try {
          const tool = JSON.parse(tj) as { title: string; rawIdea: string };
          if (!tool.title || !tool.rawIdea) continue;
          const title = tool.title.replace(/^#\d+\s*/, '').trim(); // drop any "#N " the PO prefixed (seq is the real number)
          const ticketId = uuid();
          const ticketSeq = deps.nextSeq();
          sql.exec(
            `INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'inbox', ?, ?)`,
            ticketId, ticketSeq, title, tool.rawIdea, ticketNow, ticketNow,
          );
          deps.broadcast({ type: 'ticket-created', ticket: { id: ticketId, seq: ticketSeq, title, status: 'inbox', rawIdea: tool.rawIdea, assigneeRole: null, iterations: 0, costSpentUsd: 0, createdAt: ticketNow, updatedAt: ticketNow, stuckReason: null } });
          created.push({ seq: ticketSeq, title });
        } catch { /* skip a malformed block, keep the rest */ }
      }
      if (created.length > 0) {
        deps.autoAdvance();
        const summary = created.length === 1
          ? `Got it — created ticket #${created[0]!.seq}: "${created[0]!.title}". It's in the inbox.`
          : `Got it — filed ${created.length} tickets into the backlog, in build order:\n${created.map((c) => `#${c.seq} ${c.title}`).join('\n')}`;
        const poText = cleanText.trim() || summary;
        return savePOResponse(deps, poText, ticketNow, { name: 'create_ticket', args: `${created.length} ticket(s): ${created.map((c) => `#${c.seq}`).join(', ')}` });
      }
    }

    // Regular response
    return savePOResponse(deps, text, Date.now(), undefined);

  } catch (err) {
    return savePOResponse(deps,
      `I had trouble processing that. Error: ${err instanceof Error ? err.message : 'unknown'}`,
      Date.now(), undefined,
    );
  }
}

/** Rule-based PO when no API key is provided. */
function poTriageWithoutAI(deps: PoChatDeps, userText: string, backlogSummary: string, now: number): Response {
  const lower = userText.toLowerCase();

  // Detect intent
  if (lower.includes('show') && (lower.includes('board') || lower.includes('ticket') || lower.includes('backlog'))) {
    const text = backlogSummary
      ? `Here's the current backlog:\n${backlogSummary}`
      : 'The backlog is empty. Tell me what you want to build!';
    return savePOResponse(deps, text, now, undefined);
  }

  if (lower.includes('?') && (lower.includes('how') || lower.includes('what') || lower.includes('can') || lower.includes('why'))) {
    return savePOResponse(deps,
      `That's a good question. I'll route it to the Dev agent once one is connected. For now, I've noted it.`,
      now, undefined,
    );
  }

  // Default: create a ticket
  const title = userText.length > 100 ? userText.slice(0, 97) + '...' : userText;
  const ticketId = uuid();
  const seq = deps.nextSeq();
  deps.sql.exec(
    `INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'inbox', ?, ?)`,
    ticketId, seq, title, userText, now, now,
  );
  deps.broadcast({ type: 'ticket-created', ticket: { id: ticketId, seq, title, status: 'inbox', rawIdea: userText, assigneeRole: null, iterations: 0, costSpentUsd: 0, createdAt: now, updatedAt: now, stuckReason: null } });
  deps.autoAdvance();

  return savePOResponse(deps,
    `Got it. I created a ticket: "${title}". It's in the inbox — BA will refine it into a spec when connected.`,
    now,
    { name: 'create_ticket', args: title },
  );
}

function savePOResponse(
  deps: PoChatDeps,
  text: string,
  now: number,
  toolCall: { name: string; args: string } | undefined,
): Response {
  const msgId = insertChatMessage(deps.sql, { role: 'po', body: text, toolCall: toolCall ?? null, at: now });
  deps.broadcast({ type: 'chat', role: 'po', body: text, id: msgId, toolCall });

  return json({ id: msgId, role: 'po', body: text, toolCall, createdAt: now });
}
