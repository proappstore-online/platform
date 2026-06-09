/**
 * Load app tools from the platform API and register them on the MCP server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type ToolManifest, prepareQuery } from './sql-engine.js';

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

/**
 * Execute a tool call by proxying SQL to the app's data worker.
 */
async function executeToolCall(
  tool: AppTool,
  args: Record<string, unknown>,
  userId: string | null,
  userToken: string | null,
): Promise<string> {
  // Check auth requirement before building the query — prepareQuery throws
  // on __user_id when userId is null, so this must come first.
  if (tool.requires_auth && !userId) {
    return 'Error: This tool requires authentication. Authenticate the MCP connection or send a PAS session token.';
  }

  let sql: string;
  let params: unknown[];
  try {
    ({ sql, params } = prepareQuery(tool, args, userId));
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const dataWorkerUrl = `https://data-${tool.app_id}.proappstore.online`;
  const endpoint = tool.operation === 'query' ? '/query' : '/execute';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userToken) headers.Authorization = `Bearer ${userToken}`;

  let res: Response;
  try {
    res = await fetch(`${dataWorkerUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql, params }),
    });
  } catch (err) {
    return `Error: data worker unreachable (${err instanceof Error ? err.message : String(err)})`;
  }

  if (!res.ok) {
    const text = await res.text();
    return `Error from data worker (${res.status}): ${text}`;
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
        const { userId, token } = getUserContext();
        const result = await executeToolCall(tool, args as Record<string, unknown>, userId, token);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    );

    registered.push(toolName);
  }

  return registered;
}
