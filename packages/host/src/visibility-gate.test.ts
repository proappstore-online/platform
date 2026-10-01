import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { ALLOW_CACHE_TTL_MS, clearVisibilityAllowCache, refuseUnlessVisible } from "./visibility-gate.js";

/**
 * #259 review: a private app's page loads many assets, and each used to cost a
 * backend visibility/me call (~4 D1 queries). An ALLOW is now remembered per
 * isolate for ALLOW_CACHE_TTL_MS, keyed by SHA-256(token) + app; a refusal never is.
 */
function envAnswering(answers: Record<string, boolean>) {
  const fetch = vi.fn(async (req: Request) => {
    const token = req.headers.get("Authorization")!.slice("Bearer ".length);
    return Response.json({ mode: "private", allowed: answers[token] === true });
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

  it("never caches a refusal, and never lends one session's allow to another session or app", async () => {
    const { env, fetch } = envAnswering({ good: true });
    expect(await refuseUnlessVisible(request("good"), env, "diary")).toBeNull();
    for (let i = 0; i < 3; i++) expect((await refuseUnlessVisible(request("bad"), env, "diary"))!.status).toBe(403);
    expect((await refuseUnlessVisible(request("bad", "other"), env, "other"))!.status).toBe(403);
    expect(await refuseUnlessVisible(request("good", "other"), env, "other")).toBeNull();
    // 1 (good/diary) + 3 (bad, never cached) + 1 (bad/other) + 1 (good/other: a different app)
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
