import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

const route: Route = {
  slug: "meetup",
  zone: "proappstore.online",
  r2_prefix: "apps/meetup",
  store: "pas",
};

describe("host auth token-handler routes", () => {
  it("starts OAuth through the API with a same-origin callback", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/start?provider=google&return_to=/dashboard?tab=1"),
      env,
      ctx(),
    );

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin).toBe("https://api.proappstore.online");
    expect(loc.pathname).toBe("/v1/auth/google/start");
    expect(loc.searchParams.get("app_id")).toBe("meetup");
    expect(loc.searchParams.get("response_mode")).toBe("query");
    const callback = new URL(loc.searchParams.get("return_to")!);
    expect(callback.origin).toBe("https://meetup.proappstore.online");
    expect(callback.pathname).toBe("/.pas/auth/callback");
    expect(callback.searchParams.get("return_to")).toBe("/dashboard?tab=1");
    expect(callback.searchParams.get("nonce")).toBeTruthy();
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("__Host-pas_auth_nonce=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain=");
  });

  it("starts OAuth from an active custom domain on that same custom origin", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://app.example.com/.pas/auth/start?return_to=/"),
      env,
      ctx(),
    );

    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    const callback = new URL(loc.searchParams.get("return_to")!);
    expect(loc.searchParams.get("app_id")).toBe("meetup");
    expect(callback.origin).toBe("https://app.example.com");
  });

  it("sets a host-only HttpOnly cookie after verifying the callback session", async () => {
    const apiFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("Authorization")).toBe("Bearer good-token");
      return Response.json({ id: "gh:1", login: "creator", roles: ["user"], appRoles: {} });
    });
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/callback?session=good-token&return_to=/dashboard&nonce=nonce-1", {
        headers: { Cookie: "__Host-pas_auth_nonce=nonce-1" },
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://meetup.proappstore.online/dashboard");
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("__Host-pas_session=good-token");
    expect(cookie).toContain("__Host-pas_auth_nonce=; Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(env.APPS.get).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("rejects direct callback links that do not have the host auth nonce", async () => {
    const apiFetch = vi.fn(async () => Response.json({ id: "gh:1" }));
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/callback?session=good-token&return_to=/dashboard&nonce=nonce-1"),
      env,
      ctx(),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://meetup.proappstore.online/dashboard#auth_error=invalid_state");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-pas_auth_nonce=; Max-Age=0");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("redirects with an auth error and no cookie when callback verification fails", async () => {
    const env = makeEnv({
      apiFetch: vi.fn(async () => new Response("invalid", { status: 401 })),
    });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/callback?session=bad-token&return_to=/dashboard&nonce=nonce-1", {
        headers: { Cookie: "__Host-pas_auth_nonce=nonce-1" },
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://meetup.proappstore.online/dashboard#auth_error=invalid_session");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-pas_auth_nonce=; Max-Age=0");
  });

  it("serves /me through the API using the HttpOnly cookie token", async () => {
    const apiFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("Authorization")).toBe("Bearer cookie-token");
      return Response.json({ id: "gh:1", login: "creator", roles: ["user"], appRoles: {} });
    });
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/me", {
        headers: { Cookie: "__Host-pas_session=cookie-token" },
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "gh:1", login: "creator", roles: ["user"], appRoles: {} });
  });

  it("clears the auth cookie on logout", async () => {
    const env = makeEnv();

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/logout", { method: "POST" }),
      env,
      ctx(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-pas_session=; Max-Age=0");
  });

  it("does not allow app files to shadow reserved auth paths", async () => {
    const env = makeEnv();

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/not-real"),
      env,
      ctx(),
    );

    expect(res.status).toBe(404);
    expect(env.APPS.get).not.toHaveBeenCalled();
  });
});

function makeEnv(opts: { apiFetch?: (request: Request) => Promise<Response> } = {}): Env {
  const apiFetch = opts.apiFetch ?? (async () => Response.json({ id: "gh:1", login: "creator", roles: ["user"], appRoles: {} }));
  return {
    APPS: { get: vi.fn() },
    DB: fakeRouteDb(),
    API: { fetch: vi.fn((request: Request) => apiFetch(request)) },
    ADMIN: { fetch: vi.fn() },
    AGENTS: { fetch: vi.fn() },
    MCP: { fetch: vi.fn() },
    KB: { fetch: vi.fn() },
  } as unknown as Env;
}

function fakeRouteDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("app_custom_domains")) {
                const domain = args[1];
                return (domain === "app.example.com" ? route : null) as T | null;
              }
              const [slug, zone] = args;
              return (slug === route.slug && zone === route.zone ? route : null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function ctx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}
