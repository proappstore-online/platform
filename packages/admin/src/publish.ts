import {
  makeGitHub,
  ensurePagesProject,
  ensureCustomDomain,
  ensureDnsCname,
  ensureAnalytics,
  type CfConfig,
  type Step,
} from "@proappstore/build-core";
import type { Env } from "./env.js";
import { e2eHarnessFiles, E2E_SPEC_PREFIX } from "./e2e-harness.js";

const ghFor = (env: Env) => makeGitHub(env.GITHUB_TOKEN, env.PUBLISHERS_ORG);
/** CF provisioning config from the admin Worker's bindings (shared primitives). */
const cfFor = (env: Env): CfConfig => ({
  token: env.CF_API_TOKEN,
  accountId: env.CF_ACCOUNT_ID,
  zoneId: env.PAS_ZONE_ID,
  domainBase: env.APPS_DOMAIN_BASE,
});

export interface PublishRequest {
  id: string;
  name: string;
  category: string;
  icon: string;
  iconBg: string;
  description: string;
  proFeatures?: string[];
}

// Path of the deploy workflow we inject into agent-authored repos.
const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";

/**
 * The push-triggered CI workflow that builds the app and ships it to its CF Pages
 * project. Agent Teams authors only app source — never a workflow — so without
 * this the repo has no CI, every push registers no run, and the deploy stage
 * correctly times out with "CI never started". Injected at deploy time.
 *
 * Deliberately layout-adaptive: agents author either a flat Vite app (build →
 * `dist`) or a `web/` sub-package (build → `web/dist`); this detects both. Uses
 * `--no-frozen-lockfile` because agents don't commit a lockfile. Needs the
 * `CLOUDFLARE_API_TOKEN` Actions secret (org-level, visibility=all on the
 * publishers org — see SETUP) so every generated repo inherits it with no
 * per-repo step. `\${{ }}` is escaped to survive the template literal.
 */
function deployWorkflowYaml(env: Env): string {
  return `name: Deploy to Cloudflare Pages

on:
  push:
    branches: [main]

permissions:
  contents: read
  deployments: write

concurrency:
  group: deploy-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: pnpm install --no-frozen-lockfile

      - name: Build
        env:
          VITE_COMMIT_SHA: \${{ github.sha }}
        run: pnpm build

      - name: Locate build output
        id: dist
        run: |
          if [ -d web/dist ]; then echo "dir=web/dist" >> "\$GITHUB_OUTPUT"
          elif [ -d dist ]; then echo "dir=dist" >> "\$GITHUB_OUTPUT"
          else echo "::error::No build output (looked for ./dist and ./web/dist)"; exit 1; fi

      # Code-health scan (VCQA) — REPORT ONLY, never blocks the deploy. Writes
      # report.json into the deployed output so the console's Dev Ops tab can read
      # it at <app>.proappstore.online/.vcqa/report.json. A low score is a signal,
      # not a gate (a fresh scaffold legitimately scores low on test coverage).
      - name: Code-health scan (VCQA, report-only)
        continue-on-error: true
        run: |
          npx -y @vibecodeqa/cli@latest --skip-tests . || true
          if [ -f .vibe-check/report.json ]; then
            mkdir -p "\${{ steps.dist.outputs.dir }}/.vcqa"
            cp .vibe-check/report.json "\${{ steps.dist.outputs.dir }}/.vcqa/report.json"
            [ -f .vibe-check/badge.svg ] && cp .vibe-check/badge.svg "\${{ steps.dist.outputs.dir }}/.vcqa/badge.svg" || true
          fi

      - name: Deploy to Cloudflare Pages
        run: npx wrangler@3 pages deploy "\${{ steps.dist.outputs.dir }}" --project-name=proappstore-\${{ github.event.repository.name }} --branch=main
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${env.CF_ACCOUNT_ID}

  # Behavioural gate: drive the LIVE app in a real browser (the thing tsc/build
  # can't check). Runs after deploy; a failure fails the run, so the deploy
  # gate routes the ticket back to Dev with the Playwright output. Auth uses a
  # platform fixture session via the SDK's real sign-in path (no test bypass);
  # auth-gated specs skip when PAS_E2E_SESSION_TOKEN is unset.
  e2e:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install E2E deps
        working-directory: e2e
        run: npm install
      - name: Install Playwright browser
        working-directory: e2e
        run: npx playwright install --with-deps chromium
      - name: Run E2E against the live app
        working-directory: e2e
        env:
          E2E_BASE_URL: https://\${{ github.event.repository.name }}.proappstore.online
          E2E_SESSION_TOKEN: \${{ secrets.PAS_E2E_SESSION_TOKEN }}
        run: npx playwright test
`;
}

