/**
 * OpenAIResponsesRuntime — OpenAI Responses API adapter.
 * Uses previous_response_id for multi-turn, function tools for agent actions.
 * Pure fetch — no SDK dependency.
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

interface OAIFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

interface OAIInputMessage {
  role: 'user' | 'assistant' | 'developer';
  content: string;
}

interface OAIFunctionCallInput {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

interface OAIFunctionCallOutputInput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type OAIInputItem = OAIInputMessage | OAIFunctionCallInput | OAIFunctionCallOutputInput;

interface OAIOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  content: { type: 'output_text'; text: string }[];
}

interface OAIOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

type OAIOutputItem = OAIOutputMessage | OAIOutputFunctionCall;

interface OAIResponse {
  id: string;
  status: string;
  output: OAIOutputItem[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

const MAX_ITERATIONS = 25;

// Pricing per 1M tokens (approximate, June 2026)
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o3-mini': { input: 1.1, output: 4.4 },
};

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = PRICING[model] ?? PRICING['gpt-4o']!;
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

export class OpenAIResponsesRuntime implements AgentRuntime {
  async prepare(ctx: PrepareContext): Promise<RuntimeHandle> {
    return {
      runtime: 'openai-responses',
      state: {
        apiKey: ctx.byoKey,
        model: ctx.role.model,
        maxTokens: ctx.role.maxTokens ?? 16384,
        instructions: [ctx.role.persona, ctx.role.systemPromptOverride ?? buildDefaultPrompt(ctx.role.role), PLATFORM_CAPABILITIES].filter(Boolean).join('\n\n'),
        spineTools: ctx.role.spineTools,
        previousResponseId: null,
        projectId: ctx.projectId,
        ticketId: ctx.ticketId,
        userToken: ctx.userToken,
        dispatch: ctx.dispatch,
        // AI Gateway routing (falls back to the OpenAI public API when unset).
        baseUrl: ctx.gateway?.baseUrl ?? 'https://api.openai.com/v1',
        gatewayHeaders: ctx.gateway?.headers ?? {},
      },
    };
  }

  async *run(handle: RuntimeHandle, messages: Message[], signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const s = handle.state as {
      apiKey: string;
      model: string;
      maxTokens: number;
      instructions: string;
      spineTools: string[];
      previousResponseId: string | null;
      baseUrl: string;
      gatewayHeaders: Record<string, string>;
    };

    const tools: OAIFunctionTool[] = s.spineTools.map(nameToOAITool);

    // Build input from message history (or use previous_response_id)
    let input: string | OAIInputItem[];
    if (s.previousResponseId) {
      // Use the last message as new input, chain via previous_response_id
      const lastMsg = messages[messages.length - 1];
      input = lastMsg?.body ?? '';
    } else {
      // First turn — send full history
      input = messages.map((m): OAIInputMessage => ({
        role: m.author === 'po' ? 'user' : m.author === 'system' ? 'developer' : 'assistant',
        content: m.body,
      }));
    }

    let totalIn = 0;
    let totalOut = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Carry the running cost on the heartbeat so the console's live cost tile
      // updates mid-run. Without this, agent-runner reads `ev.costUsd ?? 0` and
      // broadcasts $0.00 every heartbeat until 'done' (mirrors cf-native).
      yield { type: 'heartbeat', costUsd: estimateCost(s.model, totalIn, totalOut), tokensIn: totalIn, tokensOut: totalOut };

      const body: Record<string, unknown> = {
        model: s.model,
        input,
        instructions: s.instructions,
        tools: tools.length > 0 ? tools : undefined,
        max_output_tokens: s.maxTokens,
        store: true,
      };
      if (s.previousResponseId) {
        body.previous_response_id = s.previousResponseId;
      }

      const res = await fetch(`${s.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          ...s.gatewayHeaders,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });

      if (!res.ok) {
        // Extract the upstream error detail (OpenAI returns { error: { message } }).
        let detail = '';
        try { const b = await res.json() as { error?: { message?: string } }; detail = b?.error?.message ?? ''; } catch { /* body not JSON */ }
        const viaGateway = s.baseUrl.includes('gateway.ai.cloudflare.com');
        const safeError = res.status === 401 || res.status === 403 ? (viaGateway
            ? `Auth rejected (${res.status}) via AI Gateway — check your OpenAI key in Profile → API Keys, or the gateway token if the gateway is authenticated${detail ? `: ${detail}` : ''}`
            : 'API key rejected — check your OpenAI API key in Profile → API Keys')
          : res.status === 429 ? `Rate limited (429)${viaGateway ? ' by AI Gateway/OpenAI' : ' by OpenAI'} — retry in a minute`
          : res.status === 400 ? `OpenAI error: ${detail || "bad request (400)"}`
          : `${viaGateway ? 'AI Gateway/OpenAI' : 'OpenAI'} error ${res.status}${detail ? `: ${detail}` : ''}`;
        yield { type: 'error', message: safeError, retryable: res.status >= 500 };
        return;
      }

      const response = (await res.json()) as OAIResponse;
      totalIn += response.usage.input_tokens;
      totalOut += response.usage.output_tokens;

      // Save response ID for next turn
      s.previousResponseId = response.id;

      // Emit text
      for (const item of response.output) {
        if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type === 'output_text') {
              yield { type: 'text-delta', text: part.text };
            }
          }
        }
      }

      // Check for function calls
      const functionCalls = response.output.filter(
        (item): item is OAIOutputFunctionCall => item.type === 'function_call',
      );

      if (functionCalls.length === 0) {
        // Truncated mid-thought (ran out of output budget before emitting tool
        // calls)? Don't end the run — nudge it to continue. Mirrors the cf-native
        // fix for agents that plan/read forever and never write.
        if (response.status === 'incomplete') {
          input = [{ role: 'user', content: 'Continue.' }];
          continue;
        }
        yield {
          type: 'done',
          costUsd: estimateCost(s.model, totalIn, totalOut),
          tokensIn: totalIn,
          tokensOut: totalOut,
        };
        return;
      }

      // Execute tool calls and build new input
      const newInput: OAIInputItem[] = [];
      for (const fc of functionCalls) {
        // Parse defensively: the model can emit a zero-arg call as arguments:""
        // or truncated/invalid JSON. An unguarded JSON.parse throws out of this
        // generator, aborting the whole run mid-loop (no terminal 'done' event,
        // cost lost) — cf-native tolerates the same case. Default to no args.
        let args: Record<string, unknown> = {};
        try {
          if (fc.arguments && fc.arguments.trim()) args = JSON.parse(fc.arguments);
        } catch {
          args = {};
        }
        const call: ToolCall = {
          id: fc.id,
          name: fc.name,
          args,
        };
        yield { type: 'tool-call', call };

        const result = await this.invokeTool(handle, call);
        yield { type: 'tool-result', result };

        // Add function_call + output to input
        newInput.push({
          type: 'function_call',
          id: fc.id,
          call_id: fc.call_id,
          name: fc.name,
          arguments: fc.arguments,
        });
        newInput.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: result.ok
            ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? ''))
            : JSON.stringify({ error: result.errorMessage }),
        });
      }

      // Next iteration chains via previous_response_id
      input = newInput;
    }

    yield { type: 'error', message: `Max iterations (${MAX_ITERATIONS}) reached`, retryable: false };
    yield { type: 'done', costUsd: estimateCost(s.model, totalIn, totalOut), tokensIn: totalIn, tokensOut: totalOut };
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

