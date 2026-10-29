import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.js";
import { addToRegistry, APP_DEPLOY_TAG, APP_DEPLOY_WORKFLOW, buildAgentBundle, deployWorkflowYaml, handleAgentDeploy, handlePublish, isPrivateForRegistry, kbWorkflowYaml, reconcileStorefrontPublication } from "./publish.js";

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
function install(opts: { failDnsPost?: boolean; registryConflicts?: number } = {}): Recorder {
  const rec: Recorder = { calls: [], blobs: [] };
  let registryPuts = 0;
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
      if (method === "PUT") {
        registryPuts++;
        // #60: simulate a concurrent writer — the first N PUTs lose the race (409).
        if (registryPuts <= (opts.registryConflicts ?? 0)) return ok({ message: "registry.json does not match rsha" }, 409);
        return ok({ commit: { sha: "rcommit" } });
      }
      return ok({ sha: `rsha${registryPuts}`, content: Buffer.from('{"apps":[]}').toString("base64") });
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
    expect(names(r)).toEqual(["GitHub repo", "R2 route", "Registry", "Analytics", "OIDC test login"]);
    expect(rec.blobs).toHaveLength(0); // CLI pushes app files itself
  });

  it("handlePublish lists an app published without an icon under the lettermark of its name (#505)", async () => {
    install();
    const inner = globalThis.fetch;
    let listed: { apps: { id: string; icon: string; iconBg: string }[] } | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/contents/registry.json") && init?.method === "PUT") {
        listed = JSON.parse(Buffer.from(JSON.parse(init.body as string).content, "base64").toString());
      }
      return inner(input, init);
    }) as typeof fetch;
    const r = await handlePublish(
      { id: "door-drop", name: "Door Drop", category: "Productivity", description: "d" } as Parameters<typeof handlePublish>[0],
      ENV,
    );
    expect(r.success).toBe(true);
    expect(listed!.apps.find((a) => a.id === "door-drop")).toMatchObject({ icon: "DD", iconBg: "#7c3aed" });
  });

  it("handlePublish recovers from a lost registry.json race by re-reading and re-applying (#60)", async () => {
    const rec = install({ registryConflicts: 1 });
    const r = await handlePublish(
      { id: "widget", name: "Widget", category: "Productivity", icon: "🧩", iconBg: "#000", description: "d" },
      ENV,
    );
    expect(r.success).toBe(true);
    const registry = r.steps.find((st) => st.name === "Registry")!;
    expect(registry.status).toBe("ok");
    const registryCalls = rec.calls.filter((c) => c.url.includes("/contents/registry.json")).map((c) => c.method);
    expect(registryCalls).toEqual(["GET", "PUT", "GET", "PUT"]); // re-read the fresh sha before the retry
  });

  it("handlePublish gives up on registry.json after three lost races and reports it (#60)", async () => {
    const rec = install({ registryConflicts: 99 });
    const r = await handlePublish(
      { id: "widget", name: "Widget", category: "Productivity", icon: "🧩", iconBg: "#000", description: "d" },
      ENV,
    );
    expect(r.success).toBe(false);
    const registry = r.steps.find((st) => st.name === "Registry")!;
    expect(registry.status).toBe("fail");
    expect(registry.detail).toContain("contended 3 times");
    expect(rec.calls.filter((c) => c.url.includes("/contents/registry.json") && c.method === "PUT")).toHaveLength(3);
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
    expect(names(r)).toEqual(["GitHub repo", "R2 route", "Analytics", "OIDC test login", "Push files"]);
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

/**
 * #427: the deploy pipeline is the reusable workflow every app's deploy.yml calls
 * (.github/workflows/app-deploy.yml, released as app-deploy-v1). The tests below that
 * assert what a deploy does read it; the generator and golden are the thin caller.
 */
const pipeline = () => readFileSync(new URL("../../../.github/workflows/app-deploy.yml", import.meta.url), "utf8");

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

  // #393: the ChessClubs gates (chess-clubs#217), platform-wide. The strip step must
  // leave nothing that needs a map, and after the upload the public origin must not
  // serve one. Both scripts run here as Actions would, in a scratch build.
  describe("no public source maps (#393)", () => {
    /** One step's `run: |` script from the generated workflow, with its expressions filled in. */
    function stepScript(name: string, dir: string): string {
      const y = pipeline();
      const at = y.indexOf(`- name: ${name}`);
      expect(at, name).toBeGreaterThan(0);
      const body = y.slice(y.indexOf("run: |", at) + "run: |".length, y.indexOf("\n      - ", at + 1));
      return body.split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n")
        .replaceAll("${{ steps.dist.outputs.dir }}", dir)
        .replaceAll("${{ github.event.repository.name }}", "demo");
    }
    function run(script: string, cwd: string, env: Record<string, string> = {}) {
      return spawnSync("bash", ["-c", script], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
    }
    function scratch(files: Record<string, string>): { root: string; dist: string; temp: string } {
      const root = mkdtempSync(join(tmpdir(), "maps-"));
      const dist = join(root, "dist");
      const temp = join(root, "tmp");
      mkdirSync(temp, { recursive: true });
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dist, path)), { recursive: true });
        writeFileSync(join(dist, path), content);
      }
      return { root, dist, temp };
    }
    const roots: string[] = [];
    afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

    it("strip removes every map, records the paths, and passes a service worker that precaches none", () => {
      const s = scratch({
        "index.html": "<html></html>",
        "assets/index-a1.js": "console.log(1)",
        "assets/index-a1.js.map": '{"version":3,"mappings":"AAAA"}',
        "assets/vendor-b2.js.map": '{"version":3,"mappings":"AAAA"}',
        "sw.js": 'precacheAndRoute([{url:"assets/index-a1.js",revision:null},{url:"index.html",revision:"x"}])',
      });
      roots.push(s.root);
      const r = run(stepScript("Strip source maps from the public build", s.dist), s.root, { RUNNER_TEMP: s.temp });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("Removed 2 source map(s)");
      expect(readdirSync(join(s.dist, "assets")).sort()).toEqual(["index-a1.js"]);
      expect(readFileSync(join(s.temp, "stripped-maps.txt"), "utf8").trim().split("\n").sort()).toEqual(["assets/index-a1.js.map", "assets/vendor-b2.js.map"]);
    });

    it.each([
      ["minified Workbox", 'precacheAndRoute([{url:"assets/index-a1.js.map",revision:null}])'],
      ["JSON", '{"url": "assets/index-a1.js.map", "revision": null}'],
    ])("strip fails the deploy when a %s precache still lists a map", (_label, sw) => {
      const s = scratch({ "index.html": "x", "assets/index-a1.js.map": "{}", "sw.js": sw });
      roots.push(s.root);
      const r = run(stepScript("Strip source maps from the public build", s.dist), s.root, { RUNNER_TEMP: s.temp });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("precache lists a .map file");
    });

    /** The probe with `curl` stubbed to answer `body` for every URL, recording the URLs asked for. */
    function probe(maps: string[], body: string | null) {
      const s = scratch({});
      roots.push(s.root);
      writeFileSync(join(s.temp, "stripped-maps.txt"), maps.map((m) => m + "\n").join(""));
      const bin = join(s.root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "curl"), `#!/bin/bash\necho "\${@: -1}" >> "${s.root}/asked"\n${body === null ? "exit 7" : `printf '%s' '${body}'`}\n`);
      chmodSync(join(bin, "curl"), 0o755);
      const r = run(stepScript("Verify source maps are not public", s.dist), s.root, { RUNNER_TEMP: s.temp, PATH: `${bin}:${process.env.PATH}` });
      const asked = existsSync(join(s.root, "asked")) ? readFileSync(join(s.root, "asked"), "utf8").trim().split("\n") : [];
      return { ...r, asked };
    }

    it("the public probe fails the deploy when the origin serves a map", () => {
      const r = probe(["assets/index-a1.js.map"], '{"version":3,"sources":["src/App.tsx"],"mappings":"AAAA"}');
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("https://demo.proappstore.online/assets/index-a1.js.map serves a source map");
    });

    it.each([
      ["an SPA fallback page", "<!doctype html><title>demo</title>"],
      ["a refusal", "Forbidden"],
      ["an unreachable origin", null],
    ])("the public probe passes on %s, and checks at most five paths", (_label, body) => {
      const r = probe(Array.from({ length: 7 }, (_, i) => `assets/c${i}.js.map`), body);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.asked).toHaveLength(5);
      expect(r.asked[0]).toBe("https://demo.proappstore.online/assets/c0.js.map");
    });

    it("the public probe has nothing to do when the build had no maps", () => {
      const r = probe([], "irrelevant");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("No source maps in this build");
      expect(r.asked).toEqual([]);
    });

    it("runs strip before the public upload and the probe after it", () => {
      const y = pipeline();
      const order = ["Upload browser source maps", "Strip source maps from the public build", "Upload to R2", "Verify source maps are not public"].map((n) => y.indexOf(`- name: ${n}`));
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  });

  // #425: template-app's CLAUDE.md "CI runner rules" — every workflow starts with
  // the runner-router job and no other job hard-codes a runner. The owner applied
  // it to template-app by hand; the generator must carry it, or every sync reverts it.
  it("routes every job through ProAgentStore/runner-router and hard-codes no runner (#425)", () => {
    const yaml = pipeline();
    const jobs = yaml.slice(yaml.indexOf("\njobs:\n"));
    const names = [...jobs.matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]!);
    expect(names[0]).toBe("router");
    expect(names.length).toBeGreaterThan(1);
    const block = (name: string) => {
      const at = jobs.indexOf(`\n  ${name}:\n`);
      const next = jobs.slice(at + 1).search(/\n {2}[a-z0-9_-]+:\n/);
      return next < 0 ? jobs.slice(at) : jobs.slice(at, at + 1 + next);
    };
    expect(block("router")).toContain("uses: ProAgentStore/runner-router/.github/workflows/router.yml@v1");
    expect(block("router")).toContain("billing-token: ${{ secrets.RUNNER_BILLING_TOKEN }}");
    expect(block("router")).not.toMatch(/runs-on:/);
    for (const name of names.slice(1)) {
      expect(block(name), name).toMatch(/\n {4}needs: (router|\[router, [a-z0-9_, -]+\])\n/);
      expect(block(name), name).toContain("runs-on: ${{ fromJSON(needs.router.outputs.runner) }}");
    }
    expect(yaml).not.toMatch(/runs-on: (ubuntu-|self-hosted|\[)/);
    expect(yaml).not.toContain("serge-ivo/runner-router");
  });

  // #264: an app may keep its Playwright suite in the web workspace (doordrop's
  // web/tests/e2e) instead of a root e2e/ package; the canonical workflow runs
  // either, so such an app can adopt it without losing its E2E gate.
  describe("E2E suite detection (#264)", () => {
    const yaml = () => pipeline();
    /** The e2e-check step's script, run as Actions would, in a scratch repo laid out by `files`. */
    function detect(files: string[], input?: string): Record<string, string> {
      const y = yaml();
      const start = y.indexOf("id: e2e-check");
      const script = y.slice(y.indexOf("run: |", start) + "run: |".length, y.indexOf("\n      - uses:", start))
        .split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
      const dir = mkdtempSync(join(tmpdir(), "e2e-check-"));
      try {
        for (const f of files) {
          mkdirSync(join(dir, dirname(f)), { recursive: true });
          if (!f.endsWith("/")) writeFileSync(join(dir, f), "");
        }
        const out = join(dir, "github_output");
        writeFileSync(out, "");
        const r = spawnSync("bash", ["-e", "-c", script], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out, ...(input ? { E2E: input } : {}) } });
        if (r.status !== 0) return { error: String(r.stdout) };
        return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it.each<[string, string[], Record<string, string>]>([
      ["a root e2e/ package", ["e2e/package.json"], { has_e2e: "true", e2e_dir: "e2e" }],
      ["a web workspace suite", ["web/tests/e2e/a.spec.ts", "web/playwright.config.ts"], { has_e2e: "true", e2e_dir: "web" }],
      ["both: the root package wins", ["e2e/package.json", "web/tests/e2e/a.spec.ts", "web/playwright.config.ts"], { has_e2e: "true", e2e_dir: "e2e" }],
      ["web/tests/e2e without a Playwright config", ["web/tests/e2e/a.spec.ts"], { has_e2e: "false", e2e_dir: "" }],
      ["no suite", ["web/src/main.ts"], { has_e2e: "false", e2e_dir: "" }],
    ])("%s", (_label, files, expected) => {
      expect(detect(files)).toEqual(expected);
    });

    // #427: the reusable pipeline's `e2e` input picks the layout, or none; auto is the detection above.
    it.each<[string, string[], string, Record<string, string>]>([
      ["auto detects", ["e2e/package.json"], "auto", { has_e2e: "true", e2e_dir: "e2e" }],
      ["none skips a present suite", ["e2e/package.json"], "none", { has_e2e: "false", e2e_dir: "" }],
      ["web picks the web suite over a root one", ["e2e/package.json", "web/playwright.config.ts"], "web", { has_e2e: "true", e2e_dir: "web" }],
      ["e2e picks the root package", ["e2e/package.json", "web/tests/e2e/a.spec.ts", "web/playwright.config.ts"], "e2e", { has_e2e: "true", e2e_dir: "e2e" }],
    ])("input e2e: %s", (_label, files, input, expected) => {
      expect(detect(files, input)).toEqual(expected);
    });

    it("input e2e naming a layout that is not there fails the deploy rather than skipping the gate", () => {
      expect(detect(["web/src/main.ts"], "e2e").error).toContain("input e2e=e2e but there is no e2e/ directory");
      expect(detect(["web/tests/e2e/a.spec.ts"], "web").error).toContain("input e2e=web but there is no web/playwright.config.*");
    });

    it("runs the suite where it was found: its own install, its own config, results from either reporter path", () => {
      const y = yaml();
      const job = y.slice(y.indexOf("\n  e2e:"));
      expect(y).toContain("e2e_dir: ${{ steps.e2e-check.outputs.e2e_dir }}");
      expect(job).toContain("working-directory: ${{ needs.deploy.outputs.e2e_dir }}");
      expect(job).toContain('if [ "${{ needs.deploy.outputs.e2e_dir }}" = "e2e" ]; then npm install');
      expect(job).toContain('cd "$GITHUB_WORKSPACE" && pnpm install --frozen-lockfile');
      expect(job).toContain("uses: pnpm/action-setup@v4");
      expect(job).toContain('["results.json","test-results/results.json"]');
      // The job is still skipped without a suite, and still fails the run when the suite fails.
      expect(job).toContain("if: needs.deploy.outputs.has_e2e == 'true'");
      expect(job).toContain("if: steps.e2e.outcome != 'success'");
      expect(job).not.toMatch(/working-directory: e2e\n/);
    });
  });

  // #264: doordrop's own workflow redeployed a Worker named `pas-data-doordrop` with the
  // account-wide Cloudflare token, and every platform redeploy silently reverted it. The
  // canonical app workflow never deploys a Cloudflare script and never reads a platform
  // credential: its worker goes through the keyless platform step, nothing else.
  it("never deploys a Cloudflare script or reads a platform credential (#264)", () => {
    const yaml = pipeline();
    expect(yaml).not.toMatch(/wrangler|workers\/scripts|pas-data-|pas-app-/);
    expect(yaml).not.toMatch(/secrets\.(CLOUDFLARE|CF_|SESSION_SIGNING_KEY|INTERNAL_TOKEN|R2_)/);
    expect(yaml).toContain("https://api.proappstore.online/v1/apps/${{ github.event.repository.name }}/worker/oidc");
  });

  // #393: hidden source maps go to the platform's private store (opt-in, keyless) and
  // are always stripped before the public upload, so the public bucket never has a map.
  it("uploads opted-in source maps keyless and always strips maps before the public sync", () => {
    const yaml = pipeline();
    const at = (name: string) => yaml.indexOf(`- name: ${name}`);
    const upload = yaml.slice(at("Upload browser source maps (opt-in, keyless)"), at("Strip source maps from the public build"));
    const strip = yaml.slice(at("Strip source maps from the public build"), at("Mint deploy credentials (keyless — GitHub OIDC → platform)"));
    expect(at("Upload browser source maps (opt-in, keyless)")).toBeGreaterThan(at("Locate build output"));
    expect(at("Strip source maps from the public build")).toBeLessThan(at("Upload to R2"));
    // Keyless: the runner's OIDC token for the platform audience, no stored secret, to this commit's release.
    expect(upload).toContain("ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.proappstore.online");
    expect(upload).toContain("/v1/apps/${{ github.event.repository.name }}/sourcemaps?commitSha=${{ github.sha }}");
    expect(upload).not.toMatch(/secrets\./);
    // Opt-in by building maps; never fatal; manifest digest verified.
    expect(upload).toContain("continue-on-error: true");
    expect(upload).toContain("-name '*.map' -print -quit");
    expect(upload).toContain("sha256sum");
    // The strip step is unconditional and deletes every map in the build output.
    expect(strip).not.toContain("if:");
    expect(strip).toContain("find \"$DIR\" -type f -name '*.map' -delete");
  });

  it("the golden never reintroduces the lockfile-coupled cache or CF Pages", () => {
    const golden = pipeline();
    expect(golden).not.toContain("cache: pnpm");
    expect(golden).not.toContain("pages deploy");
    expect(golden).toContain("--no-frozen-lockfile");
  });

  it("deploys the app worker between migrations and tools registration, only when worker/ exists (#253)", () => {
    const golden = pipeline();
    const at = (path: string) => golden.indexOf(`/v1/apps/\${{ github.event.repository.name }}/${path}"`);
    expect(at("migrate/oidc")).toBeGreaterThan(0);
    expect(at("worker/oidc")).toBeGreaterThan(at("migrate/oidc"));
    expect(at("tools/oidc")).toBeGreaterThan(at("worker/oidc"));
    expect(at("deploy-credentials")).toBeGreaterThan(at("tools/oidc"));
    // An app without worker/ (template-app included) skips the step entirely.
    expect(golden).toContain("hashFiles('worker/package.json') != '' && github.event.repository.name != 'template-app'");
  });

  // #408: the app's own deploy builds marketing/ and publishes it to about-<app> through the
  // platform's verified upload + activation, after the app itself is live, never blocking it.
  it("publishes the marketing site after the app is live: keyless, by commit, verified, rolled back on failure", () => {
    const yaml = pipeline();
    const at = (name: string) => yaml.indexOf(`- name: ${name}`);
    const name = "Publish marketing site (marketing/ -> about-<app>, keyless)";
    expect(at(name)).toBeGreaterThan(at("Upload to R2"));
    expect(at(name)).toBeLessThan(at("Trigger post-deploy QA flows (keyless — GitHub OIDC)"));
    const step = yaml.slice(at(name), at("Trigger post-deploy QA flows (keyless — GitHub OIDC)"));
    expect(step).toContain("if: inputs.marketing == 'true' || (inputs.marketing == 'auto' && hashFiles('marketing/package.json') != '')");
    expect(step).toContain("continue-on-error: true");
    expect(step).toContain("pnpm --dir marketing build");
    // #410: a marketing/ outside the pnpm workspace is installed on its own.
    expect(step).toContain("pnpm --dir marketing install --ignore-workspace --no-frozen-lockfile");
    expect(step).toContain("REVISION: ${{ github.sha }}");
    expect(step).toContain("encodeURIComponent('https://api.proappstore.online')"); // the app-deploy audience
    for (const route of ["'revisions/' + REVISION", "'activate'", "'rollback'"]) expect(step).toContain(route);
    expect(step).toContain("x-pas-marketing-revision");
    expect(step).not.toMatch(/secrets\./);
    // Rollback only after a failed live check, and only to a revision that was actually live.
    expect(step.indexOf("'rollback'")).toBeGreaterThan(step.indexOf("live check failed"));
    expect(step).toContain("if (activation.previous && !activation.unchanged)");
  });

  // #498: an about- site must not go live with the template's own copy (bookkeeper#73).
  it("blocks the marketing site's first activation on unedited template copy, and always reports the check", () => {
    const yaml = pipeline();
    const at = (name: string) => yaml.indexOf(`- name: ${name}`);
    const name = "Publish marketing site (marketing/ -> about-<app>, keyless)";
    const step = yaml.slice(at(name), at("Trigger post-deploy QA flows (keyless — GitHub OIDC)"));
    expect(step).toContain("npx -y @proappstore/cli@latest check --json");
    expect(step).toContain("results.find((r) => r.name === 'Marketing site content')");
    // The liveness probe and the check both run, and are decided, before anything is uploaded.
    const checkAt = step.indexOf("marketingCheck.status !== 'pass'");
    expect(checkAt).toBeGreaterThan(0);
    expect(checkAt).toBeLessThan(step.indexOf("walk(DIST)"));
    expect(checkAt).toBeLessThan(step.indexOf("'revisions/' + REVISION"));
    // Reported to the run's job summary whether or not it blocks.
    expect(step).toContain("process.env.GITHUB_STEP_SUMMARY");
    expect(step).toContain("appendFileSync(process.env.GITHUB_STEP_SUMMARY");
    // Blocks only while the site has never answered live; an already-live app's redeploy just warns.
    expect(step).toContain("const blocks = !wasLive;");
    expect(step).toContain("if (blocks) {");
    expect(step).toMatch(/method: 'HEAD'.*cache: 'no-store'/);
    expect(step).not.toMatch(/secrets\./);
  });

  it("skips schema/action registration only in the canonical template source repo", () => {
    const golden = pipeline();
    expect(golden).toContain("hashFiles('migrations.json') != '' && github.event.repository.name != 'template-app'");
    expect(golden).toContain("hashFiles('mcp.json') != '' && github.event.repository.name != 'template-app'");
  });

  // #204: the staged templates (templates/template-*) are copied into new apps
  // just like template-app, so their workflow must be the golden too — they had
  // silently kept the fail-open `pnpm build || vite build` fallback.
  const templatesDir = new URL("../../../templates/", import.meta.url);
  const staged = readdirSync(templatesDir).filter((name) => existsSync(new URL(`${name}/.github/workflows/deploy.yml`, templatesDir)));

  it("finds the staged templates", () => {
    // template-marketplace is no longer staged here: it was published as its own
    // GitHub template repository, proappstore-online/template-marketplace (#199).
    expect(staged).toEqual(expect.arrayContaining(["template-map", "template-membership", "template-workspace"]));
  });

  it.each(staged)("staged %s ships the golden workflow", (name) => {
    const golden = readFileSync(new URL("./__fixtures__/canonical-deploy.yml", import.meta.url), "utf8");
    expect(readFileSync(new URL(`${name}/.github/workflows/deploy.yml`, templatesDir), "utf8")).toBe(golden);
  });
});

