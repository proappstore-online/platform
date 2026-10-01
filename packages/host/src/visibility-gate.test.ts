import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { ALLOW_CACHE_TTL_MS, clearVisibilityAllowCache, REFUSAL_CACHE_TTL_MS, refuseUnlessVisible } from "./visibility-gate.js";

/**
 * #259 review: a private app's page loads many assets, and each used to cost a
 * backend visibility/me call (~4 D1 queries). An ALLOW is now remembered per
 * isolate for ALLOW_CACHE_TTL_MS, keyed by SHA-256(token) + app; a refusal for
 * the much shorter REFUSAL_CACHE_TTL_MS, so a refused session cannot turn every
 * request into a backend call.
 */
function envAnswering(answers: Record<string, boolean>) {
  const fetch = vi.fn(async (req: Request) => {
    const token = req.headers.get("Authorization")!.slice("Bearer ".length);
    const app = new URL(req.url).pathname.split("/")[3];
    return Response.json({ mode: "private", allowed: answers[token] === true || answers[`${token}@${app}`] === true });
  });
  return { env: { API: { fetch } } as unknown as Env, fetch };
}
const request = (token: string, app = "diary") =>
  new Request(`https://${app}.proappstore.online/assets/x.js`, { headers: { Cookie: `__Host-pas_session=${token}` } });

afterEach(() => {
  clearVisibilityAllowCache();
  vi.useRealTimers();
});

describe("host visibility gate: allow cache", () => {
  it("asks the backend once per session and app within the TTL, then again after it", async () => {
    vi.useFakeTimers();
    const { env, fetch } = envAnswering({ good: true });
    for (let i = 0; i < 5; i++) expect(await refuseUnlessVisible(request("good"), env, "diary")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ALLOW_CACHE_TTL_MS + 1);
    expect(await refuseUnlessVisible(request("good"), env, "diary")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caches a refusal briefly, and never lends one session's answer to another session or app", async () => {
    vi.useFakeTimers();
    const { env, fetch } = envAnswering({ good: true });
    expect(await refuseUnlessVisible(request("good"), env, "diary")).toBeNull();
    for (let i = 0; i < 3; i++) expect((await refuseUnlessVisible(request("bad"), env, "diary"))!.status).toBe(403);
    expect((await refuseUnlessVisible(request("bad", "other"), env, "other"))!.status).toBe(403);
    expect(await refuseUnlessVisible(request("good", "other"), env, "other")).toBeNull();
    // 1 (good/diary) + 1 (bad/diary, then cached) + 1 (bad/other) + 1 (good/other: a different app)
    expect(fetch).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(REFUSAL_CACHE_TTL_MS + 1);
    expect((await refuseUnlessVisible(request("bad"), env, "diary"))!.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(REFUSAL_CACHE_TTL_MS).toBeLessThanOrEqual(ALLOW_CACHE_TTL_MS);
  });

  it("an allow on app A does not carry to private app B (the cache key includes the app)", async () => {
    const { env, fetch } = envAnswering({ "alice@app-a": true });
    expect(await refuseUnlessVisible(request("alice", "app-a"), env, "app-a")).toBeNull();
    expect((await refuseUnlessVisible(request("alice", "app-b"), env, "app-b"))!.status).toBe(403);
    expect(await refuseUnlessVisible(request("alice", "app-a"), env, "app-a")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed lookup", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const env = { API: { fetch } } as unknown as Env;
    for (let i = 0; i < 2; i++) expect((await refuseUnlessVisible(request("x"), env, "diary"))!.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a signed-in caller refused on an invite link goes to the platform invite page; elsewhere 403", async () => {
    const { env } = envAnswering({});
    const nav = (path: string) => new Request(`https://diary.proappstore.online${path}`, { headers: { Cookie: "__Host-pas_session=t", "Sec-Fetch-Mode": "navigate" } });
    const join = await refuseUnlessVisible(nav("/join/ab23cd"), env, "diary");
    expect(join!.status).toBe(302);
    expect(join!.headers.get("Location")).toBe("https://diary.proappstore.online/.pas/auth/join?code=AB23CD");
    expect((await refuseUnlessVisible(nav("/notes"), env, "diary"))!.status).toBe(403);
  });
});
