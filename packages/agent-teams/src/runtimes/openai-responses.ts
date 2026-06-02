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
        instructions: ctx.role.systemPromptOverride ?? buildDefaultPrompt(ctx.role.role),
        spineTools: ctx.role.spineTools,
        previousResponseId: null,
        projectId: ctx.projectId,
        ticketId: ctx.ticketId,
        userToken: ctx.userToken,
        dispatch: ctx.dispatch,
      },
    };
  }

  async *run(handle: RuntimeHandle, messages: Message[]): AsyncIterable<StreamEvent> {
    const s = handle.state as {
      apiKey: string;
      model: string;
      instructions: string;
      spineTools: string[];
      previousResponseId: string | null;
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
      yield { type: 'heartbeat' };

      const body: Record<string, unknown> = {
        model: s.model,
        input,
        instructions: s.instructions,
        tools: tools.length > 0 ? tools : undefined,
        store: true,
      };
      if (s.previousResponseId) {
        body.previous_response_id = s.previousResponseId;
      }

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Sanitize error — never expose raw upstream response (may contain API key)
        const safeError = res.status === 401 ? 'API authentication failed — check your API key'
          : res.status === 429 ? 'Rate limited — retry later'
          : res.status === 400 ? 'Invalid request to AI provider'
          : `AI provider error (${res.status})`;
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
        const call: ToolCall = {
          id: fc.id,
          name: fc.name,
          args: JSON.parse(fc.arguments),
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
    case 'BA':
      return 'You are a Business Analyst. Take the PO\'s raw idea and produce a structured spec with acceptance criteria, SDK primitives needed, files to create, and what\'s out of scope.';
    case 'Dev':
      return 'You are a Developer building a ProAppStore app. Use @proappstore/sdk for auth, database, storage, rooms. Tech stack: React + Vite + TypeScript + Tailwind. Build exactly what the spec says. Author ALL files first, then call provision_app once to create the repo and push your code (the deploy step); use get_deploy_status to confirm.';
    case 'QA':
      return 'You are a QA Engineer. Verify the ticket\'s acceptance criteria are met. Check error handling, imports, accessibility, dark mode, mobile responsiveness. Report PASS or FAIL.';
  }
}

function nameToOAITool(name: string): OAIFunctionTool {
  // Same tool definitions as cf-native, formatted for OpenAI
  const defs: Record<string, { description: string; parameters: Record<string, unknown> }> = {
    scaffold_app: {
      description: 'Create a new PAS app from template with GitHub repo and platform resources.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID (lowercase)' },
          name: { type: 'string', description: 'Display name' },
          description: { type: 'string', description: 'Short description' },
        },
        required: ['app_id', 'name', 'description'],
        additionalProperties: false,
      },
    },
    write_file: {
      description: 'Create or overwrite a file in the app GitHub repo.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['app_id', 'path', 'content'],
        additionalProperties: false,
      },
    },
    read_file: {
      description: 'Read a file from the app GitHub repo.',
      parameters: {
        type: 'object',
        properties: { app_id: { type: 'string' }, path: { type: 'string' } },
        required: ['app_id', 'path'],
        additionalProperties: false,
      },
    },
    list_files: {
      description: 'List files in the app GitHub repo.',
      parameters: {
        type: 'object',
        properties: { app_id: { type: 'string' }, path: { type: 'string' } },
        required: ['app_id'],
        additionalProperties: false,
      },
    },
    search_files: {
      description: 'Search for text across all files in the app repo.',
      parameters: {
        type: 'object',
        properties: { app_id: { type: 'string' }, query: { type: 'string' } },
        required: ['app_id', 'query'],
        additionalProperties: false,
      },
    },
    batch_write_files: {
      description: 'Write multiple files in a single commit.',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
          message: { type: 'string' },
        },
        required: ['app_id', 'files', 'message'],
        additionalProperties: false,
      },
    },
    get_deploy_status: {
      description: 'Check GitHub Actions deploy status.',
      parameters: { type: 'object', properties: { app_id: { type: 'string' } }, required: ['app_id'], additionalProperties: false },
    },
    provision_app: {
      description: 'Provision CF Pages, D1, DNS for an app.',
      parameters: { type: 'object', properties: { app_id: { type: 'string' } }, required: ['app_id'], additionalProperties: false },
    },
  };

  const def = defs[name];
  return {
    type: 'function',
    name,
    description: def?.description ?? `Tool: ${name}`,
    parameters: def?.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  };
}
