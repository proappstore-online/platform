import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { deployWorkflowYaml, handleAgentDeploy, handlePublish } from "./publish.js";

/**
 * The two ways an app repo gets provisioned must yield the SAME hosting:
 *   - handlePublish     — SDK/CLI publish (`pas publish`, user session)
 *   - handleAgentDeploy — web/agent-teams deploy stage (internal)
 * Both now route through one `provisionApp` core; these tests pin the shared
 * behaviour and the few documented deltas so the two can't silently drift again
 * (the drift was the "CI never started" stuck-deploy bug).
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

interface Recorder {
  calls: { method: string; url: string }[];
  blobs: string[]; // contents pushed via the Git Data API (one per file)
}

/** Install a fetch mock that satisfies the full provision happy-path for both
 *  GitHub and Cloudflare, recording every call. `fail` forces a specific POST to
 *  return an error so we can exercise fatal-vs-tolerated branches. */
function install(opts: { failDnsPost?: boolean } = {}): Recorder {
  const rec: Recorder = { calls: [], blobs: [] };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    rec.calls.push({ method, url });
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

    // ---- Cloudflare API ----
    if (url.includes("api.cloudflare.com")) {
      // Pages project existence check → "not found" so it gets created
      if (method === "GET" && /\/pages\/projects\/[^/]+$/.test(url))
        return ok({ success: false }, 404);
      if (method === "POST" && /\/pages\/projects$/.test(url))
        return ok({ success: true, result: {} });
      // Custom domain
      if (method === "GET" && url.includes("/domains")) return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/domains")) return ok({ success: true, result: {} });
      // DNS CNAME
      if (method === "GET" && url.includes("/dns_records"))
        return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/dns_records")) {
        return opts.failDnsPost
          ? ok({ success: false, errors: [{ message: "dns boom" }] })
          : ok({ success: true, result: {} });
      }
      // RUM analytics
      if (method === "GET" && url.includes("/rum/site_info/list"))
        return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/rum/site_info"))
        return ok({ success: true, result: {} });
      return ok({ success: true });
    }

    // ---- GitHub API ----
    // createRepo
    if (method === "POST" && url.endsWith("/repos")) return ok({ id: 1 }, 201);
    // registry.json read/write (storefront repo)
    if (url.includes("/contents/registry.json")) {
      if (method === "PUT") return ok({ commit: { sha: "rcommit" } });
      return ok({ sha: "rsha", content: Buffer.from('{"apps":[]}').toString("base64") });
    }
    // pushFiles: ref → parent commit → tree(inline content) → commit → ref update.
    // Files are embedded as inline tree content now (not per-file blobs), so record
    // each tree item's content as a "pushed file" for the content/count assertions.
    if (url.endsWith("/git/ref/heads/main")) return ok({ object: { sha: "parent" } });
    if (url.includes("/git/commits/parent")) return ok({ tree: { sha: "basetree" } });
    if (url.endsWith("/git/blobs")) {
      rec.blobs.push(String(body?.content ?? ""));
      return ok({ sha: `blob${rec.blobs.length}` });
    }
    if (url.endsWith("/git/trees")) {
      for (const item of (body?.tree as { content?: string }[] | undefined) ?? []) {
        if (typeof item.content === "string") rec.blobs.push(item.content);
      }
      return ok({ sha: "tree1" });
    }
    if (url.endsWith("/git/commits")) return ok({ sha: "commit-abc" });
    if (url.endsWith("/git/refs/heads/main")) return ok({ ref: "refs/heads/main" });
    // repoExists (GET /repos/org/id) → not found so createRepo proceeds
    if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) return ok({}, 404);
    return ok({});
  }) as typeof fetch;
  return rec;
}

/** CF hosting endpoints touched (method + path), order-independent — the shared
 *  surface that must be identical across both provisioning paths. */
function cfHosting(rec: Recorder): string[] {
  return rec.calls
    .filter((c) => c.url.includes("api.cloudflare.com"))
    .map((c) => `${c.method} ${c.url.split("/client/v4")[1]!.split("?")[0]}`)
    .sort();
}

const names = (r: { steps: { name: string }[] }) => r.steps.map((s) => s.name);

