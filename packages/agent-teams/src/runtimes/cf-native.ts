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

// Pricing per 1M tokens (approximate, June 2026)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 15, output: 75 },
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
        systemPrompt: ctx.role.systemPromptOverride ?? buildDefaultPrompt(ctx.role.role),
        spineTools: ctx.role.spineTools,
        projectId: ctx.projectId,
        ticketId: ctx.ticketId,
        userToken: ctx.userToken,
        dispatch: ctx.dispatch,
      },
    };
  }

  async *run(handle: RuntimeHandle, messages: Message[]): AsyncIterable<StreamEvent> {
    const { apiKey, model, systemPrompt, spineTools } = handle.state as {
      apiKey: string;
      model: string;
      systemPrompt: string;
      spineTools: string[];
    };

    // Convert message history to Anthropic format
    const anthropicMessages = messagesToAnthropic(messages);

    // Build tool definitions from spine tool names
    const tools = spineTools.map(nameToToolDef);

    let totalIn = 0;
    let totalOut = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      yield { type: 'heartbeat' };

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          messages: anthropicMessages,
        }),
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

      const response = (await res.json()) as AnthropicResponse;
      totalIn += response.usage.input_tokens;
      totalOut += response.usage.output_tokens;

      // Append assistant response to conversation
      anthropicMessages.push({ role: 'assistant', content: response.content });

      // Emit text deltas
      for (const block of response.content) {
        if (block.type === 'text') {
          yield { type: 'text-delta', text: block.text };
        }
      }

      // If no tool use, we're done
      if (response.stop_reason !== 'tool_use') {
        yield {
          type: 'done',
          costUsd: estimateCost(model, totalIn, totalOut),
          tokensIn: totalIn,
          tokensOut: totalOut,
        };
        return;
      }

      // Process tool calls
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

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.ok
              ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
              : (result.errorMessage ?? 'Tool execution failed'),
          });
        }
      }

      // Feed results back
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
  // MCP tool schemas — these match project-tools.ts in the MCP server
  const defs: Record<string, AnthropicTool> = {
    scaffold_app: {
      name: 'scaffold_app',
      description: 'Create a new PAS app from template. Creates GitHub repo and provisions platform resources.',
      input_schema: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: 'App ID (lowercase, e.g. chess-academy)' },
          name: { type: 'string', description: 'Display name' },
          description: { type: 'string', description: 'Short description' },
        },
        required: ['app_id', 'name', 'description'],
      },
    },
    write_file: {
      name: 'write_file',
      description: 'Create or overwrite a file in the app GitHub repo.',
      input_schema: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          path: { type: 'string', description: 'File path relative to repo root' },
          content: { type: 'string', description: 'Full file content' },
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['app_id', 'path', 'content'],
      },
    },
    read_file: {
      name: 'read_file',
      description: 'Read a file from the app GitHub repo.',
      input_schema: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['app_id', 'path'],
      },
    },
    list_files: {
      name: 'list_files',
      description: 'List files in the app GitHub repo.',
      input_schema: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          path: { type: 'string', description: 'Subdirectory (default: root)' },
        },
        required: ['app_id'],
      },
    },
    search_files: {
      name: 'search_files',
      description: 'Search for text across all files in the app repo.',
      input_schema: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['app_id', 'query'],
      },
    },
    batch_write_files: {
      name: 'batch_write_files',
      description: 'Write multiple files in a single commit.',
      input_schema: {
        type: 'object',
        properties: {
          app_id: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['app_id', 'files', 'message'],
      },
    },
    get_deploy_status: {
      name: 'get_deploy_status',
      description: 'Check GitHub Actions deploy status for the app.',
      input_schema: {
        type: 'object',
        properties: { app_id: { type: 'string' } },
        required: ['app_id'],
      },
    },
    provision_app: {
      name: 'provision_app',
      description: 'Provision CF Pages, D1, DNS for an existing app repo.',
      input_schema: {
        type: 'object',
        properties: { app_id: { type: 'string' } },
        required: ['app_id'],
      },
    },
  };
  return defs[name] ?? { name, description: `Tool: ${name}`, input_schema: { type: 'object', properties: {} } };
}