function validateId(id: string): string | null {
  if (!id) return "id is required";
  if (id.length > 58) return "id must be 58 chars or less";
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return "id: lowercase alphanumeric + dashes, must start with letter";
  if (id.startsWith("pro")) return "id must not start with 'pro'";
  return null;
}

// GitHub repo (via build-core). CF hosting steps (Pages project, custom domain,
// DNS, analytics) are the shared build-core primitives — see provisionApp.
async function createRepo(env: Env, req: PublishRequest): Promise<Step> {
  const gh = ghFor(env);
  if (await gh.repoExists(req.id)) {
    return { name: "GitHub repo", status: "skip", detail: `${env.PUBLISHERS_ORG}/${req.id} already exists` };
  }
  const result = await gh.createRepo(req.id, { description: req.description });
  if ((result.data as { id?: number }).id) {
    return { name: "GitHub repo", status: "ok", detail: `Created ${env.PUBLISHERS_ORG}/${req.id}` };
  }
  return { name: "GitHub repo", status: "fail", detail: (result.data as { message?: string }).message || "Failed to create repo" };
}

// NOTE: the workflow's CLOUDFLARE_API_TOKEN is an ORG-level Actions secret,
// managed in Doppler (project `pas`, auto-synced to the proappstore-online org —
// see stores/SECRETS.md). It is deliberately NOT set per-repo here: the admin
// Worker can't seal repo secrets (libsodium unavailable in Workers), and
// SECRETS.md forbids repo-level secrets that duplicate an org-level one
// (repo-level silently overrides). So there is no setRepoSecret step.

// Registry entry (storefront listing)
async function addToRegistry(env: Env, req: PublishRequest): Promise<Step> {
  const gh = ghFor(env);
  // registry.json lives in the storefront repo (org/proappstore).
  const file = await gh.getFile("proappstore", "registry.json");
  if (!file.ok || !file.content || !file.sha) {
    return { name: "Registry", status: "fail", detail: "Could not read registry.json" };
  }

  const content = JSON.parse(file.content);
  const apps = content.apps || [];

  if (apps.some((a: { id: string }) => a.id === req.id)) {
    return { name: "Registry", status: "skip", detail: "Already listed" };
  }

  apps.push({
    id: req.id,
    name: req.name,
    category: req.category,
    icon: req.icon,
    iconBg: req.iconBg,
    description: req.description,
    appUrl: `https://${req.id}.${env.APPS_DOMAIN_BASE}`,
    repo: `${env.PUBLISHERS_ORG}/${req.id}`,
    cfProject: `proappstore-${req.id}`,
    type: "connected",
    developer: "ProAppStore",
    ...(req.proFeatures?.length ? { proFeatures: req.proFeatures } : {}),
  });
  content.apps = apps;

  const update = await gh.putFile(
    "proappstore",
    "registry.json",
    JSON.stringify(content, null, 2),
    `Add ${req.name} to registry`,
    file.sha,
  );
  if (update.ok) return { name: "Registry", status: "ok", detail: `Added ${req.name}` };
  if (update.status === 409) return { name: "Registry", status: "fail", detail: "Registry write contended — retry" };
  return { name: "Registry", status: "fail", detail: (update.data as { message?: string }).message || "Failed to update registry" };
}