describe("provisioning: shared core", () => {
  it("handlePublish provisions hosting + registry, succeeds, pushes no files", async () => {
    const rec = install();
    const r = await handlePublish(
      {
        id: "widget",
        name: "Widget",
        category: "Productivity",
        icon: "🧩",
        iconBg: "#000",
        description: "d",
      },
      ENV,
    );
    expect(r.success).toBe(true);
    expect(names(r)).toEqual(["GitHub repo", "R2 route", "Registry", "Analytics", "Deploy secrets"]);
    expect(rec.blobs).toHaveLength(0); // CLI pushes app files itself
  });

  it("handleAgentDeploy provisions the same hosting + pushes files, no registry", async () => {
    const rec = install();
    const r = await handleAgentDeploy(
      {
        id: "widget",
        name: "Widget",
        files: { "index.html": "<h1>hi</h1>", "package.json": "{}" },
      },
      ENV,
    );
    expect(r.success).toBe(true);
    expect(r.commitSha).toBe("commit-abc");
    expect(r.repoUrl).toBe("https://github.com/proappstore-online/widget");
    expect(names(r)).toEqual(["GitHub repo", "R2 route", "Analytics", "Deploy secrets", "Push files"]);
    expect(names(r)).not.toContain("Registry");
    expect(rec.blobs.length).toBeGreaterThan(0);
  });

  it("both paths touch the IDENTICAL Cloudflare hosting surface for the same app", async () => {
    const pubRec = install();
    await handlePublish(
      { id: "same", name: "Same", category: "C", icon: "x", iconBg: "#000", description: "d" },
      ENV,
    );
    const agentRec = install();
    await handleAgentDeploy({ id: "same", name: "Same", files: { "a.txt": "x" } }, ENV);
    expect(cfHosting(agentRec)).toEqual(cfHosting(pubRec));
    // the surface includes the analytics step (R2 route is via D1, not CF API)
    expect(cfHosting(pubRec)).toContain("POST /accounts/acct123/rum/site_info");
  });
});

describe("canonical deploy workflow — single source of truth", () => {
  // deployWorkflowYaml() is THE canonical deploy workflow. The committed golden
  // (__fixtures__/canonical-deploy.yml) is what the sync script pushes to the
  // template-app repo (the CLI/MCP clone source). This test ties them together:
  // any change to the generator fails here until the golden is regenerated, so
  // the change is intentional, reviewable in the diff, and re-syncable to
  // template-app via `scripts/sync-template-workflow.mjs`. No silent drift.
  it("generator output is byte-identical to the committed golden file", () => {
    const golden = readFileSync(new URL("./__fixtures__/canonical-deploy.yml", import.meta.url), "utf8");
    expect(deployWorkflowYaml(ENV)).toBe(golden);
  });

  it("the golden never reintroduces the lockfile-coupled cache or CF Pages", () => {
    const golden = readFileSync(new URL("./__fixtures__/canonical-deploy.yml", import.meta.url), "utf8");
    expect(golden).not.toContain("cache: pnpm");
    expect(golden).not.toContain("pages deploy");
    expect(golden).toContain("--no-frozen-lockfile");
  });
});

