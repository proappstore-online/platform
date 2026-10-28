/**
 * Owner-only MCP tool that resolves a trace id from a failed action (#502).
 *
 * A failed write answered "data worker returned 500 (tenant fault)" and a trace id; nothing the
 * owner could reach turned the id into a reason. The backend's `GET /v1/apps/:appId/incidents/:traceId`
 * (#394) already holds the evidence, owner-only and scoped to the app. This is a thin, read-only summary
 * of it, shaped for the question "why did that write fail": which action, what status, which SQLite error,
 * when. Whether the caller may read the app is the backend's decision, made with the connection's own PAS
 * session; nothing here widens it.
 *
 * Server-side evidence only. The browser rows of an incident are the app's own log lines and can carry
 * whatever the app logged, so they are counted, never echoed. No request params or bodies are ever stored
 * by the platform, so none can appear.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id, e.g. bookkeeper");
// The id is interpolated into the subrequest path: the backend's own pattern, nothing wider.
const TRACE_ID = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).describe("Trace id from the failed action's error, e.g. 2f962b9b075d2343db36486eeb0c415d");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

interface IncidentRecord {
  ts?: unknown;
  hop?: unknown;
  level?: unknown;
  message?: unknown;
  data?: { operation?: unknown; status?: unknown; fault?: unknown } | null;
  context?: { operation?: unknown; errorCode?: unknown; spanId?: unknown } | null;
}
interface Incident {
  traceId?: unknown;
  records?: IncidentRecord[];
  invocation?: unknown;
  truncated?: unknown;
}

/** Hops whose rows are the platform's own record of the request (never the app's free-text logs). */
const SERVER_HOPS = new Set(["api", "data-worker", "host", "app-worker"]);

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);

/**
 * The SQLite error class in a message: the primary `SQLITE_*` code when present, else the phrase the
 * engine used (`no such column`, `constraint failed`, …). A label only; the message itself is returned
 * beside it, already bounded and redacted by the platform when it was stored.
 */
export function sqliteErrorClass(message: string): string | null {
  const code = /\bSQLITE_[A-Z_]+/.exec(message)?.[0];
  if (code) return code;
  return /(no such (?:table|column|function|index)|syntax error|constraint failed|datatype mismatch|has no column|already exists|too many SQL variables)/i.exec(message)?.[1]?.toLowerCase() ?? null;
}

/** The object a SQLite message names (`no such column: totl_cents`, `UNIQUE constraint failed: entries.id`), best effort. */
export function sqliteObject(message: string): string | null {
  const m = /(?:no such (?:table|column|function|index)|constraint failed|has no column named|table \S+ already exists):?\s*([A-Za-z0-9_.]{1,80})/i.exec(message);
  return m?.[1] ?? null;
}

export function summariseTrace(appId: string, incident: Incident): Record<string, unknown> {
  const records = Array.isArray(incident.records) ? incident.records : [];
  const server = records.filter((r) => SERVER_HOPS.has(String(r.hop)));
  const browserRows = records.length - server.length;
  const failures = server.map((r) => {
    const message = str(r.message, 400);
    return {
      at: typeof r.ts === "number" ? new Date(r.ts).toISOString() : null,
      hop: String(r.hop),
      level: str(r.level, 16),
      action: str(r.context?.operation ?? r.data?.operation, 120),
      status: typeof r.data?.status === "number" ? r.data.status : null,
      fault: str(r.data?.fault, 16),
      errorCode: str(r.context?.errorCode, 64),
      errorClass: message ? sqliteErrorClass(message) : null,
      object: message ? sqliteObject(message) : null,
      message,
    };
  });
  return {
    appId,
    traceId: str(incident.traceId, 128),
    found: failures.length > 0 || incident.invocation != null,
    failures,
    ...(incident.invocation != null ? { invocation: incident.invocation } : {}),
    browserRows,
    truncated: incident.truncated === true,
    notes: [
      // A missing row is a gap, not an all-clear: detail rows are budgeted and a hop that succeeded writes none.
      ...(failures.length === 0 ? ["No server-side row was recorded for this trace id. That is not proof nothing failed: detail rows are budgeted and sampled out under load."] : []),
      "statementIndex and trigger name are not available: D1 runs a batch atomically and SQLite does not report which statement or trigger failed. `message` carries SQLite's own text for a tenant fault (since #501).",
      "No request params, bodies or caller values are stored by the platform, so none are shown.",
    ],
  };
}

export function registerTraceTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  server.tool(
    "get_action_trace",
    "Explain a failed action from its trace id (the traceId in the error a failed write returned): which action, the HTTP status, the fault verdict (tenant = the app's own SQL or trigger, platform, client), the safe errorCode, SQLite's error text and class for a tenant fault, and when. Owner (or platform admin) of that app only; another app's trace id returns nothing. Server-side records only; no request values. Read-only.",
    { app_id: APP_ID, trace_id: TRACE_ID },
    READ_ONLY,
    async ({ app_id, trace_id }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: "Not authenticated: connect with your PAS session to use get_action_trace." }, true);
      await audit({ env, subject: userId }, { tool: "get_action_trace", action: "invoked", input: { app_id, trace_id } });
      const res = await env.API.fetch(`${env.API_BASE}/v1/apps/${app_id}/incidents/${encodeURIComponent(trace_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      if (!res.ok) return json({ error: `API ${res.status}: ${text.slice(0, 300)}` }, true);
      let incident: Incident;
      try { incident = JSON.parse(text) as Incident; } catch { return json({ error: `API returned non-JSON: ${text.slice(0, 200)}` }, true); }
      return json(summariseTrace(app_id, incident));
    },
  );
}