function buildDefaultPrompt(role: Role): string {
  switch (role) {
    case 'Architect':
      return 'You are the Architect. Before the team builds, research the app and write its Knowledge Base — KNOWLEDGE.md (+ docs/) covering what the app is, users, scope + non-goals, data model, the EXACT @proappstore/sdk primitives/signatures (confirm via read_docs), design conventions, and the quality bar. Write ONLY KNOWLEDGE.md and docs/ — never app source (src/).';
    case 'BA':
      return 'You are a Business Analyst. Take the PO\'s raw idea and produce a structured spec with acceptance criteria, SDK primitives needed, files to create, and what\'s out of scope.';
    case 'Dev':
      return 'You are a Developer building a ProAppStore app. Use @proappstore/sdk for auth, database, storage, rooms. Tech stack: React + Vite + TypeScript + Tailwind. Build exactly what the spec says, type-correct (must pass tsc). You do NOT deploy — the system pushes and verifies the CI build automatically after QA approves, and sends the ticket back to you with the compiler error if it fails.';
    case 'QA':
      return 'You are a QA Engineer. Verify the ticket\'s acceptance criteria are met. Check error handling, imports, accessibility, dark mode, mobile responsiveness. Report PASS or FAIL.';
  }
}

function nameToOAITool(name: string): OAIFunctionTool {
  const def = TOOL_SCHEMAS[name];
  return {
    type: 'function',
    name,
    description: def?.description ?? `Tool: ${name}`,
    parameters: def?.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    // strict requires every property in `required`; some tools have optional
    // fields (e.g. write_file.message), so strict:true 400s. Keep loose.
    strict: false,
  };
}
