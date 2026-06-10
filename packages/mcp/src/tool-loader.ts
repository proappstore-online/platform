/**
 * Load app tools from the platform API and register them on the MCP server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface ToolParam {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  max?: number;
}

interface ToolManifest {
  name: string;
  description: string;
  operation: 'query' | 'execute';
  sql: string;
  params: Record<string, ToolParam>;
  requires_auth?: boolean;
  auth?: {
    required?: boolean;
    platform_roles?: string[];
    app_roles?: string[];
  };
}

interface AppTool extends ToolManifest {
  app_id: string;
}

interface ToolsResponse {
  tools: AppTool[];
}

// Cache tools for 60 seconds
let cachedTools: AppTool[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

export async function fetchTools(apiBase: string): Promise<AppTool[]> {
  const now = Date.now();
  if (cachedTools && now - cacheTime < CACHE_TTL) return cachedTools;

  let res: Response;
  try {
    res = await fetch(`${apiBase}/v1/tools`);
  } catch (err) {
    console.error(`Failed to fetch tools (network):`, err);
    return cachedTools ?? [];
  }
  if (!res.ok) {
    console.error(`Failed to fetch tools: ${res.status}`);
    return cachedTools ?? [];
  }

  const data = (await res.json()) as ToolsResponse;
  cachedTools = data.tools;
  cacheTime = now;
  return cachedTools;
}

/** Clear the tool cache (e.g. after a publish) */
export function invalidateCache(): void {
  cachedTools = null;
  cacheTime = 0;
}

/** Execute an app tool through the shared platform action executor. */
export async function executeToolCall(
  tool: AppTool,
  args: Record<string, unknown>,
  userToken: string | null,
  apiBase: string,
): Promise<string> {
  if (!userToken) {
    return 'Error: This tool requires authentication. Authenticate the MCP connection or send a PAS session token.';
  }

  let res: Response;
  try {
    res = await fetch(`${apiBase}/v1/apps/${encodeURIComponent(tool.app_id)}/actions/${encodeURIComponent(tool.name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ params: args }),
    });
  } catch (err) {
    return `Error: platform action executor unreachable (${err instanceof Error ? err.message : String(err)})`;
  }

  if (!res.ok) {
    const text = await res.text();
    return `Error from platform action executor (${res.status}): ${text}`;
  }

  const result = await res.json();

  if (tool.operation === 'query') {
    // Data worker returns { rows: [...], meta: {...} }
    const data = result as { rows?: unknown[] };
    const rows = data.rows ?? [];
    if (rows.length === 0) return 'No results found.';
    return JSON.stringify(rows, null, 2);
  }

  // execute: return meta
  return JSON.stringify(result, null, 2);
}

/**
 * Build a Zod schema from the tool's param definitions.
 */
function buildZodSchema(params: Record<string, { type: string; description?: string; optional?: boolean; default?: unknown; max?: number }> | undefined): Record<string, z.ZodTypeAny> {
  const schema: Record<string, z.ZodTypeAny> = {};
  if (!params) return schema;

  for (const [name, def] of Object.entries(params)) {
    let field: z.ZodTypeAny;
    switch (def.type) {
      case 'integer':
      case 'number':
        field = z.number().describe(def.description ?? name);
        break;
      case 'boolean':
        field = z.boolean().describe(def.description ?? name);
        break;
      default:
        field = z.string().describe(def.description ?? name);
    }

    if (def.optional || def.default !== undefined) {
      field = field.optional();
    }

    schema[name] = field;
  }

  return schema;
}

/**
 * Register all app tools on the MCP server. Called during init().
 * Returns tool names that were registered.
 */
export function registerAppTools(
  server: McpServer,
  tools: AppTool[],
  getUserContext: () => { userId: string | null; token: string | null },
  apiBase: string,
): string[] {
  const registered: string[] = [];

  for (const tool of tools) {
    const toolName = `${tool.app_id}/${tool.name}`;
    const zodSchema = buildZodSchema(tool.params);

    server.tool(
      toolName,
      `[${tool.app_id}] ${tool.description}`,
      zodSchema,
      async (args) => {
        const { token } = getUserContext();
        const result = await executeToolCall(tool, args as Record<string, unknown>, token, apiBase);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    );

    registered.push(toolName);
  }

  return registered;
}
