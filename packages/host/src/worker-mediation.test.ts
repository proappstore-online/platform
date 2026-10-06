import { describe, expect, it, vi } from "vitest";
import { handlePlatformMediation } from "./platform-mediation.js";
import { SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

// #260: `/.pas/worker/*` on the app origin reaches the app's worker through the
// backend, with the same cookie, CSRF and X-PAS-App rules as `/.pas/api`.

const route = { slug: "doordrop" } as unknown as Route;
const ORIGIN = "https://doordrop.proappstore.online";

function capture(status = 200) {
  const seen: Request[] = [];
  const API = { fetch: vi.fn(async (req: Request) => { seen.push(req); return new Response("ok", { status }); }) };
  return { env: { API } as unknown as Env, seen };
}
const req = (path: string, init: RequestInit & { cookie?: boolean } = {}) => new Request(`${ORIGIN}${path}`, {
  ...init,
  headers: { ...(init.cookie === false ? {} : { Cookie: `${SESSION_COOKIE_NAME}=tok` }), ...(init.headers as Record<string, string> ?? {}) },
});

describe("/.pas/worker mediation (#260)", () => {
  it("forwards any method as a POST to the backend's worker route, carrying method, path and query", async () => {
    const { env, seen } = capture();
    const res = await handlePlatformMediation(req("/.pas/worker/v1/campaigns?page=2"), env, route);
    expect(res!.status).toBe(200);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("https://api.proappstore.online/v1/apps/doordrop/worker/http");
    expect(seen[0]!.headers.get("X-PAS-Worker-Method")).toBe("GET");
    expect(seen[0]!.headers.get("X-PAS-Worker-Path")).toBe("/v1/campaigns?page=2");
    expect(seen[0]!.headers.get("Authorization")).toBe("Bearer tok");
    expect(seen[0]!.headers.get("X-PAS-App")).toBe("doordrop");
    expect(seen[0]!.headers.get("Cookie")).toBeNull();
  });

  it("passes a same-origin mutation's body; the bare prefix maps to /", async () => {
    const { env, seen } = capture();
    await handlePlatformMediation(req("/.pas/worker", { method: "PUT", body: "x=1", headers: { Origin: ORIGIN } }), env, route);
    expect(seen[0]!.headers.get("X-PAS-Worker-Method")).toBe("PUT");
    expect(seen[0]!.headers.get("X-PAS-Worker-Path")).toBe("/");
    expect(await seen[0]!.text()).toBe("x=1");
  });

  it("signed out → 401; a cross-origin POST → 403; neither reaches the backend", async () => {
    const { env, seen } = capture();
    expect((await handlePlatformMediation(req("/.pas/worker/v1/ping", { cookie: false }), env, route))!.status).toBe(401);
    const cross = await handlePlatformMediation(req("/.pas/worker/x", { method: "POST", body: "{}", headers: { Origin: "https://evil.example" } }), env, route);
    expect(cross!.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("a 401 from the worker plane never clears the session cookie", async () => {
    const { env } = capture(401);
    const res = await handlePlatformMediation(req("/.pas/worker/v1/ping"), env, route);
    expect(res!.status).toBe(401);
    expect(res!.headers.get("Set-Cookie")).toBeNull();
  });

  it("matches the prefix strictly: /.pas/workers is not the worker plane", async () => {
    const { env, seen } = capture();
    expect(await handlePlatformMediation(req("/.pas/workers/x"), env, route)).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
