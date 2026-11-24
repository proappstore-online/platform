import { mintSession } from "@proappstore/build-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(async () => ({ ok: true })),
  publish: vi.fn(async () => ({ success: true, published: true })),
  claim: vi.fn(),
  teamOwner: vi.fn(async () => null as { owner: number } | null),
}));
vi.mock("@proappstore/build-core", async (orig) => ({ ...(await orig<typeof import("@proappstore/build-core")>()), appClaim: mocks.claim }));
vi.mock("./provision-guard.js", async (orig) => ({ ...(await orig<typeof import("./provision-guard.js")>()), guardProvisionRequest: mocks.guard }));
vi.mock("./publish.js", async (orig) => ({ ...(await orig<typeof import("./publish.js")>()), handlePublish: mocks.publish }));

import worker from "./index.js";
import type { Env } from "./env.js";

const KEY = "test-signing-key";
const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first: mocks.teamOwner })) }));
const env = { SESSION_SIGNING_KEY: KEY, INTERNAL_TOKEN: "internal-secret", DB: { prepare } } as unknown as Env;
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
  mocks.claim.mockReset();
  mocks.teamOwner.mockReset();
  mocks.teamOwner.mockResolvedValue(null);
  prepare.mockClear();
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

  it.each(["Serge Ivy", "victim-login"])("publishes an existing Google-owned app without treating %s as a GitHub collaborator", async (login) => {
    const token = await mintSession({ uid: "google:123", login, roles: ["user"] }, KEY);
    mocks.claim.mockResolvedValue({ creator_id: "google:123" });
    const res = await post({ "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}`, "X-PAS-Login": "spoofed-login" }, { id: "owned-app", creatorGithub: "victim" });
    expect(res.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(env.DB, "owned-app", env.APPS_DOMAIN_BASE);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ creatorGithub: undefined }), env);
  });

  it("takes a GitHub collaborator only from the signed GitHub identity", async () => {
    const token = await mintSession({ uid: "gh:42", login: "real-owner", roles: ["user"] }, KEY);
    mocks.claim.mockResolvedValue({ creator_id: "gh:42" });
    expect((await post({ "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}`, "X-PAS-Login": "victim" }, { id: "owned-app", creatorGithub: "victim" })).status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ creatorGithub: "real-owner" }), env);
  });

  it("preserves explicit team-owner publishing while requiring the owner role", async () => {
    const token = await mintSession({ uid: "google:123", login: "Serge Ivy", roles: ["user"] }, KEY);
    mocks.claim.mockResolvedValue({ creator_id: "gh:42" });
    mocks.teamOwner.mockResolvedValue({ owner: 1 });
    expect((await post({ "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}` })).status).toBe(200);
    expect(prepare).toHaveBeenCalledWith("SELECT 1 FROM team_members WHERE app_id = ? AND user_id = ? AND role = 'owner'");
    expect(prepare.mock.results[0]!.value.bind).toHaveBeenCalledWith("owned-app", "google:123");
  });

  it.each([null, { creator_id: "gh:42" }, { creator_id: "google:123", alias_reserved: true }])("refuses missing, transferred or reserved apps: %j", async (claim) => {
    const token = await mintSession({ uid: "google:123", login: "Serge Ivy", roles: ["user"] }, KEY);
    mocks.claim.mockResolvedValue(claim);
    expect((await post({ "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}` })).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses a retired app ID with 409 (#686)", async () => {
    const token = await mintSession({ uid: "google:123", login: "Serge Ivy", roles: ["user"] }, KEY);
    mocks.claim.mockResolvedValue({ creator_id: null, alias_reserved: 0, retired: 1 });
    const response = await post({ "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}` });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "app ID retired" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not fall back to a trusted login when the forwarded session is invalid", async () => {
    const credential = await mintSession({ uid: "cred:123", login: "victim", roles: ["user"] }, KEY);
    const forged = await mintSession({ uid: "google:123", login: "victim", roles: ["user"] }, "wrong-key");
    const expired = await mintSession({ uid: "google:123", login: "victim", roles: ["user"] }, KEY, -1);
    for (const token of ["invalid", credential, forged, expired]) {
      expect((await post({ "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}`, "X-PAS-Login": "victim" })).status).toBe(401);
    }
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not accept a Google session without the trusted service credential", async () => {
    const token = await mintSession({ uid: "google:123", login: "victim", roles: ["user"] }, KEY);
    expect((await post({ "X-Internal-Token": "wrong", Authorization: `Bearer ${token}` })).status).toBe(401);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("applies the same owner check before starting a durable publish workflow", async () => {
    const token = await mintSession({ uid: "google:123", login: "Serge Ivy", roles: ["user"] }, KEY);
    const create = vi.fn(async () => ({ id: "receipt", status: async () => ({ status: "running" }) }));
    const request = () => new Request("https://admin.proappstore.online/api/provision-workflow", {
      method: "POST", headers: { "X-Internal-Token": "internal-secret", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "owned-app", creatorGithub: "victim" }),
    });
    const workflowEnv = { ...env, PROVISION_WORKFLOW: { create } } as unknown as Env;
    mocks.claim.mockResolvedValue({ creator_id: "gh:42" });
    expect((await worker.fetch(request(), workflowEnv, ctx)).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    mocks.claim.mockResolvedValue({ creator_id: "google:123" });
    expect((await worker.fetch(request(), workflowEnv, ctx)).status).toBe(202);
    expect(create).toHaveBeenCalledWith({ params: { req: { id: "owned-app", creatorGithub: undefined }, addRegistry: true } });
  });
});