describe("deploy-workflow injection (agent path)", () => {
  it("injects a layout-adaptive deploy.yml when the bundle has none", async () => {
    const rec = install();
    await handleAgentDeploy({ id: "flatapp", name: "Flat", files: { "index.html": "x" } }, ENV);
    const wf = rec.blobs.find((b) => b.includes("Deploy to R2") && b.includes("aws s3 sync"));
    expect(wf, "an R2 deploy workflow blob should be pushed").toBeTruthy();
    expect(wf).toContain("s3://pas-apps/apps/");
    expect(wf).toContain("if [ -d web/dist ]"); // adaptive: web/dist OR dist
    expect(wf).toContain("R2_ACCESS_KEY_ID"); // R2 credentials (secrets || vars)
    expect(wf).toContain("--no-frozen-lockfile"); // agents commit no lockfile
    expect(wf).not.toContain("cache: pnpm"); // no lockfile committed → cache:pnpm would hard-fail setup-node
    expect(wf).toContain("npx playwright test"); // behavioural gate runs after deploy
    expect(wf).toContain("@vibecodeqa/cli@0.44.0"); // code-health scan (report-only)
    expect(wf).toContain(".vcqa/report.json"); // written into dist for the Dev Ops tab
    // KB publish workflow injected too (Zensical → R2 → kb.proappstore.online).
    expect(
      rec.blobs.some((b) => b.includes("Publish Knowledge Base") && b.includes("zensical build")),
    ).toBe(true);
    expect(rec.blobs.some((b) => b.includes("kb.proappstore.online"))).toBe(true);
    // 1 input file + injected deploy.yml + 4 E2E harness files (config, fixtures,
    // package.json, baseline smoke spec).
    expect(rec.blobs).toHaveLength(7); // +kb.yml
    expect(rec.blobs.some((b) => b.includes("@playwright/test"))).toBe(true);
    expect(rec.blobs.some((b) => b.includes("pas_session"))).toBe(true); // auth fixture
  });

  it("STRIPS an agent-authored workflow and injects the canonical deploy.yml", async () => {
    // The platform owns CI. An agent-authored workflow is drift (and has shipped
    // broken — e.g. `cache: pnpm` with no committed lockfile), so it must be
    // discarded and replaced with our known-good, lockfile-safe deploy.yml.
    const rec = install();
    await handleAgentDeploy(
      {
        id: "hasci",
        name: "Has CI",
        files: {
          "index.html": "x",
          ".github/workflows/ci.yml": "uses: actions/setup-node@v4\n  with:\n    cache: pnpm",
        },
      },
      ENV,
    );
    // The agent's broken workflow is NOT pushed...
    expect(rec.blobs.some((b) => b.includes("cache: pnpm"))).toBe(false);
    // ...and our canonical R2 deploy workflow IS injected instead.
    const wf = rec.blobs.find((b) => b.includes("Deploy to R2") && b.includes("aws s3 sync"));
    expect(wf, "the canonical deploy workflow should be injected").toBeTruthy();
    expect(wf).toContain("--no-frozen-lockfile");
    // 1 surviving input (ci.yml stripped) + deploy.yml + kb.yml + 4 E2E harness files.
    expect(rec.blobs).toHaveLength(7);
  });

  it("strips MULTIPLE agent-authored workflows but keeps the app's own KB workflow path", async () => {
    // Defence in depth: an agent could scatter several workflow files under
    // various names. ALL must be discarded so none can preempt our deploy or
    // reintroduce a lockfile-coupled cache. kb.yml is ours and is (re)injected.
    const rec = install();
    await handleAgentDeploy(
      {
        id: "multi",
        name: "Multi",
        files: {
          "index.html": "x",
          ".github/workflows/ci.yml": "name: ci\n  cache: pnpm",
          ".github/workflows/build.yaml": "name: build\n  cache: pnpm",
          ".github/workflows/release.yml": "name: release",
        },
      },
      ENV,
    );
    // None of the agent workflows survive...
    expect(rec.blobs.some((b) => b.includes("name: ci"))).toBe(false);
    expect(rec.blobs.some((b) => b.includes("name: build"))).toBe(false);
    expect(rec.blobs.some((b) => b.includes("name: release"))).toBe(false);
    expect(rec.blobs.some((b) => b.includes("cache: pnpm"))).toBe(false);
    // ...and exactly our canonical deploy + KB workflows are present.
    expect(rec.blobs.filter((b) => b.includes("name: Deploy to R2"))).toHaveLength(1);
    expect(rec.blobs.filter((b) => b.includes("Publish Knowledge Base"))).toHaveLength(1);
    // 1 surviving input + deploy.yml + kb.yml + 4 E2E harness files.
    expect(rec.blobs).toHaveLength(7);
  });

  it("does NOT clobber QA-authored e2e specs (skips the baseline smoke)", async () => {
    const rec = install();
    await handleAgentDeploy(
      {
        id: "hasspec",
        name: "Has Spec",
        files: { "index.html": "x", "e2e/specs/booking.spec.ts": "// authored" },
      },
      ENV,
    );
    // input index.html + authored spec + deploy.yml + 3 harness files
    // (config, fixtures, package.json) — baseline smoke.spec.ts NOT added.
    expect(rec.blobs.some((b) => b.includes("// authored"))).toBe(true);
    expect(rec.blobs.some((b) => b.includes("app boots and mounts"))).toBe(false); // baseline skipped
    expect(rec.blobs).toHaveLength(7); // +kb.yml
  });
});

describe("documented divergences", () => {
  it("rejects an invalid id on both paths with a Validation step", async () => {
    install();
    const pub = await handlePublish(
      { id: "Bad_ID", name: "X", category: "C", icon: "x", iconBg: "#000", description: "d" },
      ENV,
    );
    expect(pub.success).toBe(false);
    expect(pub.steps[0]!.name).toBe("Validation");

    install();
    const agent = await handleAgentDeploy({ id: "Bad_ID", name: "X", files: {} }, ENV);
    expect(agent.success).toBe(false);
    expect(agent.steps[0]!.name).toBe("Validation");
    expect(agent.repoUrl).toBeNull();
  });
});
