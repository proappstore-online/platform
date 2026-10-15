import { describe, expect, it, vi } from "vitest";
import { ANALYTICS_EVENT_PATH, ANALYTICS_LOADER_PATH, MAX_EVENT_BODY_BYTES, handleAnalyticsMediation } from "./analytics-mediation.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

// #402: same-origin visitor analytics on an app origin. The app is the resolved
// route's, the destination is fixed, nothing credential-shaped is forwarded.

const route = { slug: "chess-academy" } as unknown as Route;
const ORIGIN = "https://chessclubs.online";

function setup(status = 204) {
  const seen: Request[] = [];
  const API = { fetch: vi.fn(async (req: Request) => { seen.push(req); return new Response(req.url.endsWith(".js") ? "/* loader */" : null, { status: req.url.endsWith(".js") ? 200 : status, headers: req.url.endsWith(".js") ? { "content-type": "application/javascript" } : { "x-events-accepted": "1" } }); }) };
  return { env: { API } as unknown as Env, seen, API };
}
const event = (headers: Record<string, string> = {}, body = JSON.stringify({ app: "victim-app", kind: "pageview", path: "/" })) =>
  new Request(`${ORIGIN}${ANALYTICS_EVENT_PATH}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "text/plain;charset=UTF-8", Cookie: "__Host-pas_session=secret-session", "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0", ...headers },
    body,
  });

describe("same-origin analytics (#402)", () => {
  it("serves the loader for the route's app from the API over HostApi, never forwarding the page's cookies or query", async () => {
    const { env, seen } = setup();
    const res = await handleAnalyticsMediation(new Request(`${ORIGIN}${ANALYTICS_LOADER_PATH}?app=victim-app`, { headers: { Cookie: "__Host-pas_session=secret" } }), env, route);
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("/* loader */");
    expect(seen[0]!.url).toBe("https://api.proappstore.online/v1/analytics.js");
    expect(seen[0]!.headers.get("X-PAS-App")).toBe("chess-academy");
    expect(seen[0]!.headers.get("Cookie")).toBeNull();
  });

  it("forwards a same-origin event to the fixed ingest path with the route's app, visitor IP and UA — no cookie, no page-chosen app", async () => {
    const { env, seen } = setup();
    const res = await handleAnalyticsMediation(event({ "X-PAS-App": "victim-app" }), env, route);
    expect(res!.status).toBe(204);
    expect(res!.headers.get("Cache-Control")).toBe("no-store");
    const fwd = seen[0]!;
    expect(fwd.url).toBe("https://api.proappstore.online/v1/analytics/event");
    expect(fwd.method).toBe("POST");
    expect(fwd.headers.get("X-PAS-App")).toBe("chess-academy");
    expect(fwd.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(fwd.headers.get("user-agent")).toBe("Mozilla/5.0");
    expect(fwd.headers.get("Cookie")).toBeNull();
    expect(fwd.headers.get("Authorization")).toBeNull();
    expect(await fwd.text()).toContain('"kind":"pageview"');
  });

  it("refuses a cross-origin or origin-less POST (CSRF) without calling the API", async () => {
    const { env, API } = setup();
    expect((await handleAnalyticsMediation(event({ Origin: "https://evil.example" }), env, route))!.status).toBe(403);
    const bare = new Request(`${ORIGIN}${ANALYTICS_EVENT_PATH}`, { method: "POST", body: "{}" });
    expect((await handleAnalyticsMediation(bare, env, route))!.status).toBe(403);
    expect(API.fetch).not.toHaveBeenCalled();
  });

  it("caps the body at 64 KB, by header and by actual size", async () => {
    const { env, API } = setup();
    const big = "x".repeat(MAX_EVENT_BODY_BYTES + 1);
    expect((await handleAnalyticsMediation(event({}, big), env, route))!.status).toBe(413);
    expect((await handleAnalyticsMediation(event({ "Content-Length": String(MAX_EVENT_BODY_BYTES + 1) }, "{}"), env, route))!.status).toBe(413);
    expect(API.fetch).not.toHaveBeenCalled();
  });

  it("only GET/HEAD the loader and POST the event; other /.pas paths are not this module's", async () => {
    const { env } = setup();
    expect((await handleAnalyticsMediation(new Request(`${ORIGIN}${ANALYTICS_EVENT_PATH}`), env, route))!.status).toBe(405);
    expect((await handleAnalyticsMediation(new Request(`${ORIGIN}${ANALYTICS_LOADER_PATH}`, { method: "POST", body: "x" }), env, route))!.status).toBe(405);
    expect(await handleAnalyticsMediation(new Request(`${ORIGIN}/.pas/analytics/other`), env, route)).toBeNull();
    expect(await handleAnalyticsMediation(new Request(`${ORIGIN}/.pas/api/v1/analytics/event`), env, route)).toBeNull();
  });
});
