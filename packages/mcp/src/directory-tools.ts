/**
 * App directory discovery over MCP (#424) — read-only.
 *
 * `find_apps` is the MCP form of the creator console's directory: it calls the
 * backend's GET /v1/apps/directory with the connection's own PAS session, so the
 * backend decides what the caller may see. An id held by someone else comes back
 * as `exists_inaccessible` with only public facts — never its holder.
 *
 * Route health is never stored, so `check_health` measures it here, through the
 * HOST binding exactly as `app_info` does (a same-zone fetch would bypass the
 * host worker and report a false status).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

/** At most this many routes are checked per call, the first results first. */
export const HEALTH_CHECK_MAX = 25;
const HEALTH_TIMEOUT_MS = 5_000;
export type RouteHealth = "ok" | "down" | "timeout";

const LIST = (values: readonly string[]) =>
  z.string().regex(new RegExp(`^(${values.join("|")})(,(${values.join("|")}))*$`), `comma-separated: ${values.join(", ")}`);
const LIFECYCLES = ["draft", "provisioned", "deployed", "live", "failed", "unpublished", "archived"] as const;
const ACCESS = ["mine", "team", "operator", "transfer", "inaccessible"] as const;

/**
 * One live route check. A private app refuses an anonymous HEAD by design and
 * the host marks that refusal (#259), so it reads as up, not down.
 */
export async function checkRoute(host: Fetcher, url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<RouteHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    const check = host.fetch(url, { method: "HEAD" }).then((res): RouteHealth =>
      res.ok || res.headers.get("X-PAS-Visibility") === "private" ? "ok" : "down");
    return await Promise.race([check, timeout]);
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

interface DirectoryItem { id: string; lifecycle: string | null; routeUrl: string | null; routeHealth: RouteHealth | null }

export function registerDirectoryTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  server.tool(
    "find_apps",
    "Search the app directory. Supports filtering by lifecycle status and access level. Lists every app you can reach — created, team, operator, offered to you by a pending ownership transfer — and your drafts, with display name, lifecycle (draft, provisioned, deployed, live, failed, unpublished, archived), deploy status, access level, route, repository reference and links. `q` matches id, display name or custom domain; a live URL, store page or github.com/proappstore-online/<id> URL names one exact id, and `lookup` then says whether it is yours, accessible, unclaimed, reserved by the platform, or exists_inaccessible (held by someone else — never who; see ownership_status / request_ownership_recovery). check_health: true adds a live routeHealth (ok, down, timeout) for the first 25 results. Read-only.",
    {
      q: z.string().max(200).optional().describe("Search: app id, display name, live URL, store page, repository URL or custom domain"),
      status: LIST(LIFECYCLES).optional().describe(`Lifecycle filter, comma-separated: ${LIFECYCLES.join(", ")}`),
      access: LIST(ACCESS).optional().describe(`Access filter, comma-separated: ${ACCESS.join(", ")}`),
      limit: z.number().int().min(1).max(200).optional().describe("Max results, 1-200 (default 50)"),
      check_health: z.boolean().optional().describe(`Check each result's live route (first ${HEALTH_CHECK_MAX}); slower`),
    },
    READ_ONLY,
    async ({ q, status, access, limit, check_health }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: "Not authenticated: connect with your PAS session to search the app directory." }, true);
      await audit({ env, subject: userId }, { tool: "find_apps", action: "invoked", input: { q, status, access, limit, check_health } });

      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      if (access) params.set("access", access);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();

      let res: Response;
      try {
        res = await env.API.fetch(`${env.API_BASE}/v1/apps/directory${qs ? `?${qs}` : ""}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (e) {
        return json({ error: `App directory unavailable: ${e instanceof Error ? e.message : String(e)}` }, true);
      }
      const text = await res.text();
      if (!res.ok) return json({ error: `API ${res.status}: ${text}` }, true);
      let data: { items?: DirectoryItem[] } & Record<string, unknown>;
      try { data = JSON.parse(text); } catch { return json({ error: `API returned non-JSON: ${text.slice(0, 200)}` }, true); }

      if (check_health && Array.isArray(data.items)) {
        // A draft has no route yet; everything else has a public hostname.
        const targets = data.items.filter((i) => i.routeUrl && i.lifecycle !== "draft").slice(0, HEALTH_CHECK_MAX);
        await Promise.all(targets.map(async (i) => { i.routeHealth = await checkRoute(env.HOST, i.routeUrl!); }));
        data.healthChecked = targets.length;
      }
      return json(data);
    },
  );
}
