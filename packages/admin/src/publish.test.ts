import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePublish, handleAgentDeploy } from "./publish.js";
import type { Env } from "./env.js";

/**
 * The two ways an app repo gets provisioned must yield the SAME hosting:
 *   - handlePublish     — SDK/CLI publish (`pas publish`, user session)
 *   - handleAgentDeploy — web/agent-teams deploy stage (internal)
 * Both now route through one `provisionApp` core; these tests pin the shared
 * behaviour and the few documented deltas so the two can't silently drift again
 * (the drift was the "CI never started" stuck-deploy bug).
 */

const ENV: Env = {
  CF_ACCOUNT_ID: "acct123",
  PAS_ZONE_ID: "zone123",
  PUBLISHERS_ORG: "proappstore-online",
  APPS_DOMAIN_BASE: "proappstore.online",
  CF_API_TOKEN: "cf-tok",
  GITHUB_TOKEN: "gh-tok",
  SESSION_SIGNING_KEY: "sk",
  INTERNAL_TOKEN: "it",
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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
      if (method === "GET" && /\/pages\/projects\/[^/]+$/.test(url)) return ok({ success: false }, 404);
      if (method === "POST" && /\/pages\/projects$/.test(url)) return ok({ success: true, result: {} });
      // Custom domain
      if (method === "GET" && url.includes("/domains")) return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/domains")) return ok({ success: true, result: {} });
      // DNS CNAME
      if (method === "GET" && url.includes("/dns_records")) return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/dns_records")) {
        return opts.failDnsPost ? ok({ success: false, errors: [{ message: "dns boom" }] }) : ok({ success: true, result: {} });
      }
      // RUM analytics
      if (method === "GET" && url.includes("/rum/site_info/list")) return ok({ success: true, result: [] });
      if (method === "POST" && url.includes("/rum/site_info")) return ok({ success: true, result: {} });
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
    // pushFiles: ref → parent commit → blobs → tree → commit → ref update
    if (url.endsWith("/git/ref/heads/main")) return ok({ object: { sha: "parent" } });
    if (url.includes("/git/commits/parent")) return ok({ tree: { sha: "basetree" } });
    if (url.endsWith("/git/blobs")) { rec.blobs.push(String(body?.content ?? "")); return ok({ sha: `blob${rec.blobs.length}` }); }
    if (url.endsWith("/git/trees")) return ok({ sha: "tree1" });
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
      { id: "widget", name: "Widget", category: "Productivity", icon: "🧩", iconBg: "#000", description: "d" },
      ENV,
    );
    expect(r.success).toBe(true);
    expect(names(r)).toEqual(["GitHub repo", "CF Pages project", "custom domain", "DNS", "Registry", "Analytics"]);
    expect(rec.blobs).toHaveLength(0); // CLI pushes app files itself
  });

  it("handleAgentDeploy provisions the same hosting + pushes files, no registry", async () => {
    const rec = install();
    const r = await handleAgentDeploy(
      { id: "widget", name: "Widget", files: { "index.html": "<h1>hi</h1>", "package.json": "{}" } },
      ENV,
    );
    expect(r.success).toBe(true);
    expect(r.commitSha).toBe("commit-abc");
    expect(r.repoUrl).toBe("https://github.com/proappstore-online/widget");
    expect(names(r)).toEqual(["GitHub repo", "CF Pages project", "custom domain", "DNS", "Analytics", "Push files"]);
    expect(names(r)).not.toContain("Registry");
    expect(rec.blobs.length).toBeGreaterThan(0);
  });

  it("both paths touch the IDENTICAL Cloudflare hosting surface for the same app", async () => {
    const pubRec = install();
    await handlePublish({ id: "same", name: "Same", category: "C", icon: "x", iconBg: "#000", description: "d" }, ENV);
    const agentRec = install();
    await handleAgentDeploy({ id: "same", name: "Same", files: { "a.txt": "x" } }, ENV);
    expect(cfHosting(agentRec)).toEqual(cfHosting(pubRec));
    // and the surface actually includes the load-bearing bits
    expect(cfHosting(pubRec)).toContain("POST /accounts/acct123/pages/projects");
    expect(cfHosting(pubRec)).toContain("POST /zones/zone123/dns_records");
    expect(cfHosting(pubRec)).toContain("POST /accounts/acct123/rum/site_info");
  });
});