// Push a file bundle as one commit via build-core (Git Data API; seeds empty repos).
async function pushFilesToGitHub(env: Env, id: string, files: Record<string, string>): Promise<Step & { commitSha?: string }> {
  const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
  if (entries.length === 0) return { name: "Push files", status: "skip", detail: "no files to push" };
  const res = await ghFor(env).pushFiles(id, entries, "Build update — ProAppStore Agent Teams", { initIfEmpty: true });
  if (!res.ok) return { name: "Push files", status: "fail", detail: res.error || "push failed" };
  return { name: "Push files", status: "ok", detail: `Pushed ${entries.length} file(s) (${res.commitSha?.slice(0, 7)})`, commitSha: res.commitSha };
}

/**
 * Internal: read a repo's current files (GitHub = source of truth) so the
 * agent-teams working tree can sync to the latest. `headOnly` returns just the
 * commit SHA/date for a cheap freshness check before pulling blobs.
 */
export async function handleRepoPull(
  req: { id: string; headOnly?: boolean },
  env: Env,
): Promise<{ ok: boolean; sha?: string; date?: string; files?: Record<string, string>; truncated?: boolean; error?: string }> {
  const gh = ghFor(env);
  if (!(await gh.repoExists(req.id))) return { ok: false, error: "repo not found" };
  if (req.headOnly) {
    const h = await gh.headSha(req.id);
    return { ok: h.ok, sha: h.sha, date: h.date };
  }
  return gh.pullText(req.id);
}

/** Internal: the real CI build/deploy result for an app (the build gate). */
export async function handleDeployStatus(
  req: { id: string; waitMs?: number; sha?: string },
  env: Env,
): Promise<{ ok: boolean; status?: string; conclusion?: string; sha?: string; url?: string; errorTail?: string; error?: string }> {
  const gh = ghFor(env);
  if (!(await gh.repoExists(req.id))) return { ok: false, error: "repo not found" };
  return gh.deployResult(req.id, { waitMs: Math.min(req.waitMs ?? 0, 90_000), ...(req.sha ? { sha: req.sha } : {}) });
}

// CONTRACT (agent-deploy): the request body sent by packages/agent-teams
// (ProjectDO.executeInfraTool). Both ends now live in this monorepo — keep in
// sync; a grep for "AgentDeployRequest" finds the caller.
export interface AgentDeployRequest {
  id: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  iconBg?: string;
  files: Record<string, string>;
}

/**
 * Per-path knobs for {@link provisionApp}. Everything NOT named here is shared:
 * the SDK/CLI publish path and the web/agent-teams deploy path provision the
 * exact same hosting (repo + CF Pages project + custom domain + DNS + analytics).
 * Only these documented deltas differ — keep new behaviour shared by default and
 * add a knob only when the two paths genuinely must diverge.
 */
interface ProvisionOptions {
  /**
   * Agent path: inject a deploy workflow (when the bundle has none) and push
   * these files as one commit, returning the commit SHA for the deploy gate.
   * Omitted on the publish path, where the CLI pushes the app's files itself.
   */
  files?: Record<string, string>;
  /** Publish path: add the storefront registry entry. The agent path leaves
   *  listing to an explicit publish decision (apps deploy + iterate first). */
  addRegistry?: boolean;
  /** Publish path treats a DNS failure as fatal (the user asked for the custom
   *  domain). The agent path tolerates it — CI still ships to *.pages.dev. */
  dnsFatal?: boolean;
}

/**
 * The single provisioning core both entry points share, so a repo provisioned by
 * `pas publish` and one provisioned by the Agent Teams deploy stage are identical
 * (same Pages project, domain, DNS, analytics). Every step is idempotent — it
 * skips cleanly if the resource already exists. `repoUrl` is null until the repo
 * is created; `commitSha` is set only when `files` were pushed.
 */
