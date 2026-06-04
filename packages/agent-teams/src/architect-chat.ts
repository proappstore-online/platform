/**
 * Architect (Knowledge Base) chat handler — the founder-facing KB agent for the
 * Research tab, on the SEPARATE 'research' chat thread. Distinct from the PO
 * (build) chat by design: the Architect owns ONLY the Knowledge Base
 * (KNOWLEDGE.md + docs/), so the KB is authored — and the build is checked —
 * against an independently-owned source of truth. It brainstorms, researches
 * (read-only code tools + read_docs), records decisions (remember), and writes/
 * refines the KB files. It does NOT create build tickets (that's the PO).
 */

import type { Bindings } from './index.ts';
import { json, insertChatMessage } from './store.ts';
import { slidingWindowAllow, CHAT_LIMIT, CHAT_WINDOW_MS } from './rate-limit.ts';
import { formatMemory, type MemoryEntry } from './memory.ts';
import { buildArchitectChatSystemPrompt } from './prompts.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { resolveByoKey } from './byo-key.ts';
import { executeFileTool } from './spine.ts';
import { toolActivityDetail } from './tool-activity.ts';
import { sliceDocs } from './platform-skill.ts';

/** The Architect's chat thread (kept out of the PO/build transcript). */
export const RESEARCH_THREAD = 'research';

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
    return save(deps, "I need an Anthropic API key to research and write the Knowledge Base. Add one in settings, then brainstorm here and I'll write KNOWLEDGE.md + docs/.", now);
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
  const tools: { name: string; description: string; input_schema: unknown }[] =
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

  const files = deps.loadFiles();
  let wrote = false;
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = recentChat.map((m) => ({
    role: m.role === 'user' ? 'user' as const : 'assistant' as const,
    content: m.body,
  }));

  try {
    let text = '';
    for (let turn = 0; turn < 10; turn++) { // room to research + write multiple KB files
      deps.broadcast({ type: 'agent-heartbeat', role: 'Architect' });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4096, system: systemPrompt, tools, messages }),
      });
      if (!res.ok) {
        const safe = res.status === 401 ? 'API key invalid' : res.status === 429 ? 'Rate limited' : `AI error (${res.status})`;
        if (wrote) { deps.saveFiles(files); deps.broadcast({ type: 'files-synced', count: files.size }); }
        return save(deps, `Sorry, I couldn't finish that: ${safe}`, Date.now());
      }
      const aiRes = (await res.json()) as { content?: unknown; stop_reason?: string };
      const contentArr = aiRes.content;
      if (!Array.isArray(contentArr)) return save(deps, 'I got an unexpected response format. Try again?', Date.now());
      messages.push({ role: 'assistant', content: contentArr });
      text = (contentArr as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

      const toolUses = (contentArr as { type: string; id?: string; name?: string; input?: unknown }[]).filter((c) => c.type === 'tool_use');
      if (toolUses.length === 0 || aiRes.stop_reason !== 'tool_use') break;

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
        if (r.ok && (tu.name === 'write_file' || tu.name === 'batch_write_files')) wrote = true;
        const out = (r.ok ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : (r.errorMessage ?? 'error')) || '(no output)';
        deps.logActivity('tool', `Architect: ${toolActivityDetail(tu.name!, tu.input)}`, null, JSON.stringify({ args: tu.input, ok: r.ok, result: out }));
        return { type: 'tool_result' as const, tool_use_id: tu.id!, content: out };
      }));
      messages.push({ role: 'user', content: toolResults });
    }

    // Persist any KB writes, refresh the live preview, and publish the site.
    if (wrote) {
      deps.saveFiles(files);
      deps.broadcast({ type: 'files-synced', count: files.size });
      deps.publishKb(); // republish the shareable Zensical site (non-blocking)
    }
    return save(deps, text || 'Done.', Date.now());
  } catch (err) {
    if (wrote) { deps.saveFiles(files); deps.broadcast({ type: 'files-synced', count: files.size }); }
    return save(deps, `I had trouble with that. Error: ${err instanceof Error ? err.message : 'unknown'}`, Date.now());
  }
}
