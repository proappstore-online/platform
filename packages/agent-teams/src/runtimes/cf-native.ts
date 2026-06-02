/**
 * CFNativeRuntime — Anthropic Messages API with tool loop.
 * Runs entirely in the CF Worker (no subprocess, no Agent SDK).
 * Uses @anthropic-ai/sdk for HTTP calls to the Messages API.
 */

import type {
  AgentRuntime,
  Message,
  PrepareContext,
  Role,
  RuntimeHandle,
  StreamEvent,
  ToolCall,
  ToolResult,
} from '../types.ts';
import { dispatchTool, isAllowedTool } from '../tool-dispatch.ts';
import { TOOL_SCHEMAS } from '../tool-schemas.ts';
import { PLATFORM_CAPABILITIES } from '../platform-skill.ts';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent[];
}

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  content: AnthropicContent[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

const MAX_ITERATIONS = 25;

// Pricing per 1M tokens (approximate, June 2026). Unknown models fall back to
// Sonnet pricing for the cost meter.
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

export class CFNativeRuntime implements AgentRuntime {
  async prepare(ctx: PrepareContext): Promise<RuntimeHandle> {
    return {
      runtime: 'cf-native',
      state: {
        apiKey: ctx.byoKey,
        model: ctx.role.model,
        maxTokens: ctx.role.maxTokens ?? 16384,
        // Persona ("soul") + role prompt + the platform capabilities reference.
        // All stable across the run → lands in the cached system block.
        systemPrompt: [ctx.role.persona, ctx.role.systemPromptOverride ?? buildDefaultPrompt(ctx.role.role), PLATFORM_CAPABILITIES].filter(Boolean).join('\n\n'),
        spineTools: ctx.role.spineTools,
        projectId: ctx.projectId,
        ticketId: ctx.ticketId,
        userToken: ctx.userToken,
        dispatch: ctx.dispatch,
      },
    };
  }

  async *run(handle: RuntimeHandle, messages: Message[]): AsyncIterable<StreamEvent> {
    const { apiKey, model, maxTokens, systemPrompt, spineTools } = handle.state as {
      apiKey: string;
      model: string;
      maxTokens: number;
      systemPrompt: string;
      spineTools: string[];
    };

    // Convert message history to Anthropic format
    const anthropicMessages = messagesToAnthropic(messages);

    // Build tool definitions from spine tool names
    const tools = spineTools.map(nameToToolDef);

    let totalIn = 0;
    let totalOut = 0;

    const cache = { type: 'ephemeral' as const };
    const reqBody = (msgs: AnthropicMessage[]) => {
      // Prompt caching: mark the system prompt, the tool block, and the last
      // message's last block as cache breakpoints (≤4 allowed). The system +
      // tools are stable across the whole run, and the rolling breakpoint on the
      // last message caches the growing prefix (incl. re-read file contents in
      // tool_results), cutting input-token cost ~90% on hits (5-min TTL).
      const cachedTools = tools.length > 0
        ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: cache } : t))
        : undefined;
      let cachedMsgs: unknown[] = msgs;
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1]!;
        const content = typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }]
          : last.content;
        if (Array.isArray(content) && content.length > 0) {
          const blocks = content.map((b, i) => (i === content.length - 1 ? { ...b, cache_control: cache } : b));
          cachedMsgs = [...msgs.slice(0, -1), { ...last, content: blocks }];
        }
      }
      return JSON.stringify({
        // Per-role output budget (configurable in the console agent settings).
        // STREAMED — a 16k-token non-streamed completion can exceed Cloudflare's
        // ~100s edge timeout and fail with 524; streaming flushes the first byte
        // immediately so the long generation never trips the timeout.
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: cache }],
        tools: cachedTools,
        messages: cachedMsgs,
        stream: true,
      });
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      yield { type: 'heartbeat' };

      // Open the request, retrying transient failures (429, 5xx incl. CF 524).
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: reqBody(anthropicMessages),
        });
        if (res.ok) break;
        const transient = res.status === 429 || res.status >= 500;
        if (!transient || attempt === 2) {
          const safeError = res.status === 401 ? 'API authentication failed — check your API key'
            : res.status === 429 ? 'Rate limited — retry later'
            : res.status === 400 ? 'Invalid request to AI provider'
            : res.status === 524 || res.status === 504 ? 'AI provider timed out — try again or lower this role’s max tokens'
            : `AI provider error (${res.status})`;
          yield { type: 'error', message: safeError, retryable: transient };
          return;
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
      if (!res || !res.body) { yield { type: 'error', message: 'No response stream from AI provider', retryable: true }; return; }

      // Parse the Anthropic SSE stream into a response (content blocks + stop_reason).
      const response = yield* this.parseStream(res.body);
      totalIn += response.usage.input_tokens;
      totalOut += response.usage.output_tokens;

      // Append assistant response to conversation (text already emitted live).
      anthropicMessages.push({ role: 'assistant', content: response.content });

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

      // No tool calls this turn.
      if (toolUseBlocks.length === 0) {
        // The model ran out of output budget mid-thought — it narrated intent
        // ("now I'll write the files…") but was truncated before emitting the
        // tool calls. Don't end the run on a truncation: nudge it to continue.
        // This is the fix for agents "going in circles" — planning/reading
        // forever and never writing because the run kept ending prematurely.
        if (response.stop_reason === 'max_tokens') {
          anthropicMessages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
          continue;
        }
        // Genuine end_turn — the agent is finished.
        yield {
          type: 'done',
          costUsd: estimateCost(model, totalIn, totalOut),
          tokensIn: totalIn,
          tokensOut: totalOut,
        };
        return;
      }

      // Process tool calls (covers both a normal 'tool_use' stop and a
      // 'max_tokens' turn that still completed at least one tool call).
      const toolResults: AnthropicContent[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const call: ToolCall = {
            id: block.id,
            name: block.name,
            args: block.input,
          };
          yield { type: 'tool-call', call };

          // Tool execution happens in the DO — yield and wait for result
          const result = await this.invokeTool(handle, call);
          yield { type: 'tool-result', result };

          // Anthropic rejects empty tool_result content with a 400, so coalesce
          // empty output (e.g. an empty file list) to a placeholder.
          const resultText = result.ok
            ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
            : (result.errorMessage ?? 'Tool execution failed');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultText || '(no output)',
          });
        }
      }

      // Feed results back
      anthropicMessages.push({ role: 'user', content: toolResults });
    }

    yield { type: 'error', message: `Max iterations (${MAX_ITERATIONS}) reached`, retryable: false };
    yield { type: 'done', costUsd: estimateCost(model, totalIn, totalOut), tokensIn: totalIn, tokensOut: totalOut };
  }

  /**
   * Parse the Anthropic Messages SSE stream into a complete response. Emits
   * text-delta events live as tokens arrive; assembles text + tool_use blocks
   * (tool input from concatenated input_json_delta) and the final stop_reason.
   */
  private async *parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent, AnthropicResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const content: AnthropicContent[] = [];
    const partialJson: Record<number, string> = {};
    let stopReason: AnthropicResponse['stop_reason'] = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(data); } catch { continue; }

        switch (ev.type) {
          case 'message_start': {
            const u = (ev.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } })?.usage;
            // Count cached reads + cache writes toward input so the cost meter
            // reflects total tokens processed (Anthropic reports them separately).
            if (u) inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            break;
          }
          case 'content_block_start': {
            const idx = ev.index as number;
            const cb = ev.content_block as { type: string; id?: string; name?: string; text?: string };
            if (cb.type === 'text') content[idx] = { type: 'text', text: cb.text ?? '' };
            else if (cb.type === 'tool_use') { content[idx] = { type: 'tool_use', id: cb.id!, name: cb.name!, input: {} }; partialJson[idx] = ''; }
            break;
          }
          case 'content_block_delta': {
            const idx = ev.index as number;
            const d = ev.delta as { type: string; text?: string; partial_json?: string };
            if (d.type === 'text_delta') {
              const b = content[idx];
              if (b?.type === 'text') b.text += d.text ?? '';
              if (d.text) yield { type: 'text-delta', text: d.text };
            } else if (d.type === 'input_json_delta') {
              partialJson[idx] = (partialJson[idx] ?? '') + (d.partial_json ?? '');
            }
            break;
          }
          case 'content_block_stop': {
            const idx = ev.index as number;
            const b = content[idx];
            if (b?.type === 'tool_use') {
              try { b.input = JSON.parse(partialJson[idx] || '{}'); } catch { b.input = {}; }
            }
            break;
          }
          case 'message_delta': {
            const delta = ev.delta as { stop_reason?: AnthropicResponse['stop_reason'] };
            if (delta?.stop_reason) stopReason = delta.stop_reason;
            const u = ev.usage as { output_tokens?: number } | undefined;
            if (u?.output_tokens != null) outputTokens = u.output_tokens; // cumulative
            break;
          }
        }
      }
    }

    return {
      id: 'stream',
      content: content.filter(Boolean),
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      model: '',
    };
  }

  async invokeTool(handle: RuntimeHandle, toolCall: ToolCall): Promise<ToolResult> {
    const s = handle.state as {
      spineTools: string[];
      userToken?: string;
      dispatch?: (call: ToolCall) => Promise<ToolResult>;
    };
    if (!isAllowedTool(toolCall.name, s.spineTools)) {
      return {
        callId: toolCall.id,
        ok: false,
        errorMessage: `Tool "${toolCall.name}" not in allowed spine tools for this role`,
        durationMs: 0,
      };
    }
    if (s.dispatch) return s.dispatch(toolCall);
    return dispatchTool(toolCall, s.userToken ?? null);
  }

  async terminate(_handle: RuntimeHandle): Promise<{ costUsd: number; tokensIn: number; tokensOut: number }> {
    return { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function messagesToAnthropic(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const msg of messages) {
    const role = msg.author === 'po' || msg.author === 'system' ? 'user' : 'assistant';
    const content: AnthropicContent[] = [{ type: 'text', text: msg.body }];

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        if (tc.result) {
          // Tool results go in the next user message
          result.push({ role, content });
          result.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: tc.id,
              content: tc.result.ok
                ? (typeof tc.result.data === 'string' ? tc.result.data : JSON.stringify(tc.result.data))
                : (tc.result.errorMessage ?? 'failed'),
            }],
          });
          continue;
        }
      }
    }

    result.push({ role, content });
  }
  return result;
}

