import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

const route: Route = {
  slug: "meetup",
  zone: "proappstore.online",
  r2_prefix: "apps/meetup",
  store: "pas",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("redirects wildcard www base-domain requests to the apex", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://www.chessclubs.online/club-signup?ref=nav"),
      env,
      ctx(),
    );

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://chessclubs.online/club-signup?ref=nav");
    expect(env.APPS.get).not.toHaveBeenCalled();
  });

  it("sanitizes return_to values that target internal auth routes", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/start?return_to=/.pas/auth/logout"),
      env,
      ctx(),
    );

    const loc = new URL(res.headers.get("Location")!);
    const callback = new URL(loc.searchParams.get("return_to")!);
    expect(callback.searchParams.get("return_to")).toBe("/");
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
      new Request("https://meetup.proappstore.online/.pas/auth/logout", {
        method: "POST",
        headers: {
          Origin: "https://meetup.proappstore.online",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-pas_session=; Max-Age=0");
  });

  it("does not allow cross-site or GET logout", async () => {
    const env = makeEnv();

    const getRes = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/logout"),
      env,
      ctx(),
    );
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("Allow")).toBe("POST");
    expect(getRes.headers.get("Set-Cookie")).toBeNull();

    const crossSiteRes = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/auth/logout", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
      env,
      ctx(),
    );
    expect(crossSiteRes.status).toBe(403);
    expect(crossSiteRes.headers.get("Set-Cookie")).toBeNull();
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

describe("host same-origin platform mediation routes", () => {
  it("forwards API requests with the HttpOnly cookie token, not caller headers", async () => {
    const apiFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.proappstore.online/v1/apps/meetup/roles/me");
      expect(request.headers.get("Authorization")).toBe("Bearer cookie-token");
      expect(request.headers.get("Cookie")).toBeNull();
      return Response.json({ roles: ["owner"] });
    });
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/api/v1/apps/meetup/roles/me", {
        headers: {
          Cookie: "__Host-pas_session=cookie-token",
          Authorization: "Bearer attacker-token",
        },
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roles: ["owner"] });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("requires a hosted session cookie for mediated API requests", async () => {
    const apiFetch = vi.fn(async () => Response.json({ ok: true }));
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/api/v1/auth/me"),
      env,
      ctx(),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "not signed in" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("forwards mediated API WebSocket upgrades with the HttpOnly cookie token", async () => {
    const apiFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://api.proappstore.online/v1/apps/meetup/rooms/lobby");
      expect(request.method).toBe("GET");
      expect(request.headers.get("Upgrade")).toBe("websocket");
      expect(request.headers.get("Authorization")).toBe("Bearer cookie-token");
      expect(request.headers.get("Cookie")).toBeNull();
      return new Response("upgraded");
    });
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/api/v1/apps/meetup/rooms/lobby", {
        headers: {
          Cookie: "__Host-pas_session=cookie-token",
          Upgrade: "websocket",
        },
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upgraded");
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("rejects cross-site mediated mutations before reaching the API", async () => {
    const apiFetch = vi.fn(async () => Response.json({ ok: true }));
    const env = makeEnv({ apiFetch });

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/api/v1/apps/meetup/kv/profile", {
        method: "PUT",
        headers: {
          Cookie: "__Host-pas_session=cookie-token",
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "bad" }),
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(403);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("forwards same-origin data requests to the current app's canonical data worker", async () => {
    const dataFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://data-meetup.proappstore.online/query");
      expect(request.headers.get("Authorization")).toBe("Bearer cookie-token");
      expect(request.headers.get("Cookie")).toBeNull();
      return Response.json({ rows: [{ id: 1 }], meta: { changes: 0, duration: 1 } });
    });
    vi.stubGlobal("fetch", dataFetch);
    const env = makeEnv();

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/data/query", {
        method: "POST",
        headers: {
          Cookie: "__Host-pas_session=cookie-token",
          Origin: "https://meetup.proappstore.online",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: "select 1" }),
      }),
      env,
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: 1 }], meta: { changes: 0, duration: 1 } });
    expect(dataFetch).toHaveBeenCalledOnce();
  });

  it("strips a browser-supplied X-Internal-Token before forwarding to the data worker", async () => {
    const dataFetch = vi.fn(async (request: Request) => {
      // the trusted internal path must NOT be reachable from the browser
      expect(request.headers.get("X-Internal-Token")).toBeNull();
      return Response.json({ rows: [], meta: { changes: 0, duration: 1 } });
    });
    vi.stubGlobal("fetch", dataFetch);

    const res = await worker.fetch(
      new Request("https://meetup.proappstore.online/.pas/data/query", {
        method: "POST",
        headers: {
          Cookie: "__Host-pas_session=cookie-token",
          Origin: "https://meetup.proappstore.online",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-Internal-Token": "attacker-guess",
        },
        body: JSON.stringify({ sql: "select 1" }),
      }),
      makeEnv(),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(dataFetch).toHaveBeenCalledOnce();
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
                const wildcardBase = args[2];
                if (domain === "app.example.com") {
                  return { ...route, kind: "exact", matched_domain: domain } as T;
                }
                if (wildcardBase === "chessclubs.online") {
                  return { ...route, kind: "wildcard", matched_domain: "chessclubs.online" } as T;
                }
                return null as T | null;
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
