/**
 * Load app tools from the platform API and register them on the MCP server.
 *
 * Two surfaces, one executor (#157):
 *
 *   · `/mcp/apps/<app_id>` — that ONE app's tools, registered under their
 *     manifest names beside the fixed `whoami` / `mcp_audit_log`
 *     (`registerAppTools`). Fetched from `GET /v1/apps/:appId/tools`, which
 *     returns the allowlisted public view (#158): never SQL.
 *   · `/mcp` — the shared platform endpoint registers NO app tools, so its size
 *     does not depend on how many apps exist. It reaches any app's tools through
 *     `list_app_tools(app_id)` → `call_app_tool(app_id, tool, params)`
 *     (`registerAppDiscoveryTools`), which read the same per-app listing.
 *
 * Both paths execute through the platform action executor
 * (`POST /v1/apps/:appId/actions/:name`, `executeToolCall`), which is the real
 * authority on auth and params. Nothing here re-validates a manifest.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gateMutation, type SafetyEnv } from './safety.js';
import { errText } from './errors.js';

interface ToolParam {
  type: string;
  description?: string;
  optional?: boolean;
  default?: unknown;
  max?: number;
}

export interface ToolManifest {
  name: string;
  description: string;
  /** `verify` (#148) runs a platform verifier and may write; it is gated as a mutation here. */
  operation: 'query' | 'execute' | 'batch' | 'verify';
  sql?: string;
  statements?: string[];
  verifier?: string;
  params: Record<string, ToolParam>;
  requires_auth?: boolean;
  auth?: {
    required?: boolean;
    platform_roles?: string[];
    app_roles?: string[];
  };
  /** Always pre-loaded on an app-scoped session, even when the manifest is large (#117). */
  core?: boolean;
}

export interface AppTool extends ToolManifest {
  app_id: string;
}

/** Tools every app-scoped session carries besides the app's own; a manifest name that collides
 *  with one is skipped (and logged) rather than shadowing it. */
export const FIXED_APP_SCOPED_TOOLS = ['whoami', 'mcp_audit_log'] as const;

const APP_ID_RE = /^[a-z][a-z0-9-]{0,57}$/;

/**
 * Pre-flight platform-role check for an app tool. The backend action executor
 * (enforceActionAuth in backend/routes/actions.ts) is the REAL authority; this
 * mirrors only the manifest's PLATFORM-role requirement at the MCP edge so a
 * caller lacking it gets a fast, clear error instead of an opaque backend 403.
 *
 * app_roles are deliberately NOT enforced here: the session token's per-app
 * roles are minted at login and can lag a just-granted role in the app_roles D1
 * table, so pre-rejecting on them would risk a false denial. The backend checks
 * those live against D1. Platform roles are global and always current in the
 * session claims, so they're safe to short-circuit on.
 */
export function checkPlatformRoles(tool: AppTool, roles: string[]): string | null {
  const required = tool.auth?.platform_roles ?? [];
  if (required.length === 0) return null;
  if (roles.some((r) => required.includes(r))) return null;
  return `Error: ${tool.app_id}/${tool.name} requires platform role(s): ${required.join(', ')}. Your session has: ${roles.join(', ') || '(none)'}. Ask the app owner to grant one.`;
}

interface ToolsResponse {
  tools: AppTool[];
}

// Cache one app's tools for 60 seconds, keyed per app so one connection cannot
// widen another. There is no global cache and no global fetch any more (#157):
// the cross-app `GET /v1/tools` is retired (#193).
const cachedTools = new Map<string, { tools: AppTool[]; time: number }>();
const CACHE_TTL = 60_000;

