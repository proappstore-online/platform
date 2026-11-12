import { describe, expect, it, vi } from "vitest";
import { handlePlatformMediation } from "./platform-mediation.js";
import { SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

// #587 review: a cross-site top-level GET to /.pas/api/... carries the victim's
// Lax session cookie. The mutation Origin check does not cover a GET, and a
// proxy GET spends the user's own key, so /.pas/api refuses navigations and
// anything the browser says did not come from the app's own origin.

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const route = { slug: "spend" } as unknown as Route;

function run(headers: Record<string, string>, path = "/.pas/api/v1/apps/spend/proxy/api.example.com/v1/costs") {
  const API = { fetch: vi.fn(async () => new Response("{}", { status: 200 })) };
  const request = new Request(`https://spend.proappstore.online${path}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=tok`, ...headers } });
  return { API, response: handlePlatformMediation(request, { API } as unknown as Env, route, ctx) };
}

describe("/.pas/api fetch metadata (#587)", () => {
  it.each([
    ["a cross-site navigation", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" }],
    ["a same-site navigation from another app", { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate" }],
    ["a typed URL or bookmark", { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" }],
    ["a same-origin navigation (a link in app content)", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" }],
    ["a cross-site subresource", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" }],
  ])("refuses %s before forwarding", async (_label, headers) => {
    const { API, response } = run(headers);
    expect((await response)!.status).toBe(403);
    expect(API.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["the SDK's fetch", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" }],
    ["a same-origin fetch", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "same-origin" }],
    ["an <img> on a private app", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" }],
    ["a room WebSocket", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "websocket" }],
    ["a client that sends no fetch metadata", {}],
  ])("forwards %s", async (_label, headers) => {
    const { API, response } = run(headers);
    expect((await response)!.status).toBe(200);
    expect(API.fetch).toHaveBeenCalledTimes(1);
  });
});
