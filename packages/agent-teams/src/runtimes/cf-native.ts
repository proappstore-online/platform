/**
 * CFNativeRuntime — Anthropic Messages API with tool loop.
 * Runs entirely in the CF Worker (no subprocess, no Agent SDK).
 * Uses @anthropic-ai/sdk for HTTP calls to the Messages API.
 */

import type {
  AgentRuntime,
  Message,
  PrepareContext,
  RuntimeHandle,
  StreamEvent,
  ToolCall,
  ToolResult,
} from '../types.ts';
import { dispatchTool, isAllowedTool } from '../tool-dispatch.ts';
import { PLATFORM_CAPABILITIES } from '../platform-skill.ts';
import type { AnthropicContent, AnthropicMessage } from './cf-native-types.ts';
import { estimateCost } from './cf-native-pricing.ts';
import { buildDefaultPrompt } from './cf-native-prompt.ts';
import { messagesToAnthropic, nameToToolDef, trimConversation } from './cf-native-helpers.ts';
import { parseAnthropicStream } from './cf-native-stream.ts';

const MAX_ITERATIONS = 25;

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

  async *run(handle: RuntimeHandle, messages: Message[], signal?: AbortSignal): AsyncIterable<StreamEvent> {
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
      yield { type: 'heartbeat', costUsd: estimateCost(model, totalIn, totalOut), tokensIn: totalIn, tokensOut: totalOut };

      // Guard: trim old tool results if the conversation is too large for the
      // model's context window. Keep the last 2 turns intact; older tool_result
      // blocks are truncated to a short summary. Prevents the 400 "prompt too
      // long" error that kills the run on iteration-heavy tickets.
      trimConversation(anthropicMessages);

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
          signal: signal ?? null,
        });
        if (res.ok) break;
        const transient = res.status === 429 || res.status >= 500;
        if (!transient || attempt === 2) {
          // Extract the upstream error detail (Anthropic returns { error: { message } }).
          // Never log the raw body (may echo request with key); just the message field.
          let detail = "";
          try { const b = await res.json() as { error?: { message?: string } }; detail = b?.error?.message ?? ""; } catch { /* body not JSON */ }
          const safeError = res.status === 401 ? "API key rejected - check your Anthropic API key in Profile > API Keys"
            : res.status === 429 ? "Rate limited by Anthropic - retry in a minute"
            : res.status === 400 ? `Anthropic error: ${detail || "bad request (400)"}`
            : res.status === 524 || res.status === 504 ? `Anthropic timed out (${res.status}) - try again or lower max tokens in Settings > Agents`
            : `Anthropic error ${res.status}${detail ? ": " + detail : ""}`;
          yield { type: 'error', message: safeError, retryable: transient };
          return;
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
      if (!res || !res.body) { yield { type: 'error', message: 'No response stream from AI provider', retryable: true }; return; }

      // Parse the Anthropic SSE stream into a response (content blocks + stop_reason).
      const response = yield* parseAnthropicStream(res.body);
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

      // Feed results back. If we're running hot on context, warn the model.
      if (totalIn > 120_000) {
        toolResults.push({ type: 'text', text: `[SYSTEM: You have used ${Math.round(totalIn / 1000)}k input tokens. Finish your current task and stop — do NOT start reading more files. Write what you have and end your turn.]` } as AnthropicContent);
      }
      anthropicMessages.push({ role: 'user', content: toolResults });
    }

    yield { type: 'error', message: `Max iterations (${MAX_ITERATIONS}) reached`, retryable: false };
    yield { type: 'done', costUsd: estimateCost(model, totalIn, totalOut), tokensIn: totalIn, tokensOut: totalOut };
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