/** One app's registered tools, from `GET /v1/apps/:appId/tools` (public view — never SQL). */
export async function fetchTools(api: Fetcher, apiBase: string, appId: string): Promise<AppTool[]> {
  const now = Date.now();
  const cacheKey = `app:${appId}`;
  const cached = cachedTools.get(cacheKey);
  if (cached && now - cached.time < CACHE_TTL) return cached.tools;

  let res: Response;
  try {
    res = await api.fetch(`${apiBase}/v1/apps/${encodeURIComponent(appId)}/tools`);
  } catch (err) {
    console.error(`Failed to fetch tools (network):`, err);
    return cached?.tools ?? [];
  }
  if (!res.ok) {
    console.error(`Failed to fetch tools: ${res.status}`);
    return cached?.tools ?? [];
  }

  const data = (await res.json()) as ToolsResponse;
  const tools = (data.tools ?? []).map((tool) => ({ ...tool, app_id: appId }));
  cachedTools.set(cacheKey, { tools, time: now });
  return tools;
}

/** Clear the tool cache (e.g. after a publish) */
export function invalidateCache(): void {
  cachedTools.clear();
}

// ── Progressive disclosure (#117) ────────────────────────────────────────────
//
// A per-app session used to register the whole manifest — chess-academy's 122 tools
// are ~73 KB of `tools/list`, ~18k tokens in the model's context on EVERY call, and
// tool selection degrades fastest among near-identical candidates (31 `list_*`
// tools differing by table). Above the threshold the session registers a small
// resident core plus the same discovery pair the shared endpoint uses, scoped to
// the app, so context occupancy follows what a task uses, not what an app has ever
// registered. Below it nothing changes. No `listChanged` promotion: clients that
// cache `tools/list` would not see it, and the static core + discovery pair needs
// no client cooperation.

/** `tools/list` bytes above which an app-scoped session switches to core + discovery. */
export const PROGRESSIVE_DISCLOSURE_THRESHOLD_BYTES = 40_000;
/** How many tools stay resident on a progressive session. */
export const CORE_TOOL_MAX = 10;
/** Cheap reads that are useful in most tasks — resident unless the manifest says otherwise. */
const CORE_NAME_RE = /^(get_|count_)/;