function buildDefaultPrompt(role: Role): string {
  switch (role) {
    case 'BA':
      return `You are a Business Analyst for a ProAppStore app project.
Your job: take the PO's raw idea and produce a structured specification.
Output a spec with: summary, acceptance criteria (testable checklist),
SDK primitives needed, files to create, and what's out of scope.
Be specific. Be concise. Challenge vague requirements.`;

    case 'Dev':
      return `You are a Developer building a ProAppStore app.
Use the PAS SDK (@proappstore/sdk) for auth, database, storage, rooms, maps, AI, etc.
Tech stack: React + Vite + TypeScript + Tailwind CSS.
Read the ticket spec carefully. Build exactly what's specified.
Use batch_write_files for efficiency. Follow platform conventions from skills.md.
Author ALL files first, then call provision_app once to create the repo and push
your code (that is the deploy step). Use get_deploy_status to confirm.`;

    case 'QA':
      return `You are a QA Engineer reviewing a ProAppStore app.
Your job: verify the ticket's acceptance criteria are met.
Read the code. Check for: missing error handling, broken imports,
unused variables, accessibility issues, dark mode support,
mobile responsiveness, and SDK usage correctness.
Report PASS or FAIL with specific findings.`;
  }
}

function nameToToolDef(name: string): AnthropicTool {
  const def = TOOL_SCHEMAS[name];
  if (!def) return { name, description: `Tool: ${name}`, input_schema: { type: 'object', properties: {} } };
  return { name, description: def.description, input_schema: def.parameters };
}
