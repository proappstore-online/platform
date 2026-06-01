/**
 * Tool dispatcher — executes spine tools by calling the PAS MCP server.
 * Used by runtime adapters to actually execute tool calls.
 */

import type { ToolCall, ToolResult } from './types.ts';

const MCP_BASE = 'https://mcp.proappstore.online';

interface McpToolCallRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface McpToolCallResponse {
  content?: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * Execute a tool call via the PAS MCP server.
 * The MCP server handles GitHub API calls, provisioning, etc.
 */
export async function dispatchTool(
  toolCall: ToolCall,
  userToken: string | null,
): Promise<ToolResult> {
  const start = Date.now();

  try {
    // Call the MCP server's tool endpoint directly
    // The MCP server exposes tools via the standard MCP protocol,
    // but we can also call them via a simple HTTP POST for server-to-server
    const res = await fetch(`${MCP_BASE}/tool-call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}),
      },
      body: JSON.stringify({
        name: toolCall.name,
        arguments: toolCall.args,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        callId: toolCall.id,
        ok: false,
        errorMessage: `MCP server error (${res.status}): ${errText}`,
        durationMs: Date.now() - start,
      };
    }

    const result = (await res.json()) as McpToolCallResponse;

    if (result.isError) {
      const errorText = result.content?.map((c) => c.text).join('\n') ?? 'Unknown error';
      return {
        callId: toolCall.id,
        ok: false,
        errorMessage: errorText,
        durationMs: Date.now() - start,
      };
    }

    const outputText = result.content?.map((c) => c.text).join('\n') ?? '';
    return {
      callId: toolCall.id,
      ok: true,
      data: outputText,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      callId: toolCall.id,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Validate that a tool name is in the allowed spine tools list.
 */
export function isAllowedTool(name: string, spineTools: string[]): boolean {
  return spineTools.includes(name);
}
