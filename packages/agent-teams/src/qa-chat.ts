/**
 * QA chat handler (the "test" thread) — an AI-powered QA engineer. Uses the
 * owner's BYO Anthropic key (same path as Dev/BA/Architect) to turn done tickets
 * + the KB + app source into real Playwright specs, WRITING them to e2e/specs/*
 * via the file tools. Extracted from ProjectDO; the DO passes a deps object
 * (storage + the callbacks this needs) — the explicit deps list is the honest
 * coupling surface, matching handlePOChat / handleArchitectChat.
 */

import type { Bindings } from './bindings.ts';
import { json, insertChatMessage } from './store.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { resolveByoKey } from './byo-key.ts';
import { parseAnthropicStream } from './runtimes/cf-native-stream.ts';
import { executeFileTool } from './spine.ts';
import { toolActivityDetail } from './tool-activity.ts';

export interface QaChatDeps {
  sql: SqlStorage;
  env: Bindings;
  touchUserActivity(): void;
  broadcast(event: Record<string, unknown>): void;
  loadFiles(): Map<string, string>;
  saveFiles(files: Map<string, string>): void;
  logActivity(type: string, detail: string, ticketId?: string | null, meta?: string): string;
}

export async function handleQAChat(deps: QaChatDeps, request: Request): Promise<Response> {
  const { sql, env } = deps;
  const body = (await request.json()) as { message: string; thread?: string };
  if (!body.message?.trim()) return json({ error: 'message required' }, 400);
  if (body.message.length > 8192) return json({ error: 'message too long (max 8KB)' }, 413);

  const thread = 'test';
  const userText = body.message.trim();
  const now = Date.now();
  deps.touchUserActivity();

  // Save user message
  const userMsgId = insertChatMessage(sql, { role: 'user', body: userText, at: now, thread });
  deps.broadcast({ type: 'chat', thread, role: 'user', body: userText, id: userMsgId });

  // Resolve the BYO API key (same path as Dev/BA/Architect)
  const proj = sql
    .exec('SELECT owner_id, slug, name FROM project LIMIT 1')
    .toArray()[0] as { owner_id: string; slug: string; name: string } | undefined;

  let apiKey: string | undefined;
  if (proj) apiKey = (await resolveByoKey(env, proj.owner_id, 'anthropic')) ?? undefined;

  // Gather context
  const doneTickets = sql
    .exec("SELECT title, raw_idea, spec_json FROM tickets WHERE status = 'done' ORDER BY updated_at DESC LIMIT 20")
    .toArray() as { title: string; raw_idea: string; spec_json: string | null }[];

  const kbFile = sql
    .exec("SELECT content FROM project_files WHERE path = 'KNOWLEDGE.md' LIMIT 1")
    .toArray()[0] as { content: string } | undefined;

  const existingSpecs = sql
    .exec("SELECT path, content FROM project_files WHERE path LIKE 'e2e/specs/%'")
    .toArray() as { path: string; content: string }[];

  const appFiles = sql
    .exec("SELECT path FROM project_files WHERE path LIKE 'src/%' ORDER BY path")
    .toArray() as { path: string }[];

  // If no API key, fall back to rule-based
  if (!apiKey) {
    const hint = proj ? `(owner ${proj.owner_id})` : '';
    const reply = `I need an Anthropic API key to generate real Playwright tests. Add one in your Profile. ${hint}\n\nIn the meantime, here's a summary: ${doneTickets.length} done tickets, ${existingSpecs.length} e2e spec file(s).`;
    const replyId = insertChatMessage(sql, { role: 'QA', body: reply, at: Date.now(), thread });
    deps.broadcast({ type: 'chat', thread, role: 'QA', body: reply, id: replyId });
    return json({ id: replyId, role: 'QA', body: reply, createdAt: Date.now() });
  }

  // Build context for the LLM
  const ticketSummaries = doneTickets.map(t => {
    let ac = '';
    if (t.spec_json) {
      try {
        const s = JSON.parse(t.spec_json);
        ac = s.summary || (Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.join('; ') : s.acceptanceCriteria) || '';
      } catch { /* */ }
    }
    return `- ${t.title}${ac ? `\n  Spec: ${ac}` : ''}`;
  }).join('\n');

  const existingSpecNames = existingSpecs.map(s => s.path).join(', ') || 'none';
  const appFileList = appFiles.map(f => f.path).join('\n');

  const systemPrompt = `You are a QA engineer for a ProAppStore web app called "${proj?.name ?? 'app'}" (slug: ${proj?.slug ?? 'app'}).
Your job is to generate Playwright end-to-end test specifications and WRITE THEM TO FILES.

The app is deployed at https://${proj?.slug ?? 'app'}.proappstore.online/
Test files go in e2e/specs/*.spec.ts using Playwright Test.
The test fixture at e2e/fixtures.ts provides an \`app\` fixture (a Playwright Page navigated to the app URL).

Done tickets (features to test):
${ticketSummaries || '(none)'}

${kbFile ? `Knowledge Base:\n${kbFile.content.slice(0, 3000)}` : ''}

Existing e2e specs: ${existingSpecNames}
App source files:\n${appFileList}

IMPORTANT: When generating tests, use the write_file or batch_write_files tool to SAVE them to e2e/specs/.
Do NOT just output code in chat — write it to files so it can be run.
When asked about coverage, analyze what's tested vs what's not.
Be concise. Write the files first, then briefly summarize what you wrote.`;

  const recentChat = sql
    .exec("SELECT role, body FROM chat_history WHERE thread = 'test' ORDER BY created_at DESC LIMIT 10")
    .toArray()
    .reverse()
    .map((r) => ({ role: r.role as string, body: r.body as string }));

  const messages: { role: 'user' | 'assistant'; content: unknown }[] = recentChat.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'assistant' as const,
    content: m.body as unknown,
  }));

  // QA tools: read + write e2e specs, read app source
  const tools = (['write_file', 'batch_write_files', 'read_file', 'list_files', 'search_files'] as const).map((name) => ({
    name, description: TOOL_SCHEMAS[name]!.description, input_schema: TOOL_SCHEMAS[name]!.parameters,
  }));

  const files = deps.loadFiles();
  let wrote = false;

  try {
    let reply = '';
    for (let turn = 0; turn < 10; turn++) {
      deps.broadcast({ type: 'agent-heartbeat', role: 'QA' });
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8192, system: systemPrompt, tools, messages, stream: true }),
      });

      if (!res.ok) {
        let detail = '';
        try { const t = await res.text(); const b = JSON.parse(t) as { error?: { message?: string } }; detail = b?.error?.message ?? t.slice(0, 200); } catch { /* */ }
        const safe = res.status === 401 ? 'API key rejected - check Profile > API Keys'
          : res.status === 429 ? 'Rate limited - wait a moment'
          : `Anthropic error: ${detail || `status ${res.status}`}`;
        const r = `Sorry: ${safe}`;
        const rid = insertChatMessage(sql, { role: 'QA', body: r, at: Date.now(), thread });
        deps.broadcast({ type: 'chat', thread, role: 'QA', body: r, id: rid });
        return json({ id: rid, role: 'QA', body: r, createdAt: Date.now() });
      }
      if (!res.body) break;

      const stream = parseAnthropicStream(res.body);
      let sr = await stream.next();
      while (!sr.done) {
        if (sr.value.type === 'text-delta') deps.broadcast({ type: 'agent-text', role: 'QA', text: sr.value.text });
        sr = await stream.next();
      }
      const aiRes = sr.value;
      const contentArr = aiRes.content;
      messages.push({ role: 'assistant', content: contentArr });
      reply = (contentArr as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('');

      const toolUses = contentArr.filter(c => c.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: unknown }[];
      if (toolUses.length === 0 || aiRes.stop_reason !== 'tool_use') break;

      const toolResults = toolUses.map(tu => {
        const r = executeFileTool({ id: tu.id, name: tu.name, args: tu.input }, files);
        if (r.ok && (tu.name === 'write_file' || tu.name === 'batch_write_files')) wrote = true;
        deps.logActivity('tool', `QA: ${toolActivityDetail(tu.name, tu.input)}`, null, JSON.stringify({ args: tu.input, ok: r.ok, result: r.ok ? r.data : r.errorMessage }));
        return { type: 'tool_result' as const, tool_use_id: tu.id, content: (r.ok ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : (r.errorMessage ?? 'error')) || '(no output)' };
      });
      messages.push({ role: 'user', content: toolResults });
    }

    if (wrote) { deps.saveFiles(files); deps.broadcast({ type: 'files-synced', count: files.size }); }
    reply = reply || 'Done.';
    const replyId = insertChatMessage(sql, { role: 'QA', body: reply, at: Date.now(), thread });
    deps.broadcast({ type: 'chat', thread, role: 'QA', body: reply, id: replyId });
    return json({ id: replyId, role: 'QA', body: reply, createdAt: Date.now() });
  } catch (err) {
    if (wrote) { deps.saveFiles(files); deps.broadcast({ type: 'files-synced', count: files.size }); }
    const reply = `Error: ${err instanceof Error ? err.message : String(err)}`;
    const replyId = insertChatMessage(sql, { role: 'QA', body: reply, at: Date.now(), thread });
    deps.broadcast({ type: 'chat', thread, role: 'QA', body: reply, id: replyId });
    return json({ id: replyId, role: 'QA', body: reply, createdAt: Date.now() });
  }
}