describe("deploy-workflow injection (agent path)", () => {
  it("injects a layout-adaptive deploy.yml when the bundle has none", async () => {
    const rec = install();
    await handleAgentDeploy({ id: "flatapp", name: "Flat", files: { "index.html": "x" } }, ENV);
    const wf = rec.blobs.find((b) => b.includes("wrangler") && b.includes("pages deploy"));
    expect(wf, "a deploy workflow blob should be pushed").toBeTruthy();
    expect(wf).toContain("--project-name=proappstore-${{ github.event.repository.name }}");
    expect(wf).toContain("if [ -d web/dist ]"); // adaptive: web/dist OR dist
    expect(wf).toContain("CLOUDFLARE_ACCOUNT_ID: acct123");
    expect(wf).toContain("${{ secrets.CLOUDFLARE_API_TOKEN }}"); // org-level secret
    expect(wf).toContain("--no-frozen-lockfile"); // agents commit no lockfile
    expect(wf).toContain("npx playwright test"); // behavioural gate runs after deploy
    expect(wf).toContain("@vibecodeqa/cli"); // code-health scan (report-only)
    expect(wf).toContain(".vcqa/report.json"); // written into dist for the Dev Ops tab
    // 1 input file + injected deploy.yml + 4 E2E harness files (config, fixtures,
    // package.json, baseline smoke spec).
    expect(rec.blobs).toHaveLength(6);
    expect(rec.blobs.some((b) => b.includes("@playwright/test"))).toBe(true);
    expect(rec.blobs.some((b) => b.includes("fas_session"))).toBe(true); // auth fixture
  });

  it("does NOT inject a deploy workflow when the bundle already carries one", async () => {
    const rec = install();
    await handleAgentDeploy(
      { id: "hasci", name: "Has CI", files: { "index.html": "x", ".github/workflows/ci.yml": "name: ci" } },
      ENV,
    );
    // No deploy.yml injected (bundle has its own workflow)...
    expect(rec.blobs.some((b) => b.includes("pages deploy"))).toBe(false);
    // ...but the E2E harness is still added: 2 input + 4 harness files.
    expect(rec.blobs).toHaveLength(6);
  });

  it("does NOT clobber QA-authored e2e specs (skips the baseline smoke)", async () => {
    const rec = install();
    await handleAgentDeploy(
      { id: "hasspec", name: "Has Spec", files: { "index.html": "x", "e2e/specs/booking.spec.ts": "// authored" } },
      ENV,
    );
    // input index.html + authored spec + deploy.yml + 3 harness files
    // (config, fixtures, package.json) — baseline smoke.spec.ts NOT added.
    expect(rec.blobs.some((b) => b.includes("// authored"))).toBe(true);
    expect(rec.blobs.some((b) => b.includes("app boots and mounts"))).toBe(false); // baseline skipped
    expect(rec.blobs).toHaveLength(6);
  });
});

describe("documented divergences", () => {
  it("DNS failure is FATAL for publish but TOLERATED for agent deploy", async () => {
    install({ failDnsPost: true });
    const pub = await handlePublish(
      { id: "dnsfail", name: "X", category: "C", icon: "x", iconBg: "#000", description: "d" },
      ENV,
    );
    expect(pub.success).toBe(false);
    expect(names(pub)).not.toContain("Registry"); // stopped at DNS, before registry

    install({ failDnsPost: true });
    const agent = await handleAgentDeploy({ id: "dnsfail", name: "X", files: { "a.txt": "x" } }, ENV);
    expect(agent.success).toBe(true); // CI still ships to *.pages.dev
    expect(names(agent)).toContain("Push files"); // proceeded past DNS to push
  });

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
