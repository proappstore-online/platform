import { describe, expect, it, vi } from "vitest";
import { handlePlatformMediation } from "./platform-mediation.js";
import { SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

/**
 * X-PAS-App is the host's *assertion* of which app a mediated request belongs to
 * — the backend treats its presence as our word (ADR-008 §4). So the two
 * properties that matter are: we always set it from the resolved route, and a
 * client-supplied copy can never survive.
 */

const route = { slug: "chess-academy" } as unknown as Route;

function envWithCapture() {
  const seen: Request[] = [];
  const API = {
    fetch: vi.fn(async (req: Request) => {
      seen.push(req);
      return new Response("{}", { status: 200 });
    }),
  };
  return { env: { API } as unknown as Env, seen };
}

function mediatedRequest(headers: Record<string, string>, method = "POST") {
  return new Request("https://chess-academy.proappstore.online/.pas/api/v1/apps/chess-academy/logs", {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=tok`,
      Origin: "https://chess-academy.proappstore.online",
      "Content-Type": "application/json",
      ...headers,
    },
    body: method === "GET" ? undefined : JSON.stringify({ entries: [] }),
  });
}

describe("X-PAS-App app-context binding", () => {
  it("sets the header from the resolved route", async () => {
    const { env, seen } = envWithCapture();
    await handlePlatformMediation(mediatedRequest({}), env, route);
    expect(seen[0].headers.get("X-PAS-App")).toBe("chess-academy");
  });

  it("overwrites a client-supplied value rather than trusting it", async () => {
    // Without the delete-then-set, a page on chess-academy could claim another
    // app through the trusted path — the one thing this header must prevent.
    const { env, seen } = envWithCapture();
    await handlePlatformMediation(mediatedRequest({ "X-PAS-App": "victim-app" }), env, route);
    expect(seen[0].headers.get("X-PAS-App")).toBe("chess-academy");
  });

  it("applies to reads as well as mutations", async () => {
    const { env, seen } = envWithCapture();
    await handlePlatformMediation(mediatedRequest({}, "GET"), env, route);
    expect(seen[0].headers.get("X-PAS-App")).toBe("chess-academy");
  });

  it("still strips the internal token alongside it", async () => {
    const { env, seen } = envWithCapture();
    await handlePlatformMediation(
      mediatedRequest({ "X-Internal-Token": "stolen", "X-PAS-App": "victim-app" }),
      env,
      route,
    );
    expect(seen[0].headers.get("X-Internal-Token")).toBeNull();
    expect(seen[0].headers.get("X-PAS-App")).toBe("chess-academy");
  });

  it("does not reach upstream at all without a session cookie", async () => {
    const { env, seen } = envWithCapture();
    const req = new Request("https://chess-academy.proappstore.online/.pas/api/v1/apps/chess-academy/logs", {
      method: "POST",
      headers: { Origin: "https://chess-academy.proappstore.online" },
      body: "{}",
    });
    const res = await handlePlatformMediation(req, env, route);
    expect(res?.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});
