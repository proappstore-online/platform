import { mintSession } from "@proappstore/build-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(async () => ({ ok: true })),
  publish: vi.fn(async () => ({ success: true, published: true })),
}));
vi.mock("./provision-guard.js", async (orig) => ({ ...(await orig<typeof import("./provision-guard.js")>()), guardProvisionRequest: mocks.guard }));
vi.mock("./publish.js", async (orig) => ({ ...(await orig<typeof import("./publish.js")>()), handlePublish: mocks.publish }));

import worker from "./index.js";
import type { Env } from "./env.js";

const KEY = "test-signing-key";
const env = { SESSION_SIGNING_KEY: KEY, INTERNAL_TOKEN: "internal-secret" } as Env;
const ctx = {} as ExecutionContext;
const post = (headers: Record<string, string>, body: Record<string, unknown> = { id: "owned-app" }) =>
  worker.fetch(new Request("https://admin.proappstore.online/api/publish-app", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env, ctx);

afterEach(() => {
  mocks.guard.mockClear();
  mocks.publish.mockClear();
});

describe("admin publish identities (#327)", () => {
  it("refuses Google, credential, and non-numeric gh sessions before the guard", async () => {
    for (const claims of [
      { uid: "google:subject", login: "victim" },
      { uid: "cred:student", login: "victim" },
      { uid: "gh:not-a-number", login: "victim" },
    ]) {
      const token = await mintSession({ ...claims, roles: ["user"] }, KEY);
      expect((await post({ Authorization: `Bearer ${token}` })).status, claims.uid).toBe(401);
    }
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("passes the immutable GitHub uid to ownership authorization, never the editable login", async () => {
    const token = await mintSession({ uid: "gh:42", login: "victim-login", roles: ["user"] }, KEY);

    expect((await post({ Authorization: `Bearer ${token}` })).status).toBe(200);
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ appId: "owned-app", userId: "gh:42" }));
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ creatorGithub: "victim-login" }), env);
  });

  it("keeps trusted internal publishing separate from user-session authorization", async () => {
    expect((await post({ "X-Internal-Token": "internal-secret", "X-PAS-Login": "service-owner" })).status).toBe(200);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ creatorGithub: "service-owner" }), env);
  });
});