async function provisionApp(
  req: PublishRequest,
  env: Env,
  opts: ProvisionOptions = {},
): Promise<{ steps: Step[]; success: boolean; repoUrl: string | null; commitSha?: string }> {
  const steps: Step[] = [];
  let repoUrl: string | null = null;
  const stop = (commitSha?: string) => ({ steps, success: false, repoUrl, commitSha });

  const idError = validateId(req.id);
  if (idError) { steps.push({ name: "Validation", status: "fail", detail: idError }); return stop(); }
  if (!req.name) { steps.push({ name: "Validation", status: "fail", detail: "name is required" }); return stop(); }

  // 1. GitHub repo (fatal)
  const repoStep = await createRepo(env, req);
  steps.push(repoStep);
  if (repoStep.status === "fail") return stop();
  repoUrl = `https://github.com/${env.PUBLISHERS_ORG}/${req.id}`;

  // 2. CF Pages project — wrangler's deploy target, must exist before CI (fatal)
  const cf = cfFor(env);
  const pagesStep = await ensurePagesProject(cf, req.id);
  steps.push(pagesStep);
  if (pagesStep.status === "fail") return stop();

  // 3. Reachability at <id>.proappstore.online. Domain is always best-effort;
  //    DNS is fatal only on the publish path (see ProvisionOptions.dnsFatal).
  steps.push(await ensureCustomDomain(cf, req.id));
  const dnsStep = await ensureDnsCname(cf, req.id);
  steps.push(dnsStep);
  if (opts.dnsFatal && dnsStep.status === "fail") return stop();

  // 4. Storefront listing (publish path only; fatal — the point of publishing)
  if (opts.addRegistry) {
    const registryStep = await addToRegistry(env, req);
    steps.push(registryStep);
    if (registryStep.status === "fail") return stop();
  }

  // 5. CF Web Analytics — uniform across stores, non-fatal, both paths
  steps.push(await ensureAnalytics(cf, req.id));

  // 6. Agent path: ensure a deploy workflow exists, then push the bundle as one
  //    commit. Without an injected workflow a push triggers no CI and the deploy
  //    gate times out with "CI never started".
  let commitSha: string | undefined;
  if (opts.files) {
    const files: Record<string, string> = { ...opts.files };
    const hasWorkflow = Object.keys(files).some((p) => /^\.github\/workflows\/.+\.ya?ml$/i.test(p));
    if (!hasWorkflow) files[DEPLOY_WORKFLOW_PATH] = deployWorkflowYaml(env);
    // Inject the Playwright E2E harness (config + fixtures + baseline smoke) so
    // the CI e2e job has something to run. Each file is added only when absent
    // (never clobber authored harness edits); the baseline smoke is skipped once
    // the bundle carries QA-authored specs under e2e/specs/.
    const hasAuthoredSpecs = Object.keys(files).some((p) => p.startsWith(E2E_SPEC_PREFIX));
    for (const [path, content] of Object.entries(e2eHarnessFiles())) {
      if (path in files) continue;
      if (hasAuthoredSpecs && path.startsWith(E2E_SPEC_PREFIX)) continue;
      files[path] = content;
    }
    const pushStep = await pushFilesToGitHub(env, req.id, files);
    steps.push(pushStep);
    if (pushStep.status === "fail") return stop();
    commitSha = pushStep.commitSha;
  }

  return { steps, success: true, repoUrl, commitSha };
}

/**
 * Internal (agent-teams deploy stage, over the service binding): provision a
 * deployable repo and push the authored bundle. Thin wrapper over
 * {@link provisionApp} — DNS non-fatal, no storefront listing, files pushed.
 */
export async function handleAgentDeploy(
  req: AgentDeployRequest,
  env: Env,
): Promise<{ steps: Step[]; success: boolean; repoUrl: string | null; commitSha?: string }> {
  const pubReq: PublishRequest = {
    id: req.id,
    name: req.name,
    category: req.category || "Productivity",
    icon: req.icon || "📦",
    iconBg: req.iconBg || "#7c3aed",
    description: req.description || req.name,
  };
  return provisionApp(pubReq, env, { files: req.files ?? {}, dnsFatal: false });
}

/**
 * SDK/CLI publish (`/api/publish-app`, user session): full provision including
 * the storefront listing. Thin wrapper over {@link provisionApp} — DNS fatal,
 * registry added, files pushed separately by the CLI.
 */
export async function handlePublish(req: PublishRequest, env: Env): Promise<{ steps: Step[]; success: boolean }> {
  const { steps, success } = await provisionApp(req, env, { addRegistry: true, dnsFatal: true });
  return { steps, success };
}
