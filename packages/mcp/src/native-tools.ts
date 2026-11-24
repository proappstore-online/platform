/**
 * The signed-in user's own native companion data (#660, ADR-019): connected phones, app grants, per-capability status,
 * uploaded locations and heart rate within the 7-day buffer, and each phone's diagnostics report.
 *
 * Thin by design: the backend's /v1/me/native/* routes scope every row to the session's user. They also require the
 * first-party X-Internal-Token, because an app page holds the same session and must never read across apps; this
 * Worker sends it over its service binding, as `whoami`'s account read does (#136). Without INTERNAL_TOKEN the tools
 * fail closed and call nothing.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
// Interpolated into the subrequest query: validated here and again by the backend.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]{0,57}$/).describe("App id, e.g. run");
const DEVICE_ID = z.string().regex(/^[a-f0-9]{64}$/).describe("Device id, from native_devices");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const NOT_AUTHENTICATED = "Not authenticated: connect with your PAS session to read your native companion data.";
const NOT_CONFIGURED = "native tools are not configured (missing INTERNAL_TOKEN)";
const WINDOW = "Only your own account; the platform keeps uploaded samples for 7 days.";
const CURSOR = "When `next` is set, pass next.after as `after` and next.afterId as `after_id` for the following page.";

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

export function registerNativeTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  /** Runs the gate every tool shares, audits ids and cursors only (never coordinates), then reads. */
  async function read(tool: string, path: string, input: Record<string, string | number | undefined>): Promise<Text> {
    const { userId, token } = getUserContext();
    if (!token) return json({ error: NOT_AUTHENTICATED }, true);
    if (!env.INTERNAL_TOKEN) return json({ error: NOT_CONFIGURED }, true);
    await audit({ env, subject: userId }, { tool, action: "invoked", input });
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) if (v !== undefined) q.set(k, String(v));
    const qs = q.toString();
    const res = await env.API.fetch(`${env.API_BASE}/v1/me/native/${path}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Internal-Token": env.INTERNAL_TOKEN },
    });
    const text = await res.text();
    if (!res.ok) return json({ error: `API ${res.status}: ${text}` }, true);
    try { return json(JSON.parse(text)); } catch { return json({ error: `API returned non-JSON: ${text.slice(0, 200)}` }, true); }
  }

  server.tool(
    "native_devices",
    "Your phones connected to the ProAppStore companion: label, platform, app version, when each last synced, when its connection expires, and when it last sent a diagnostics report. Read-only.",
    {},
    READ_ONLY,
    async () => read("native_devices", "devices", {}),
  );

  server.tool(
    "native_grants",
    "Which apps each of your phones shares with, per capability (location, heart rate): consent time and whether the grant is current. A grant with current: false (its disclosure changed, or the app changed publisher) is why an app stops receiving data. Read-only.",
    { app_id: APP_ID.optional(), device_id: DEVICE_ID.optional() },
    READ_ONLY,
    async ({ app_id, device_id }) => read("native_grants", "grants", { appId: app_id, deviceId: device_id }),
  );

  server.tool(
    "native_status",
    "Per app and capability: whether it is enabled, the newest uploaded sample, and per phone whether a sharing session is running, when it started and why the last one ended (from the phone's diagnostics report). Read-only.",
    { app_id: APP_ID.optional() },
    READ_ONLY,
    async ({ app_id }) => read("native_status", "status", { appId: app_id }),
  );

  const page = (max: number, fallback: number) => ({
    app_id: APP_ID.optional(),
    device_id: DEVICE_ID.optional(),
    after: z.number().int().min(0).optional().describe("Cursor: next.after from the previous page"),
    after_id: z.string().max(160).optional().describe("Cursor: next.afterId from the previous page"),
    limit: z.number().int().min(1).max(max).optional().describe(`Page size, default ${fallback}`),
  });

  server.tool(
    "native_locations",
    `Your own uploaded location points (time, latitude, longitude, accuracy, app, phone), oldest first. ${WINDOW} ${CURSOR} Read-only.`,
    page(500, 200),
    READ_ONLY,
    async ({ app_id, device_id, after, after_id, limit }) =>
      read("native_locations", "locations", { appId: app_id, deviceId: device_id, after, afterId: after_id, limit: limit ?? 200 }),
  );

  server.tool(
    "native_heart_rate",
    `Your own uploaded heart-rate samples (time, bpm, app, phone), oldest first. ${WINDOW} ${CURSOR} Read-only.`,
    page(1000, 500),
    READ_ONLY,
    async ({ app_id, device_id, after, after_id, limit }) =>
      read("native_heart_rate", "heart-rate", { appId: app_id, deviceId: device_id, after, afterId: after_id, limit: limit ?? 500 }),
  );

  server.tool(
    "native_diagnostics",
    "The latest diagnostics report from each of your phones (kept 7 days, sent unless you turned Diagnostics off): app and OS version, permissions, sensor and queue state, sync errors, sharing sessions and the last 7 days of the Activity list. Never contains locations or heart rate. Read-only.",
    { device_id: DEVICE_ID.optional() },
    READ_ONLY,
    async ({ device_id }) => read("native_diagnostics", "diagnostics", { deviceId: device_id }),
  );
}