describe("provisioning hygiene (#195)", () => {
  const KB_YAML = ".github/workflows/kb.yml";

  it("refuses to sync --delete when the build output has no index.html", () => {
    // `aws s3 sync --delete` mirrors the dist dir onto the live prefix; an empty
    // dir would delete every object of the running app. The guard must sit in
    // the step that resolves the dir, before any upload step can run.
    const yaml = pipeline();
    const locate = yaml.indexOf("- name: Locate build output");
    const upload = yaml.indexOf("- name: Upload to R2");
    const guard = yaml.indexOf('if [ ! -f "$dir/index.html" ]');
    expect(locate).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(locate);
    expect(guard).toBeLessThan(upload);
    expect(yaml).toContain("refusing to deploy (sync --delete would wipe the live app)");
    // The output the upload step consumes is only written after the guard.
    expect(yaml.indexOf('echo "dir=$dir" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(guard);
    expect(yaml).toContain("--delete --no-progress");
  });

  it("registers app tools BEFORE the R2 upload so a rejected manifest blocks the deploy (#120)", () => {
    // Registering after the upload shipped the new frontend with the previous
    // revision's actions for three commits (chess-academy, 2026-08-10/11).
    const yaml = pipeline();
    const migrations = yaml.indexOf("- name: Apply D1 migrations");
    const register = yaml.indexOf("- name: Register app tools");
    const mint = yaml.indexOf("- name: Mint deploy credentials");
    const upload = yaml.indexOf("- name: Upload to R2");
    expect(register).toBeGreaterThan(migrations); // schema before actions (#33)
    expect(register).toBeLessThan(mint);
    expect(mint).toBeLessThan(upload);
    // Still a hard gate: a rejection exits non-zero.
    const block = yaml.slice(register, mint);
    expect(block).toContain("tools registration failed");
    expect(block).toContain("exit 1");
  });

  it("triggers post-deploy QA after the upload, advisory only", () => {
    const yaml = pipeline();
    const upload = yaml.indexOf("- name: Upload to R2");
    const qa = yaml.indexOf("- name: Trigger post-deploy QA flows");
    expect(qa).toBeGreaterThan(upload);
    const block = yaml.slice(qa, yaml.indexOf("\n  e2e:", qa));
    expect(block).toContain("continue-on-error: true");
    expect(block).toContain('/qa/runs"');
    expect(block).toContain(`--data '{"trigger":"deploy"}'`);
  });

  it("never deploys the template source repo itself, whose own build fails its placeholder check", () => {
    const yaml = pipeline();
    expect(yaml).toContain("  deploy:\n    # The approved templates (template-app, template-marketplace) are never served");
    // #425: the guard sits on the router too, so no runner is even routed for template-app.
    // #393: both approved templates, by exact name (template-marketplace's own
    // qa/deploy-workflow-regression.mjs rule): a generated app whose name merely
    // contains "template" still deploys.
    const guard = "if: github.event.repository.name != 'template-app' && github.event.repository.name != 'template-marketplace'";
    expect(yaml).toContain(`    needs: router\n    ${guard}\n    runs-on: \${{ fromJSON(needs.router.outputs.runner) }}`);
    expect(yaml).toContain(`  router:\n    # Same guard as deploy: the canonical templates never deploy, so don't route a runner for them.\n    ${guard}\n`);
    expect(yaml).not.toMatch(/startsWith\(github\.event\.repository\.name|contains\(github\.event\.repository\.name/);
  });

  it("URL-encodes each KB upload path segment, keeping / as the separator", () => {
    const kb = buildAgentBundle({}, ENV)[KB_YAML]!;
    expect(kb).toContain(`jq -sRr 'split("/") | map(@uri) | join("/")'`);
    expect(kb).toContain('"https://kb.proappstore.online/_ingest/$APP/$enc"');
    // The raw, unencoded path must no longer be interpolated into the URL.
    expect(kb).not.toContain("_ingest/$APP/${f#./}");
  });
});

describe("KB ingest is keyless OIDC, never the shared INTERNAL_TOKEN (#57)", () => {
  // The shared INTERNAL_TOKEN is a repo-level secret handed to EVERY app's CI,
  // so kb-host cannot tell which app is calling: any holder could exfiltrate it
  // from the Actions context and overwrite another tenant's KB. OIDC binds the
  // write to the caller's own `repository` claim. These assertions target the
  // functional markers (secret reference + request header), not prose — the
  // generated comments mention INTERNAL_TOKEN to explain what was replaced.
  const KB_YAML = ".github/workflows/kb.yml";

  it("the generated KB workflow authenticates ingest with an OIDC token", () => {
    const kb = buildAgentBundle({}, ENV)[KB_YAML]!;
    expect(kb).not.toContain("secrets.INTERNAL_TOKEN");
    expect(kb).not.toContain("x-internal-token");
    expect(kb).toContain("Authorization: Bearer $OIDC");
    expect(kb).toContain("audience=proappstore-kb-host");
  });

  it("the generated KB workflow requests the id-token permission it needs", () => {
    // Without `id-token: write` the mint returns empty and every KB publish
    // fails — the permission and the OIDC call have to land together.
    const kb = buildAgentBundle({}, ENV)[KB_YAML]!;
    expect(kb).toContain("id-token: write");
  });

  it("the canonical deploy workflow uploads E2E results with OIDC too", () => {
    const golden = pipeline();
    expect(golden).not.toContain("secrets.INTERNAL_TOKEN");
    expect(golden).not.toContain("x-internal-token");
    expect(golden).toContain("audience=proappstore-kb-host");
  });

  it("keeps the E2E results upload non-fatal", () => {
    // Diagnostics, not a deploy gate: a failed mint or a rejected write must not
    // fail a run whose tests actually passed.
    const golden = pipeline();
    expect(golden).toContain("skipped results upload (could not obtain OIDC token)");
    expect(golden).toContain("skipped results upload (ingest rejected the write)");
  });
});

describe("deploy-workflow injection (agent path)", () => {
  it("injects a layout-adaptive deploy.yml when the bundle has none", async () => {
    const rec = install();
    await handleAgentDeploy({ id: "flatapp", name: "Flat", files: { "index.html": "x" } }, ENV);
    // #427: the injected deploy.yml is the thin caller of the reusable pipeline...
    const wf = rec.blobs.find((b) => b.includes("Deploy to R2") && b.includes("app-deploy.yml@app-deploy-v1"));
    expect(wf, "an R2 deploy workflow blob should be pushed").toBe(deployWorkflowYaml(ENV));
    expect(wf).toContain("id-token: write"); // OIDC permission for the keyless mint, granted by the caller
    // ...and the pipeline it calls does the deploy.
    const pipe = pipeline();
    expect(pipe).toContain("s3://pas-apps/apps/");
    expect(pipe).toContain("if [ -d web/dist ]"); // adaptive: web/dist OR dist
    expect(pipe).toContain("deploy-credentials"); // keyless: OIDC → platform-minted R2 creds
    expect(pipe).toContain("tools/oidc"); // mcp.json re-registered on every deploy
    expect(pipe).toContain("--no-frozen-lockfile"); // agents commit no lockfile
    expect(pipe).not.toContain("cache: pnpm"); // no lockfile committed → cache:pnpm would hard-fail setup-node
    expect(pipe).toContain("npx playwright test"); // behavioural gate runs after deploy
    expect(pipe).toContain("@vibecodeqa/cli@0.44.0"); // code-health scan (report-only)
    expect(pipe).toContain(".vcqa/report.json"); // written into dist for the Dev Ops tab
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
    const wf = rec.blobs.find((b) => b.includes("Deploy to R2") && b.includes("app-deploy.yml@app-deploy-v1"));
    expect(wf, "the canonical deploy workflow should be injected").toBe(deployWorkflowYaml(ENV));
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

  it("reserves the about hostname and its DNS length on both publish paths", async () => {
    for (const id of ["about-kanban", "a".repeat(58)]) {
      install();
      const pub = await handlePublish(
        { id, name: "X", category: "C", icon: "x", iconBg: "#000", description: "d" },
        ENV,
      );
      expect(pub.steps[0]!.name).toBe("Validation");
      expect(pub.success).toBe(false);

      install();
      const agent = await handleAgentDeploy({ id, name: "X", files: {} }, ENV);
      expect(agent.steps[0]!.name).toBe("Validation");
      expect(agent.success).toBe(false);
    }
  });
});

describe("canonical KB workflow — single source of truth (#57)", () => {
  // kbWorkflowYaml() is THE canonical KB publish workflow. The committed golden
  // (__fixtures__/canonical-kb.yml) is what reconcile-kb-workflows.yml pushes
  // into app repos that still carry an older copy — the ones provisioned before
  // ingest moved to keyless OIDC. Same contract as canonical-deploy.yml: any
  // generator change fails here until the golden is regenerated.
  it("generator output is byte-identical to the committed golden file", () => {
    const golden = readFileSync(new URL("./__fixtures__/canonical-kb.yml", import.meta.url), "utf8");
    expect(kbWorkflowYaml()).toBe(golden);
  });

  it("the golden mints an OIDC token and never references the shared INTERNAL_TOKEN secret", () => {
    const golden = readFileSync(new URL("./__fixtures__/canonical-kb.yml", import.meta.url), "utf8");
    expect(golden).toContain("id-token: write");
    expect(golden).toContain("audience=proappstore-kb-host");
    expect(golden).not.toContain("secrets.INTERNAL_TOKEN");
    expect(golden).not.toContain("x-internal-token");
  });
});

/**
 * #204: the Build step must fail closed. `pnpm build || npx vite build` shipped
 * a fallback build whenever `pnpm build` failed — including when its `pas check`
 * prebuild or `tsc -b` failed — so a red gate deployed green (PAS-OPS-004).
 * These run the golden's actual Install/Build scripts under bash, with `pnpm`
 * and `npx` stubbed to log how they were invoked.
 */
// Spawns bash per case (~1 s each locally), so allow headroom over the 5 s default.
describe("deploy workflow build gate fails closed (#204)", { timeout: 30_000 }, () => {
  const golden = () => pipeline();

  /** The `run:` script of a named step: a single line, or a `run: |` block. */
  function stepScript(yaml: string, name: string): string {
    const lines = yaml.slice(yaml.indexOf(`- name: ${name}\n`)).split("\n");
    const at = lines.findIndex((l) => /^\s+run: /.test(l));
    const run = lines[at]!;
    if (!run.trimEnd().endsWith("run: |")) return run.replace(/^\s+run: /, "");
    const indent = run.indexOf("run:") + 2;
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== "" && l.search(/\S/) < indent) break;
      body.push(l.slice(indent));
    }
    return body.join("\n");
  }

  /** Run a step script in a scratch repo; pnpm runs the package's build script like the real one. */
  function runStep(script: string, repo: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
    const bin = join(dir, ".bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    writeFileSync(join(bin, "pnpm"), `#!/bin/bash\necho "pnpm $*" >> "${log}"\n[ "$1" = build ] && exec bash -c "$(jq -r '.scripts.build' package.json)"\nexit 0\n`);
    writeFileSync(join(bin, "npx"), `#!/bin/bash\necho "npx $* (in $(basename "$PWD"))" >> "${log}"\n`);
    chmodSync(join(bin, "pnpm"), 0o755);
    chmodSync(join(bin, "npx"), 0o755);
    for (const [path, content] of Object.entries(repo)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const res = spawnSync("bash", ["-e", "-c", script], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    rmSync(dir, { recursive: true, force: true });
    return { status: res.status, calls };
  }

  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "app", scripts });

  it("a failing build script — e.g. a failed pas check — fails the step and never falls back", () => {
    const { status, calls } = runStep(stepScript(golden(), "Build"), { "package.json": pkg({ build: "echo '✗ 1 failed'; exit 1" }) });
    expect(status).not.toBe(0);
    expect(calls).toEqual(["pnpm build"]);
  });

  it("a passing build script builds once, with no fallback", () => {
    const { status, calls } = runStep(stepScript(golden(), "Build"), { "package.json": pkg({ build: "true" }) });
    expect(status).toBe(0);
    expect(calls).toEqual(["pnpm build"]);
  });

  it("only a bundle with no build script falls back to a bare vite build, in web/ when present", () => {
    const withWeb = runStep(stepScript(golden(), "Build"), { "package.json": pkg({}), "web/index.html": "" });
    expect(withWeb.status).toBe(0);
    expect(withWeb.calls).toEqual(["npx vite build (in web)"]);
    // An agent bundle with no root package.json at all still builds.
    const flat = runStep(stepScript(golden(), "Build"), { "index.html": "" });
    expect(flat.status).toBe(0);
    expect(flat.calls).toEqual([expect.stringMatching(/^npx vite build \(in deploy-gate-/)]);
  });

  it("installs from a committed lockfile frozen, and unfrozen only when there is none", () => {
    expect(runStep(stepScript(golden(), "Install"), { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }).calls)
      .toEqual(["pnpm install --frozen-lockfile"]);
    expect(runStep(stepScript(golden(), "Install"), {}).calls).toEqual(["pnpm install --no-frozen-lockfile"]);
  });
});

describe("storefront registry: private apps (#259)", () => {
  /**
   * A registry.json mock holding `apps`, recording every PUT body. `manifest` is
   * the app repo's mcp.json: undefined → 404, a number → that error status.
   */
  function registryMock(apps: { id: string }[], manifest?: unknown) {
    const puts: { apps: { id: string }[] }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/diary/contents/mcp.json")) {
        if (manifest === undefined) return new Response("{}", { status: 404 });
        if (typeof manifest === "number") return new Response("{}", { status: manifest });
        return new Response(JSON.stringify({ sha: "m", content: Buffer.from(JSON.stringify(manifest)).toString("base64") }), { status: 200 });
      }
      if (!url.includes("/contents/registry.json")) throw new Error(`unexpected fetch ${url}`);
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { content: string };
        puts.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")));
        return new Response(JSON.stringify({ commit: { sha: "c" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ sha: "s", content: Buffer.from(JSON.stringify({ apps })).toString("base64") }), { status: 200 });
    }) as typeof fetch;
    return puts;
  }
  /** app_visibility answers `mode`; every app_storefront_publication write (#399) lands in `listedWrites`. */
  let listedWrites: [string, number][] = [];
  const dbWith = (mode: string | null, fail?: string) => {
    listedWrites = [];
    return {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => { if (fail) throw new Error(fail); return mode ? { mode } : null; },
          run: async () => {
            if (sql.includes("app_storefront_publication")) listedWrites.push([args[0] as string, args[1] as number]);
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;
  };
  const REQ = { id: "diary", name: "Diary", category: "x", icon: "d", iconBg: "#000", description: "d" };

  it("never adds an app the publish request declares private", async () => {
    const puts = registryMock([]);
    const step = await addToRegistry({ ...ENV, DB: dbWith(null) }, { ...REQ, visibility: "private" });
    expect(step).toMatchObject({ status: "skip" });
    expect(puts).toEqual([]);
    expect(listedWrites).toEqual([["diary", 0]]);
  });

  it("#399: records the D1 listing flag — unlisted before the registry write, listed only after a successful one", async () => {
    let puts = registryMock([{ id: "diary" }]);
    expect(await addToRegistry({ ...ENV, DB: dbWith("private") }, REQ)).toMatchObject({ status: "ok" });
    expect(puts).toHaveLength(1);
    expect(listedWrites).toEqual([["diary", 0]]);

    puts = registryMock([]);
    expect(await addToRegistry({ ...ENV, DB: dbWith("public") }, REQ)).toMatchObject({ status: "ok", detail: "Added Diary" });
    expect(listedWrites).toEqual([["diary", 1]]);
    registryMock([{ id: "diary" }]);
    expect(await addToRegistry({ ...ENV, DB: dbWith("public") }, REQ)).toMatchObject({ status: "skip", detail: "Already listed" });
    expect(listedWrites).toEqual([["diary", 1]]); // a republish repairs a missing flag

    // A failed registry write never marks the app listed.
    globalThis.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => init?.method === "PUT"
      ? new Response(JSON.stringify({ message: "boom" }), { status: 500 })
      : new Response(JSON.stringify({ sha: "s", content: Buffer.from(JSON.stringify({ apps: [] })).toString("base64") }), { status: 200 })) as typeof fetch;
    expect(await addToRegistry({ ...ENV, DB: dbWith("public") }, REQ)).toMatchObject({ status: "fail" });
    expect(listedWrites).toEqual([]);
  });

  it("#399: an unlisting the D1 flag cannot record is not attempted", async () => {
    const puts = registryMock([{ id: "diary" }]);
    const db = {
      prepare: (sql: string) => ({ bind: () => ({
        first: async () => ({ mode: "private" }),
        run: async () => { if (sql.includes("app_storefront_publication")) throw new Error("D1 down"); return {}; },
      }) }),
    } as unknown as D1Database;
    expect(await addToRegistry({ ...ENV, DB: db }, REQ)).toMatchObject({ status: "fail", detail: expect.stringContaining("unlisting") });
    expect(puts).toEqual([]);
  });

  it("#399: a listing whose D1 flag cannot be recorded still succeeds, closed, and says so", async () => {
    registryMock([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare: (sql: string) => ({ bind: () => ({
        first: async () => ({ mode: "public" }),
        run: async () => { if (sql.includes("app_storefront_publication")) throw new Error("D1 down"); return {}; },
      }) }),
    } as unknown as D1Database;
    expect(await addToRegistry({ ...ENV, DB: db }, REQ)).toMatchObject({ status: "ok", detail: expect.stringContaining("reconcile will repair") });
    err.mockRestore();
  });

  it("never adds an app whose registered manifest is private, and removes a stale entry", async () => {
    expect(registryMock([])).toEqual([]);
    expect((await addToRegistry({ ...ENV, DB: dbWith("private") }, REQ)).status).toBe("skip");
    const puts = registryMock([{ id: "other" }, { id: "diary" }]);
    const step = await addToRegistry({ ...ENV, DB: dbWith("private") }, REQ);
    expect(step).toMatchObject({ status: "ok" });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.apps.map((a) => a.id)).toEqual(["other"]);
  });

  it("lists a public app as before, and reads a missing app_visibility table as public", async () => {
    let puts = registryMock([]);
    expect((await addToRegistry({ ...ENV, DB: dbWith("public") }, REQ)).status).toBe("ok");
    expect(puts[0]!.apps.map((a) => a.id)).toEqual(["diary"]);
    puts = registryMock([]);
    expect((await addToRegistry({ ...ENV, DB: dbWith(null, "D1_ERROR: no such table: app_visibility") }, REQ)).status).toBe("ok");
    expect(puts).toHaveLength(1);
  });

  it("fails the step — never lists — when the visibility lookup errors", async () => {
    const puts = registryMock([]);
    const step = await addToRegistry({ ...ENV, DB: dbWith(null, "D1_ERROR: database unavailable") }, REQ);
    expect(step).toMatchObject({ status: "fail" });
    expect(puts).toEqual([]);
  });

  it("first publish: no request field, no registered row — the repo's mcp.json decides", async () => {
    // Every real caller used to omit `visibility`, and nothing has registered yet.
    let puts = registryMock([], { tools: [], visibility: { mode: "private", roles: ["viewer"] } });
    expect(await addToRegistry({ ...ENV, DB: dbWith(null) }, REQ)).toMatchObject({ status: "skip", detail: expect.stringContaining("Private") });
    expect(puts).toEqual([]);
    puts = registryMock([], { tools: [] });
    expect((await addToRegistry({ ...ENV, DB: dbWith(null) }, REQ)).status).toBe("ok");
    expect(puts).toHaveLength(1);
    puts = registryMock([]); // no mcp.json at all: public
    expect((await addToRegistry({ ...ENV, DB: dbWith(null) }, REQ)).status).toBe("ok");
    expect(puts).toHaveLength(1);
  });

  it("fails the step — never lists — when the repo's mcp.json cannot be read", async () => {
    const puts = registryMock([], 502);
    expect(await addToRegistry({ ...ENV, DB: dbWith(null) }, REQ)).toMatchObject({ status: "fail" });
    expect(puts).toEqual([]);
  });

  it("an explicit 'public' from the caller skips the repo read; a registered row still wins over it", async () => {
    registryMock([], 502); // would fail if read
    expect(await isPrivateForRegistry({ DB: dbWith(null) }, { id: "diary", visibility: "public" }, { getFile: async () => { throw new Error("read"); } })).toBe(false);
    expect(await isPrivateForRegistry({ DB: dbWith("private") }, { id: "diary", visibility: "public" })).toBe(true);
  });

  it("isPrivateForRegistry trusts a private declaration without a lookup", async () => {
    expect(await isPrivateForRegistry({ DB: dbWith(null, "should not be called") }, { id: "x", visibility: "private" })).toBe(true);
  });
});

describe("storefront-publication reconcile (#399)", () => {
  function registry(apps: unknown, status = 200) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("/contents/registry.json")) throw new Error(`unexpected fetch ${String(input)}`);
      if (status !== 200) return new Response("{}", { status });
      return new Response(JSON.stringify({ sha: "s", content: Buffer.from(JSON.stringify({ apps })).toString("base64") }), { status: 200 });
    }) as typeof fetch;
  }
  function db(rows: { id: string; listed: number | null }[]) {
    const written: [string, number][] = [];
    const statement = { bind: (id: string, listed: number) => ({ id, listed }) };
    const d = {
      prepare: (sql: string) => sql.startsWith("SELECT") ? { all: async () => ({ results: rows }) } : statement,
      batch: async (stmts: { id: string; listed: number }[]) => { for (const s of stmts) written.push([s.id, s.listed]); return []; },
    } as unknown as D1Database;
    return { d, written };
  }

  it("backfills listed apps from registry.json and unlists the rest, touching only what differs", async () => {
    registry([{ id: "a" }, { id: "b" }, { id: "ghost" }, { name: "no id" }]);
    const { d, written } = db([{ id: "a", listed: null }, { id: "b", listed: 1 }, { id: "c", listed: 1 }, { id: "d", listed: null }, { id: "e", listed: 0 }]);
    expect(await reconcileStorefrontPublication({ ...ENV, DB: d })).toEqual({ listed: 1, unlisted: 1 });
    expect(written).toEqual([["a", 1], ["c", 0]]); // ghost has no apps row; d and e stay closed
  });

  it("changes nothing when registry.json cannot be read or has no apps list", async () => {
    const { d, written } = db([{ id: "a", listed: 1 }]);
    registry([], 502);
    await expect(reconcileStorefrontPublication({ ...ENV, DB: d })).rejects.toThrow(/registry.json/);
    registry(undefined);
    await expect(reconcileStorefrontPublication({ ...ENV, DB: d })).rejects.toThrow(/no apps list/);
    expect(written).toEqual([]);
  });
});

describe("reusable deploy pipeline (#427)", () => {
  const caller = () => deployWorkflowYaml(ENV);
  /** One step's `run: |` script, unindented. */
  const script = (y: string, name: string) => {
    const start = y.indexOf(`- name: ${name}`);
    const end = y.indexOf("\n      - ", start + 1);
    return y.slice(y.indexOf("run: |", start) + "run: |".length, end).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  };

  it("app deploy.yml is a thin caller: push to main, OIDC permission, the reusable pipeline at its moving tag", () => {
    const y = caller();
    expect(y).toMatch(/^name: Deploy to R2\n/); // the Agent Teams deploy gate matches the run name
    expect(y).toContain("on:\n  push:\n    branches: [main]");
    expect(y).toContain("permissions:\n  contents: read\n  id-token: write");
    expect(y).toContain("group: deploy-${{ github.repository }}");
    expect(y).toContain(`uses: ${APP_DEPLOY_WORKFLOW}@${APP_DEPLOY_TAG}`);
    expect(APP_DEPLOY_TAG).toBe("app-deploy-v1");
    expect(y).toContain("secrets: inherit");
    // Nothing runs in the app repo itself: no steps, no other secrets.
    expect(y).not.toMatch(/\n\s+(run|steps):/);
    expect(y).not.toMatch(/secrets\./);
    expect(y.split("\n").length).toBeLessThan(30);
  });

  it("the pipeline is callable only: workflow_call with typed inputs, defaults that match today's detection", () => {
    const y = pipeline();
    expect(y).toContain("on:\n  workflow_call:");
    expect(y).not.toMatch(/\n  (push|pull_request|workflow_dispatch):/);
    for (const [input, type, def] of [["e2e", "string", "auto"], ["marketing", "string", "auto"], ["source-maps", "string", "auto"], ["node-version", "number", "22"]]) {
      expect(y, input).toMatch(new RegExp(`\\n      ${input}:\\n        description: [^\\n]+\\n        type: ${type}\\n        default: ${def}\\n`));
    }
    expect(y).toContain("node-version: ${{ inputs.node-version }}");
    expect(y).not.toContain("node-version: 22");
    expect(y).toContain("if: inputs.source-maps != 'false'");
    expect(y).toContain("if: inputs.marketing == 'true' || (inputs.marketing == 'auto' && hashFiles('marketing/package.json') != '')");
  });

  it.each<[Record<string, string>, boolean]>([
    [{ E2E: "auto", MARKETING: "auto", SOURCE_MAPS: "auto" }, true],
    [{ E2E: "web", MARKETING: "false", SOURCE_MAPS: "false" }, true],
    [{ E2E: "none", MARKETING: "true", SOURCE_MAPS: "auto" }, true],
    [{ E2E: "yes", MARKETING: "auto", SOURCE_MAPS: "auto" }, false],
    [{ E2E: "auto", MARKETING: "maybe", SOURCE_MAPS: "auto" }, false],
    [{ E2E: "auto", MARKETING: "auto", SOURCE_MAPS: "true" }, false],
  ])("input check %j passes: %s", (env, ok) => {
    const r = spawnSync("bash", ["-e", "-c", script(pipeline(), "Check inputs")], { env: { ...process.env, ...env } });
    expect(r.status === 0, String(r.stdout)).toBe(ok);
  });

  // #437: the storefront listing shows what the app's code asks the browser for.
  it("reports detected browser permissions keyless after the build, never blocking the deploy", () => {
    const y = pipeline();
    const at = (name: string) => y.indexOf(`- name: ${name}`);
    const name = "Report detected browser permissions (keyless)";
    expect(at(name)).toBeGreaterThan(at("Locate build output"));
    const step = y.slice(at(name), at("Upload browser source maps (opt-in, keyless)"));
    expect(step).toContain("continue-on-error: true");
    expect(step).toContain("npx -y @proappstore/cli@latest permissions --json");
    expect(step).toContain("ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.proappstore.online");
    expect(step).toContain("/v1/apps/${{ github.event.repository.name }}/permissions/detected");
    expect(step).not.toMatch(/secrets\./);
  });

  // #264 guard, on the file every app now runs. `secrets: inherit` hands it every
  // secret the caller holds, so it may read only the two it declares.
  it("the pipeline reads only its declared secrets and never a platform credential or Cloudflare script", () => {
    const y = pipeline();
    expect(y).not.toMatch(/wrangler|workers\/scripts|pas-data-|pas-app-/);
    expect(y).not.toMatch(/secrets\.(CLOUDFLARE|CF_|SESSION_SIGNING_KEY|INTERNAL_TOKEN|R2_)/);
    expect([...new Set(y.match(/secrets\.[A-Z0-9_]+/g))].sort()).toEqual(["secrets.PAS_E2E_SESSION_TOKEN", "secrets.RUNNER_BILLING_TOKEN"]);
    expect(y).toContain("https://api.proappstore.online/v1/apps/${{ github.event.repository.name }}/worker/oidc");
    // The templates never deploy: the skip lives in the pipeline, so a template's caller is inert.
    expect(y.match(/if: github\.event\.repository\.name != 'template-app' && github\.event\.repository\.name != 'template-marketplace'/g)).toHaveLength(2);
  });
});
