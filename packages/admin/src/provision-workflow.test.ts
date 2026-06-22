import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import {
  type CiCheck,
  pollCiToVerdict,
  ProvisionValidationError,
  runProvisionSteps,
  type StepRunner,
} from "./publish.js";

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

  it("agent path with a passing CI gate records ci-gate ok", async () => {
    install();
    const { ran, run } = recordingRunner();
    const result = await runProvisionSteps(
      { req: REQ, addRegistry: false, files: { "index.html": "<html></html>" } },
      ENV,
      run,
      async (sha) => {
        expect(sha).toBe("commit-abc"); // graded against the exact pushed commit
        return { ok: true, conclusion: "success", url: "https://run" };
      },
    );
    expect(ran).toContain("push-files");
    const gate = result.steps.find((s) => s.name === "CI gate");
    expect(gate?.status).toBe("ok");
  });

  it("agent path with a failing CI gate throws (bounces the ticket)", async () => {
    install();
    const { run } = recordingRunner();
    await expect(
      runProvisionSteps(
        { req: REQ, addRegistry: false, files: { "index.html": "<html></html>" } },
        ENV,
        run,
        async () => ({ ok: false, conclusion: "failure", errorTail: "TS2322: type error" }),
      ),
    ).rejects.toThrow(/CI gate: build failure[\s\S]*TS2322/);
  });

  it("refuses to grade the CI gate when the push produced no commit sha", async () => {
    install();
    // A waiter that would (wrongly) pass — the guard must fire BEFORE it's called,
    // so a missing sha can never grade a stale run as green.
    let waiterCalled = false;
    await expect(
      runProvisionSteps(
        // Force commitSha undefined: a push step that reports ok but no sha.
        { req: REQ, addRegistry: false, files: { "index.html": "<html></html>" } },
        { ...ENV, GITHUB_TOKEN: "gh-tok" },
        async (name, cb) => {
          const r = await cb();
          if (name === "push-files") delete (r as { commitSha?: string }).commitSha;
          return r;
        },
        async () => {
          waiterCalled = true;
          return { ok: true };
        },
      ),
    ).rejects.toThrow(/no commit sha/);
    expect(waiterCalled).toBe(false);
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

describe("pollCiToVerdict (CI gate poll loop)", () => {
  /** Pass-through step.do + a sleep spy that records each durable wait. */
  function harness(checks: CiCheck[]) {
    const polls: string[] = [];
    const sleeps: string[] = [];
    let i = 0;
    return {
      polls,
      sleeps,
      deps: {
        check: async () => checks[Math.min(i++, checks.length - 1)]!,
        doStep: async <T>(name: string, cb: () => Promise<T>) => {
          polls.push(name);
          return cb();
        },
        sleep: async (name: string, _d: string) => {
          sleeps.push(name);
        },
      },
    };
  }

  it("returns on the first poll when CI is already terminal (no sleep)", async () => {
    const { deps, polls, sleeps } = harness([
      { status: "completed", ok: true, conclusion: "success", url: "https://run" },
    ]);
    const v = await pollCiToVerdict(deps);
    expect(v).toEqual({ ok: true, conclusion: "success", url: "https://run" });
    expect(polls).toEqual(["ci-poll-0"]);
    expect(sleeps).toEqual([]); // terminal first time → never sleeps
  });

  it("sleeps and re-polls while CI is pending/in_progress, then grades it", async () => {
    const { deps, polls, sleeps } = harness([
      { status: "pending", ok: false }, // no run registered yet
      { status: "in_progress", ok: false }, // building
      { status: "completed", ok: false, conclusion: "failure", errorTail: "TS2322" },
    ]);
    const v = await pollCiToVerdict(deps);
    expect(v).toEqual({ ok: false, conclusion: "failure", errorTail: "TS2322" });
    expect(polls).toEqual(["ci-poll-0", "ci-poll-1", "ci-poll-2"]);
    expect(sleeps).toEqual(["ci-wait-0", "ci-wait-1"]); // one sleep per non-terminal poll
  });

  it("returns a timeout verdict if CI never finishes within the budget", async () => {
    const { deps, polls, sleeps } = harness([{ status: "in_progress", ok: false }]);
    const v = await pollCiToVerdict({ ...deps, maxPolls: 3, interval: "1 second" });
    expect(v.ok).toBe(false);
    expect(v.conclusion).toBe("timeout");
    expect(polls).toEqual(["ci-poll-0", "ci-poll-1", "ci-poll-2"]);
    expect(sleeps).toEqual(["ci-wait-0", "ci-wait-1", "ci-wait-2"]);
  });
});
