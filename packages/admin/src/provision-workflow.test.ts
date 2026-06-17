import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { ProvisionValidationError, runProvisionSteps, type StepRunner } from "./publish.js";

/**
 * The provisioning step sequence that ProvisionWorkflow drives. We test it here
 * (Node) by injecting a step runner — the workflow shell injects `step.do`, so
 * this pins the exact orchestration the durable workflow executes without
 * needing the workerd-only runtime.
 */

const fakeDb = {
  prepare: (_sql: string) => ({
    bind: (..._args: unknown[]) => ({
      run: async () => ({ meta: {}, success: true }),
      first: async () => null,
    }),
  }),
} as unknown as D1Database;

const ENV: Env = {
  CF_ACCOUNT_ID: "acct123",
  PAS_ZONE_ID: "zone123",
  PUBLISHERS_ORG: "proappstore-online",
  APPS_DOMAIN_BASE: "proappstore.online",
  CF_API_TOKEN: "cf-tok",
  GITHUB_TOKEN: "gh-tok",
  SESSION_SIGNING_KEY: "sk",
  INTERNAL_TOKEN: "it",
  DB: fakeDb,
  PROVISION_WORKFLOW: undefined as unknown as Workflow,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Minimal happy-path mock for repo create + collaborator + registry + analytics.
 *  `failRepoCreate` forces the GitHub repo POST to error (fatal step). */
function install(opts: { failRepoCreate?: boolean } = {}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

    if (url.includes("api.cloudflare.com")) {
      if (method === "GET" && url.includes("/rum/site_info/list")) return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/rum/site_info")) return ok({ success: true, result: {} });
      return ok({ success: true });
    }
    // GitHub
    if (method === "POST" && url.endsWith("/repos"))
      return opts.failRepoCreate ? ok({ message: "boom" }, 422) : ok({ id: 1 }, 201);
    if (url.includes("/collaborators/")) return new Response(null, { status: 204 });
    if (url.includes("/contents/registry.json")) {
      if (method === "PUT") return ok({ commit: { sha: "rcommit" } });
      return ok({ sha: "rsha", content: Buffer.from('{"apps":[]}').toString("base64") });
    }
    // pushFiles: ref → parent commit → blobs → tree → commit → ref update
    if (url.endsWith("/git/ref/heads/main")) return ok({ object: { sha: "parent" } });
    if (url.includes("/git/commits/parent")) return ok({ tree: { sha: "basetree" } });
    if (url.endsWith("/git/blobs")) return ok({ sha: "blob1" });
    if (url.endsWith("/git/trees")) return ok({ sha: "tree1" });
    if (url.endsWith("/git/commits")) return ok({ sha: "commit-abc" });
    if (url.endsWith("/git/refs/heads/main")) return ok({ ref: "refs/heads/main" });
    if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) return ok({}, 404); // repoExists → no
    return ok({});
  }) as typeof fetch;
}

const REQ = { id: "myapp", name: "My App", category: "tools", icon: "X", iconBg: "#000", description: "d", creatorGithub: "alice" };

/** A pass-through runner that records the durable step names in order. */
function recordingRunner(): { ran: string[]; run: StepRunner } {
  const ran: string[] = [];
  const run: StepRunner = async (name, cb) => {
    const r = await cb();
    ran.push(name);
    return r;
  };
  return { ran, run };
}

describe("runProvisionSteps (ProvisionWorkflow sequence)", () => {
  it("runs the publish path as discrete durable steps, in order", async () => {
    install();
    const { ran, run } = recordingRunner();
    const result = await runProvisionSteps({ req: REQ, addRegistry: true }, ENV, run);

    expect(ran).toEqual(["github-repo", "collaborator", "r2-route", "registry", "analytics"]);
    expect(result.steps).toHaveLength(5);
    expect(result.repoUrl).toBe("https://github.com/proappstore-online/myapp");
  });

  it("omits the registry step when addRegistry is false (agent path shape)", async () => {
    install();
    const { ran } = recordingRunner();
    const run: StepRunner = async (name, cb) => {
      const r = await cb();
      ran.push(name);
      return r;
    };
    await runProvisionSteps({ req: REQ, addRegistry: false }, ENV, run);
    expect(ran).toEqual(["github-repo", "collaborator", "r2-route", "analytics"]);
  });

  it("skips the collaborator step when no creator is given", async () => {
    install();
    const { ran, run } = recordingRunner();
    const { creatorGithub: _omit, ...noCreator } = REQ;
    await runProvisionSteps({ req: noCreator, addRegistry: true }, ENV, run);
    expect(ran).toEqual(["github-repo", "r2-route", "registry", "analytics"]);
  });

  it("runs the agent path (push, no registry) and returns a commit sha", async () => {
    install();
    const { ran, run } = recordingRunner();
    const result = await runProvisionSteps(
      { req: REQ, addRegistry: false, files: { "index.html": "<html></html>" } },
      ENV,
      run,
    );
    expect(ran).toEqual(["github-repo", "collaborator", "r2-route", "analytics", "push-files"]);
    expect(result.commitSha).toBe("commit-abc");
  });

  it("throws (non-retryable) on a bad id before any step runs", async () => {
    install();
    const { ran, run } = recordingRunner();
    await expect(
      runProvisionSteps({ req: { ...REQ, id: "Bad_ID" }, addRegistry: true }, ENV, run),
    ).rejects.toBeInstanceOf(ProvisionValidationError);
    expect(ran).toEqual([]);
  });

  it("propagates a fatal step failure so the engine can retry it", async () => {
    install({ failRepoCreate: true });
    const { ran, run } = recordingRunner();
    await expect(
      runProvisionSteps({ req: REQ, addRegistry: true }, ENV, run),
    ).rejects.toThrow(/GitHub repo/);
    expect(ran).toEqual([]); // fatal step threw before being recorded
  });
});