/** The JSON Schema the SDK publishes for a manifest's params — mirrors `buildZodSchema`. */
function inputSchemaFor(params: Record<string, ToolParam> | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(params ?? {})) {
    const type = def.type === 'integer' ? 'integer' : def.type === 'number' ? 'number' : def.type === 'boolean' ? 'boolean' : 'string';
    properties[name] = { type, description: def.description ?? name };
    if (!def.optional && def.default === undefined) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * Estimated `tools/list` bytes for these tools as an app-scoped session publishes
 * them: name, `[app] description`, inputSchema. SQL is never published, so it is
 * never counted — the same accounting the backend reports at registration.
 */
export function measureToolsListBytes(tools: AppTool[]): number {
  const enc = new TextEncoder();
  let bytes = 2; // the surrounding `[]`
  for (const tool of tools) {
    bytes += enc.encode(JSON.stringify({ name: tool.name, description: `[${tool.app_id}] ${tool.description}`, inputSchema: inputSchemaFor(tool.params) })).byteLength + 1;
  }
  return bytes;
}

/**
 * The resident core: manifest-marked `core: true` first, then `get_*` / `count_*`
 * reads, manifest order within each tier, capped at {@link CORE_TOOL_MAX}.
 */
export function selectCoreTools(tools: AppTool[]): AppTool[] {
  const marked = tools.filter((t) => t.core === true);
  const cheapReads = tools.filter((t) => t.core !== true && CORE_NAME_RE.test(t.name));
  return [...marked, ...cheapReads].slice(0, CORE_TOOL_MAX);
}

/** Execute an app tool through the shared platform action executor. */
export async function executeToolCall(
  tool: AppTool,
  args: Record<string, unknown>,
  userToken: string | null,
  api: Fetcher,
  apiBase: string,
): Promise<string> {
  if (!userToken) {
    return 'Error: This tool requires authentication. Authenticate the MCP connection or send a PAS session token.';
  }

  let res: Response;
  try {
    res = await api.fetch(`${apiBase}/v1/apps/${encodeURIComponent(tool.app_id)}/actions/${encodeURIComponent(tool.name)}`, {
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

  // execute/batch: return metadata from the data worker.
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

type UserContext = () => { userId: string | null; token: string | null; roles: string[] };

/**
 * Register ONE app's tools on an app-scoped session (`/mcp/apps/<app_id>`),
 * under their manifest names (#157 step 3). The client's server name already
 * namespaces them (a client shows `mcp__crm__list_companies`), and `<app>/<tool>`
 * violated the MCP tool-name rule (`[A-Za-z0-9._-]`), which the SDK warned about
 * on every registration. A manifest name that collides with a fixed tool is
 * skipped and logged rather than shadowing it. Returns the names registered.
 */
export function registerAppTools(
  server: McpServer,
  tools: AppTool[],
  getUserContext: UserContext,
  api: Fetcher,
  apiBase: string,
  env: SafetyEnv,
): string[] {
  const registered: string[] = [];

  for (const tool of tools) {
    if ((FIXED_APP_SCOPED_TOOLS as readonly string[]).includes(tool.name)) {
      console.warn(`Skipping app tool ${tool.app_id}/${tool.name}: collides with the fixed tool "${tool.name}"`);
      continue;
    }
    const zodSchema = buildZodSchema(tool.params);

    server.tool(
      tool.name,
      `[${tool.app_id}] ${tool.description}`,
      zodSchema,
      async (args) => {
        const { userId, token, roles } = getUserContext();
        // Pre-flight platform-role check: reject fast (clear error) when the
        // manifest requires a platform role this session lacks. Backend
        // enforceActionAuth remains the authority (esp. for app_roles).
        const roleErr = checkPlatformRoles(tool, roles);
        if (roleErr) return { content: [{ type: 'text' as const, text: roleErr }] };
        // `execute` and `batch` actions mutate app data; `query` actions are read-only.
        // Gate + audit the mutating ones (read-only mode throws here). `scope: "app"`
        // lets the audit log tell this path from `call_app_tool` on the shared endpoint.
        if (tool.operation !== 'query') {
          await gateMutation({ env, subject: userId }, tool.name, { app_id: tool.app_id, scope: 'app' });
        }
        const result = await executeToolCall(tool, args as Record<string, unknown>, token, api, apiBase);
        return { content: [{ type: 'text' as const, text: result }] };
      },
    );

    registered.push(tool.name);
  }

  return registered;
}

/** One line per tool for `list_app_tools`: what it is, whether it writes, whether it needs a session. */
function describeTool(t: AppTool, includeParams: boolean): string {
  const kind = t.operation === 'query' ? 'reads' : 'writes';
  const auth = t.requires_auth === false ? 'public' : 'auth';
  const line = `${t.name} — ${kind} — ${auth} — ${t.description}`;
  if (!includeParams) return line;
  const params = Object.entries(t.params ?? {})
    .map(([name, def]) => `${name}${def.optional || def.default !== undefined ? '?' : ''}: ${def.type}${def.description ? ` — ${def.description}` : ''}`)
    .join(', ');
  return params ? `${line}\n  params: ${params}` : line;
}

/**
 * The shared endpoint's way to reach any app's tools without registering them
 * all (#157 step 2, vendored from PAGS `list_instance_tools` / `call_instance_tool`):
 *
 *   · `list_app_tools(app_id, include_params?)` — one line per tool, schemas off
 *     by default ("ask for them when you are about to call one"). Never `sql`.
 *   · `call_app_tool(app_id, tool, params?)` — the generic invoker: the same
 *     platform-role pre-flight and mutation gate as a registered tool, then the
 *     same `executeToolCall`. The backend validates params; nothing here does.
 *
 * Discovery deliberately mirrors the executor: any authenticated caller may list
 * any app, because the executor already lets any signed-in user call any app's
 * `requires_auth` action by name — a stricter list would claim a boundary the
 * executor does not enforce. Identity comes from the connection, not a `token` arg.
 */
export function registerAppDiscoveryTools(
  server: McpServer,
  getUserContext: UserContext,
  api: Fetcher,
  apiBase: string,
  env: SafetyEnv,
): void {
  registerDiscoveryPair(server, getUserContext, api, apiBase, env);
}

/** What a scoped discovery pair knows about its app (#117): fixed id, and the split it should explain. */
interface DiscoveryScope {
  appId: string;
  total: number;
  core: number;
}

/**
 * The discovery pair, either app-agnostic (shared endpoint: `app_id` is an argument)
 * or scoped to one app (a progressive per-app session: `app_id` is fixed and the
 * descriptions say how many tools are pre-loaded and how many are one call away).
 */
function registerDiscoveryPair(
  server: McpServer,
  getUserContext: UserContext,
  api: Fetcher,
  apiBase: string,
  env: SafetyEnv,
  scope?: DiscoveryScope,
): void {
  const appIdArg: z.ZodRawShape = scope ? {} : { app_id: z.string().describe("The app id (its subdomain / repository name), e.g. 'crm'.") };
  const resolveAppId = (args: { app_id?: string }): string | null => {
    const id = scope ? scope.appId : args.app_id ?? '';
    return APP_ID_RE.test(id) ? id : null;
  };
  const listDescription = scope
    ? `This app (${scope.appId}) has ${scope.total} tools total; ${scope.core} are pre-loaded on this session. Call this tool to discover the rest — name, reads or writes, auth or public, description, and each tool's params with include_params — then use call_app_tool to invoke one by name. Never SQL.`
    : "One app's registered data tools (its mcp.json), as the platform sees them: name, reads or writes, auth or public, description — and each tool's params with include_params. Never SQL. From the shared /mcp endpoint this is how you find what an app exposes; call one with call_app_tool, or connect to /mcp/apps/<app_id> to have them registered directly. An empty list means the app has no registered tools or does not exist.";
  const callDescription = scope
    ? `Call any of this app's (${scope.appId}) ${scope.total} registered data tools by name — including the ${scope.total - scope.core} not pre-loaded on this session — through the platform action executor, exactly as a pre-loaded tool runs: the executor enforces requires_auth and the manifest's platform / app roles, validates params against the manifest, and scopes rows in the tool's SQL. Query tools return rows; execute and batch tools mutate app data, are audited, and are refused in read-only mode. Runs as the connected account. Use list_app_tools first to see names and params.`
    : "Call one app's registered data tool through the platform action executor, exactly as the app's own /mcp/apps/<app_id> endpoint and the browser SDK do: the executor enforces requires_auth and the manifest's platform / app roles, validates params against the manifest, and scopes rows in the tool's SQL. Query tools return rows; execute and batch tools mutate app data, are audited, and are refused in read-only mode. Runs as the connected account. Use list_app_tools first to see names and params.";

  const listShape: z.ZodRawShape = {
    ...appIdArg,
    include_params: z.boolean().optional().describe("Append each tool's params (name, type, description). Off by default; ask for them when you are about to call one."),
  };
  server.tool(
    'list_app_tools',
    listDescription,
    listShape,
    async (args) => {
      const { app_id, include_params } = args as { app_id?: string; include_params?: boolean };
      const id = resolveAppId({ app_id });
      if (!id) return errText(`Error: invalid app_id "${app_id ?? ''}".`);
      const tools = await fetchTools(api, apiBase, id);
      if (tools.length === 0) {
        return { content: [{ type: 'text' as const, text: `${id} has no registered tools (or does not exist). Apps register tools by committing an mcp.json; list_apps shows the apps you can see.` }] };
      }
      const lines = tools.map((t) => describeTool(t, include_params === true));
      const call = scope ? `call_app_tool({ tool: "<name>", params: { … } })` : `call_app_tool({ app_id: "${id}", tool: "<name>", params: { … } })`;
      return { content: [{ type: 'text' as const, text: `# ${id}: ${tools.length} tool(s)\n\n${lines.join('\n')}\n\nCall one with ${call}.` }] };
    },
  );

  const callShape: z.ZodRawShape = {
    ...(scope ? {} : { app_id: z.string().describe("The app id, e.g. 'crm'.") }),
    tool: z.string().describe('The tool name from list_app_tools.'),
    params: z.record(z.unknown()).optional().describe("The tool's params, by name."),
  };
  server.tool(
    'call_app_tool',
    callDescription,
    callShape,
    async (args) => {
      const { app_id, tool, params } = args as { app_id?: string; tool: string; params?: Record<string, unknown> };
      const id = resolveAppId({ app_id });
      if (!id) return errText(`Error: invalid app_id "${app_id ?? ''}".`);
      const app_idResolved = id;
      const tools = await fetchTools(api, apiBase, app_idResolved);
      const manifest = tools.find((t) => t.name === tool);
      if (!manifest) {
        const hint = scope ? 'call list_app_tools({}) for the names it exposes' : `call list_app_tools({ app_id: "${app_idResolved}" }) for the names it exposes`;
        return { content: [{ type: 'text' as const, text: `Unknown tool ${tool} for ${app_idResolved}; ${hint}.` }] };
      }
      const { userId, token, roles } = getUserContext();
      const roleErr = checkPlatformRoles(manifest, roles);
      if (roleErr) return { content: [{ type: 'text' as const, text: roleErr }] };
      // Query tools must keep working under MCP_READ_ONLY; only the mutating operations are
      // gated and audited. PAGS gates its invoker unconditionally because it cannot know the
      // side effect; PAS knows `operation`.
      if (manifest.operation !== 'query') {
        await gateMutation({ env, subject: userId }, 'call_app_tool', { app_id: app_idResolved, tool, scope: scope ? 'app' : 'shared' });
      }
      const result = await executeToolCall(manifest, params ?? {}, token, api, apiBase);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
}

export interface ProgressiveRegistration {
  mode: 'full' | 'progressive';
  /** Tool names registered on the session (core tools + the discovery pair when progressive). */
  registered: string[];
  total: number;
  /** Estimated `tools/list` bytes of the whole manifest, and of what was actually registered. */
  bytes: number;
  registeredBytes: number;
}

/**
 * Register an app's tools on its own session with progressive disclosure (#117).
 *
 * Below {@link PROGRESSIVE_DISCLOSURE_THRESHOLD_BYTES} this is exactly `registerAppTools`.
 * Above it, only {@link selectCoreTools} are registered directly, plus `list_app_tools`
 * and `call_app_tool` fixed to this app — every other tool is one discovery call away
 * and callable by name, so nothing is hidden, only deferred.
 */
export function registerAppToolsProgressive(
  server: McpServer,
  tools: AppTool[],
  appId: string,
  getUserContext: UserContext,
  api: Fetcher,
  apiBase: string,
  env: SafetyEnv,
): ProgressiveRegistration {
  const bytes = measureToolsListBytes(tools);
  if (bytes < PROGRESSIVE_DISCLOSURE_THRESHOLD_BYTES) {
    const registered = registerAppTools(server, tools, getUserContext, api, apiBase, env);
    return { mode: 'full', registered, total: tools.length, bytes, registeredBytes: bytes };
  }
  const core = selectCoreTools(tools);
  const registered = registerAppTools(server, core, getUserContext, api, apiBase, env);
  registerDiscoveryPair(server, getUserContext, api, apiBase, env, { appId, total: tools.length, core: registered.length });
  const registeredBytes = measureToolsListBytes(core.filter((t) => registered.includes(t.name)));
  console.log(
    `Progressive disclosure for ${appId}: ${tools.length} tools / ~${bytes} B of tools/list → ${registered.length} core + list_app_tools/call_app_tool (~${registeredBytes} B); ~${bytes - registeredBytes} B saved per call`,
  );
  return { mode: 'progressive', registered: [...registered, 'list_app_tools', 'call_app_tool'], total: tools.length, bytes, registeredBytes };
}
