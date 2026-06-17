import { type CfConfig, ensureAnalytics, makeGitHub, type Step } from "@proappstore/build-core";
import { E2E_SPEC_PREFIX, e2eHarnessFiles } from "./e2e-harness.js";
import type { Env } from "./env.js";

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
  /** GitHub login of the creator — injected from the verified session by the
   *  /api/provision handler. Granted push access to the app repo (so creators
   *  can push/clone their own app, not just the platform). */
  creatorGithub?: string;
}

// Path of the deploy workflow we inject into agent-authored repos.
const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
const KB_WORKFLOW_PATH = ".github/workflows/kb.yml";

/**
 * The push-triggered CI workflow that builds the app and uploads to R2.
 * Agent Teams authors only app source — never a workflow — so without
 * this the repo has no CI, every push registers no run, and the deploy stage
 * correctly times out with "CI never started". Injected at deploy time.
 *
 * Layout-adaptive: agents author either a flat Vite app (build → `dist`) or
 * a `web/` sub-package (build → `web/dist`); this detects both. Uses
 * `--no-frozen-lockfile` because agents don't commit a lockfile. R2_* secrets
 * are org-level (set once on the publishers org). `\${{ }}` is escaped to
 * survive the template literal.
 */
export function deployWorkflowYaml(_env: Env): string {
  return `name: Deploy to R2

on:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: deploy-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: pnpm install --no-frozen-lockfile

      - name: Build
        env:
          VITE_COMMIT_SHA: \${{ github.sha }}
        run: pnpm build || (cd web 2>/dev/null || true; npx vite build)

      - name: Locate build output
        id: dist
        run: |
          if [ -d web/dist ]; then echo "dir=web/dist" >> "$GITHUB_OUTPUT"
          elif [ -d dist ]; then echo "dir=dist" >> "$GITHUB_OUTPUT"
          else echo "::error::No build output (looked for ./dist and ./web/dist)"; exit 1; fi

      - name: Code-health scan (VCQA, report-only)
        continue-on-error: true
        run: |
          npx -y @vibecodeqa/cli@0.44.0 --skip-tests . || true
          if [ -f .vibe-check/report.json ]; then
            mkdir -p "\${{ steps.dist.outputs.dir }}/.vcqa"
            cp .vibe-check/report.json "\${{ steps.dist.outputs.dir }}/.vcqa/report.json"
            [ -f .vibe-check/badge.svg ] && cp .vibe-check/badge.svg "\${{ steps.dist.outputs.dir }}/.vcqa/badge.svg" || true
          fi

      - name: Upload to R2
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.R2_ACCESS_KEY_ID || vars.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.R2_SECRET_ACCESS_KEY || vars.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          R2_ACCOUNT_ID: \${{ secrets.R2_ACCOUNT_ID || vars.R2_ACCOUNT_ID }}
        run: |
          aws s3 sync "\${{ steps.dist.outputs.dir }}" "s3://pas-apps/apps/\${{ github.event.repository.name }}/" \\
            --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \\
            --delete --no-progress
          echo "Deployed apps/\${{ github.event.repository.name }} from \${{ github.sha }}"

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
        id: e2e
        continue-on-error: true
        working-directory: e2e
        env:
          E2E_BASE_URL: https://\${{ github.event.repository.name }}.proappstore.online
          E2E_SESSION_TOKEN: \${{ secrets.PAS_E2E_SESSION_TOKEN }}
        run: npx playwright test
      - name: Publish test results (kb.proappstore.online/<app>/.e2e/summary.json)
        if: always()
        working-directory: e2e
        env:
          INTERNAL_TOKEN: \${{ secrets.INTERNAL_TOKEN }}
          APP: \${{ github.event.repository.name }}
        run: |
          node -e '
            const fs=require("fs");
            let r={}; try{ r=JSON.parse(fs.readFileSync("results.json","utf8")); }catch{}
            const s=r.stats||{}, specs=[];
            const walk=(su=[])=>su.forEach(x=>{ (x.specs||[]).forEach(sp=>specs.push({title:[x.title,sp.title].filter(Boolean).join(" > "),ok:sp.ok!==false})); walk(x.suites||[]); });
            walk(r.suites||[]);
            fs.writeFileSync("summary.json", JSON.stringify({ ranAt:new Date().toISOString(), passed:s.expected||0, failed:s.unexpected||0, flaky:s.flaky||0, skipped:s.skipped||0, ok:(s.unexpected||0)===0, specs }));
          '
          [ -n "$INTERNAL_TOKEN" ] && curl -fsS -X PUT "https://kb.proappstore.online/_ingest/$APP/.e2e/summary.json" -H "x-internal-token: $INTERNAL_TOKEN" --data-binary @summary.json >/dev/null && echo "results → kb.proappstore.online/$APP/.e2e/summary.json" || echo "skipped results upload (no INTERNAL_TOKEN)"
      - name: Fail the run if E2E failed (bounces the ticket to Dev)
        if: steps.e2e.outcome != 'success'
        run: echo "::error::E2E tests failed — see the results above" && exit 1
`;
}

/**
 * Build the project's Knowledge Base (KNOWLEDGE.md + docs/) into a Zensical
 * static site and publish it to the shared `pas-kb` R2 bucket under `<app>/`,
 * served by proappstore-kb-host at kb.proappstore.online/<app>/. ONE bucket for
 * every KB — no CF Pages project per KB. Uploads each built file to the kb-host
 * Worker's `/_ingest` endpoint (which writes R2 via its binding) authed with the
 * shared INTERNAL_TOKEN — no R2 API-token scope needed. Injected at deploy;
 * triggers only when the KB markdown changes. `\${{ }}` escaped for the literal.
 */
function kbWorkflowYaml(): string {
  return `name: Publish Knowledge Base

on:
  push:
    branches: [main]
    # Include the workflow's own path so the commit that FIRST adds this file
    # triggers a build. Otherwise, when the KB content is unchanged, the publish
    # commit only touches kb.yml and the path filter never matches — so the
    # Zensical site never builds (the bug that left KBs unpublished / 404).
    paths: ['KNOWLEDGE.md', 'docs/**', '.github/workflows/kb.yml']
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: kb-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Gate on a Knowledge Base existing
        id: gate
        run: |
          if [ -f KNOWLEDGE.md ]; then echo "go=1" >> "$GITHUB_OUTPUT"; else echo "go=0" >> "$GITHUB_OUTPUT"; fi
      - uses: actions/setup-python@v5
        if: steps.gate.outputs.go == '1'
        with:
          python-version: '3.12'
      - uses: actions/setup-node@v4
        if: steps.gate.outputs.go == '1'
        with:
          node-version: 22
      - name: Build Zensical site
        if: steps.gate.outputs.go == '1'
        env:
          APP: \${{ github.event.repository.name }}
        run: |
          python -m pip install --quiet zensical
          rm -rf kb-src && mkdir -p kb-src/assets kb-src/stylesheets
          cp KNOWLEDGE.md kb-src/index.md
          if [ -d docs ]; then cp -r docs/. kb-src/; fi
          # ── ProAppStore brand: logo + favicon (purple gradient "A" mark) ──
          cat > kb-src/assets/logo.svg <<'SVG'
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient></defs><rect width="512" height="512" rx="96" fill="url(#bg)"/><text x="256" y="346" font-family="Manrope, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="800" font-size="300" fill="white" text-anchor="middle">A</text></svg>
          SVG
          cp kb-src/assets/logo.svg kb-src/assets/favicon.svg
          # ── ProAppStore brand: accent purple (#7c3aed light / #a78bfa dark) ──
          cat > kb-src/stylesheets/extra.css <<'CSS'
          :root > * {
            --md-primary-fg-color: #7c3aed;
            --md-primary-fg-color--light: #a78bfa;
            --md-primary-fg-color--dark: #4c1d95;
            --md-accent-fg-color: #7c3aed;
          }
          [data-md-color-scheme="slate"] {
            --md-primary-fg-color: #a78bfa;
            --md-primary-fg-color--light: #c4b5fd;
            --md-primary-fg-color--dark: #7c3aed;
            --md-accent-fg-color: #a78bfa;
          }
          .md-header__title { font-weight: 700; letter-spacing: -0.01em; }
          CSS
          # ── Branded site config ──
          cat > mkdocs.yml <<YAML
          site_name: $APP — Knowledge Base
          site_url: https://kb.proappstore.online/$APP/
          docs_dir: kb-src
          copyright: Built on ProAppStore · proappstore.online
          theme:
            name: material
            logo: assets/logo.svg
            favicon: assets/favicon.svg
            palette:
              - media: "(prefers-color-scheme: light)"
                scheme: default
                primary: custom
                accent: custom
                toggle:
                  icon: lucide/sun
                  name: Switch to dark mode
              - media: "(prefers-color-scheme: dark)"
                scheme: slate
                primary: custom
                accent: custom
                toggle:
                  icon: lucide/moon
                  name: Switch to light mode
          extra_css:
            - stylesheets/extra.css
          YAML
          zensical build
      - name: Publish to kb-host (R2 via Worker binding)
        if: steps.gate.outputs.go == '1'
        env:
          INTERNAL_TOKEN: \${{ secrets.INTERNAL_TOKEN }}
          APP: \${{ github.event.repository.name }}
        run: |
          if [ -z "$INTERNAL_TOKEN" ]; then echo "INTERNAL_TOKEN missing — cannot publish KB"; exit 1; fi
          out=site
          [ -d "$out" ] || out=public
          cd "$out"
          find . -type f | while read -r f; do
            curl -fsS -X PUT "https://kb.proappstore.online/_ingest/$APP/\${f#./}" -H "x-internal-token: $INTERNAL_TOKEN" --data-binary "@$f" >/dev/null
          done
          echo "Knowledge Base published → https://kb.proappstore.online/$APP/"
`;
}

function validateId(id: string): string | null {
  if (!id) return "id is required";
  if (id.length > 58) return "id must be 58 chars or less";
  if (!/^[a-z][a-z0-9-]*$/.test(id))
    return "id: lowercase alphanumeric + dashes, must start with letter";
  if (id.startsWith("pro")) return "id must not start with 'pro'";
  return null;
}

// GitHub repo (via build-core). R2 route + analytics are shared; only the
// DNS, analytics) are the shared build-core primitives — see provisionApp.
async function createRepo(env: Env, req: PublishRequest): Promise<Step> {
  const gh = ghFor(env);
  if (await gh.repoExists(req.id)) {
    return {
      name: "GitHub repo",
      status: "skip",
      detail: `${env.PUBLISHERS_ORG}/${req.id} already exists`,
    };
  }
  const result = await gh.createRepo(req.id, { description: req.description });
  if ((result.data as { id?: number }).id) {
    return { name: "GitHub repo", status: "ok", detail: `Created ${env.PUBLISHERS_ORG}/${req.id}` };
  }
  return {
    name: "GitHub repo",
    status: "fail",
    detail: (result.data as { message?: string }).message || "Failed to create repo",
  };
}

// Grant the creator push access to their own app repo. Without this the repo is
// owned only by the org and the creator gets 403 on `git push`. Non-fatal — the
// app still provisions if this fails. Outside collaborators get a pending invite
// they must accept (expires in ~7 days), so we surface that.
async function addCollaborator(env: Env, id: string, username: string): Promise<Step> {
  const res = await fetch(
    `https://api.github.com/repos/${env.PUBLISHERS_ORG}/${id}/collaborators/${encodeURIComponent(username)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "proappstore-admin",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ permission: "push" }),
    },
  );
  if (res.status === 204)
    return { name: "Collaborator", status: "skip", detail: `${username} already has push access` };
  if (res.ok) {
    return {
      name: "Collaborator",
      status: "ok",
      detail: `${username} invited as push collaborator — accept the GitHub invite at https://github.com/${env.PUBLISHERS_ORG}/${id}/invitations (check email/notifications) before pushing`,
    };
  }
  const body = await res.text().catch(() => "");
  return {
    name: "Collaborator",
    status: "fail",
    detail: `Failed to add ${username} (status ${res.status})${body ? `: ${body.slice(0, 120)}` : ""}`,
  };
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
    hostedOn: "r2",
    type: "connected",
    developer: "ProAppStore",
    ...(req.proFeatures?.length ? { proFeatures: req.proFeatures } : {}),
    ...(req.creatorGithub ? { creatorGithub: req.creatorGithub } : {}),
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
  if (update.status === 409)
    return { name: "Registry", status: "fail", detail: "Registry write contended — retry" };
  return {
    name: "Registry",
    status: "fail",
    detail: (update.data as { message?: string }).message || "Failed to update registry",
  };
}

// Push a file bundle as one commit via build-core (Git Data API; seeds empty repos).
async function pushFilesToGitHub(
  env: Env,
  id: string,
  files: Record<string, string>,
): Promise<Step & { commitSha?: string }> {
  const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
  if (entries.length === 0)
    return { name: "Push files", status: "skip", detail: "no files to push" };
  const res = await ghFor(env).pushFiles(id, entries, "Build update — ProAppStore Agent Teams", {
    initIfEmpty: true,
  });
  if (!res.ok) return { name: "Push files", status: "fail", detail: res.error || "push failed" };
  return {
    name: "Push files",
    status: "ok",
    detail: `Pushed ${entries.length} file(s) (${res.commitSha?.slice(0, 7)})`,
    commitSha: res.commitSha,
  };
}

/**
 * Internal: read a repo's current files (GitHub = source of truth) so the
 * agent-teams working tree can sync to the latest. `headOnly` returns just the
 * commit SHA/date for a cheap freshness check before pulling blobs.
 */
export async function handleRepoPull(
  req: { id: string; headOnly?: boolean },
  env: Env,
): Promise<{
  ok: boolean;
  sha?: string;
  date?: string;
  files?: Record<string, string>;
  truncated?: boolean;
  error?: string;
}> {
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
): Promise<{
  ok: boolean;
  status?: string;
  conclusion?: string;
  sha?: string;
  url?: string;
  errorTail?: string;
  error?: string;
}> {
  const gh = ghFor(env);
  if (!(await gh.repoExists(req.id))) return { ok: false, error: "repo not found" };
  return gh.deployResult(req.id, {
    waitMs: Math.min(req.waitMs ?? 0, 90_000),
    ...(req.sha ? { sha: req.sha } : {}),
  });
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
 * exact same hosting (repo + R2 route + analytics).
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
}

/**
 * The single provisioning core both entry points share, so a repo provisioned by
 * `pas publish` and one provisioned by the Agent Teams deploy stage are identical
 * (same R2 route, analytics). Every step is idempotent — it
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
  if (idError) {
    steps.push({ name: "Validation", status: "fail", detail: idError });
    return stop();
  }
  if (!req.name) {
    steps.push({ name: "Validation", status: "fail", detail: "name is required" });
    return stop();
  }

  // 1. GitHub repo (fatal)
  const repoStep = await createRepo(env, req);
  steps.push(repoStep);
  if (repoStep.status === "fail") return stop();
  repoUrl = `https://github.com/${env.PUBLISHERS_ORG}/${req.id}`;

  // 1b. Grant the creator push access to their own repo (non-fatal). Without
  //     this the repo is org-owned only and the creator gets 403 on `git push`.
  //     creatorGithub is injected from the verified session in /api/provision.
  if (req.creatorGithub) {
    steps.push(await addCollaborator(env, req.id, req.creatorGithub));
  }

  // 2. R2 route — register the app in the host Worker's routes table so
  //    <id>.proappstore.online resolves to R2. Idempotent (INSERT OR IGNORE).
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
         VALUES (?, ?, ?, 'pas', 'r2', ?, ?)`,
    )
      .bind(req.id, env.APPS_DOMAIN_BASE, `apps/${req.id}`, Date.now(), Date.now())
      .run();
    steps.push({
      name: "R2 route",
      status: "ok",
      detail: `${req.id}.${env.APPS_DOMAIN_BASE} → apps/${req.id}/`,
    });
  } catch (e) {
    steps.push({
      name: "R2 route",
      status: "fail",
      detail: `Route insert failed: ${(e as Error).message}`,
    });
    return stop();
  }

  // 4. Storefront listing (publish path only; fatal — the point of publishing)
  if (opts.addRegistry) {
    const registryStep = await addToRegistry(env, req);
    steps.push(registryStep);
    if (registryStep.status === "fail") return stop();
  }

  // 4. CF Web Analytics — uniform across stores, non-fatal, both paths
  const cf = cfFor(env);
  steps.push(await ensureAnalytics(cf, req.id));

  // 6. Agent path: ensure a deploy workflow exists, then push the bundle as one
  //    commit. Without an injected workflow a push triggers no CI and the deploy
  //    gate times out with "CI never started".
  let commitSha: string | undefined;
  if (opts.files) {
    const pushStep = await pushFilesToGitHub(env, req.id, buildAgentBundle(opts.files, env));
    steps.push(pushStep);
    if (pushStep.status === "fail") return stop();
    commitSha = pushStep.commitSha;
  }

  return { steps, success: true, repoUrl, commitSha };
}

/**
 * Prepare the agent-authored bundle for push: strip any agent-authored CI
 * workflow and inject the canonical deploy.yml + kb.yml + Playwright E2E harness.
 *
 * The PLATFORM owns CI. Agent Teams authors only app source — never a workflow.
 * Honoring an agent-authored workflow once let a bundle ship a BROKEN one and
 * silently suppress the known-good deploy (an agent hand-wrote `cache: pnpm`
 * with no committed lockfile, so setup-node hard-failed before install). The
 * canonical deployWorkflowYaml omits `cache: pnpm` and installs with
 * `--no-frozen-lockfile`, needing no lockfile. So: strip any authored workflow
 * (except our kb.yml) and always inject ours. Pure — shared by the inline path
 * and the durable workflow.
 */
export function buildAgentBundle(authored: Record<string, string>, env: Env): Record<string, string> {
  const files: Record<string, string> = { ...authored };
  for (const p of Object.keys(files)) {
    if (/^\.github\/workflows\/.+\.ya?ml$/i.test(p) && p !== KB_WORKFLOW_PATH) {
      delete files[p];
    }
  }
  files[DEPLOY_WORKFLOW_PATH] = deployWorkflowYaml(env);
  // Publish the Knowledge Base as a Zensical site to R2 (kb.proappstore.online/<app>/).
  if (!(KB_WORKFLOW_PATH in files)) files[KB_WORKFLOW_PATH] = kbWorkflowYaml();
  // Inject the Playwright E2E harness; never clobber authored files, and skip the
  // baseline smoke once the bundle carries QA-authored specs.
  const hasAuthoredSpecs = Object.keys(files).some((p) => p.startsWith(E2E_SPEC_PREFIX));
  for (const [path, content] of Object.entries(e2eHarnessFiles())) {
    if (path in files) continue;
    if (hasAuthoredSpecs && path.startsWith(E2E_SPEC_PREFIX)) continue;
    files[path] = content;
  }
  return files;
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
  return provisionApp(pubReq, env, { files: req.files ?? {} });
}

export interface PublishKbRequest {
  id: string;
  name?: string;
  description?: string;
  files: Record<string, string>; // KNOWLEDGE.md + docs/*.md (markdown only)
}

/**
 * Internal (agent-teams): publish a project's Knowledge Base as a Zensical site
 * WITHOUT building the app. Ensures the repo exists, then pushes ONLY the KB
 * markdown + the kb.yml workflow; kb.yml builds the Zensical site and uploads it
 * to R2 (kb.proappstore.online/<app>/). This lets a brainstorm-first KB be shared
 * before any app code is written. No CF/Pages/registry — KB hosting is the shared
 * pas-kb bucket + kb-host Worker. Idempotent (re-runs just re-push + rebuild).
 */
export async function handlePublishKb(
  req: PublishKbRequest,
  env: Env,
): Promise<{ success: boolean; repoUrl?: string; steps: Step[] }> {
  const steps: Step[] = [];
  const idError = validateId(req.id);
  if (idError)
    return { success: false, steps: [{ name: "Validation", status: "fail", detail: idError }] };

  // Guard: only KB markdown gets pushed here (never app source).
  const kbFiles: Record<string, string> = {};
  for (const [p, c] of Object.entries(req.files ?? {})) {
    if (p === "KNOWLEDGE.md" || /^docs\/.+\.(md|markdown)$/i.test(p)) kbFiles[p] = c;
  }
  if (Object.keys(kbFiles).length === 0) {
    return {
      success: false,
      steps: [{ name: "KB", status: "fail", detail: "no KNOWLEDGE.md / docs markdown to publish" }],
    };
  }

  // Ensure the repo exists (idempotent; pushFiles seeds it if empty).
  const gh = ghFor(env);
  if (!(await gh.repoExists(req.id))) {
    const r = await gh.createRepo(req.id, {
      description: req.description || `${req.name ?? req.id} — Knowledge Base`,
    });
    if (!(r.data as { id?: number }).id) {
      steps.push({
        name: "GitHub repo",
        status: "fail",
        detail: (r.data as { message?: string }).message || "create failed",
      });
      return { success: false, steps };
    }
    steps.push({
      name: "GitHub repo",
      status: "ok",
      detail: `Created ${env.PUBLISHERS_ORG}/${req.id}`,
    });
  } else {
    steps.push({ name: "GitHub repo", status: "skip", detail: "exists" });
  }

  // Add the publish workflow so this push triggers the Zensical build + R2 upload.
  kbFiles[KB_WORKFLOW_PATH] = kbWorkflowYaml();
  const pushStep = await pushFilesToGitHub(env, req.id, kbFiles);
  steps.push(pushStep);
  return {
    success: pushStep.status !== "fail",
    repoUrl: `https://github.com/${env.PUBLISHERS_ORG}/${req.id}`,
    steps,
  };
}

/**
 * SDK/CLI publish (`/api/publish-app`, user session): full provision including
 * the storefront listing. Thin wrapper over {@link provisionApp} — DNS fatal,
 * registry added, files pushed separately by the CLI.
 */
export async function handlePublish(
  req: PublishRequest,
  env: Env,
): Promise<{ steps: Step[]; success: boolean }> {
  const { steps, success } = await provisionApp(req, env, { addRegistry: true });
  return { steps, success };
}

// ─── Cloudflare Workflows spike: durable publish provisioning ────────────────
//
// provisionApp() above is the live path: a single Worker invocation that runs
// every step inline and aborts on the first fatal failure. A transient GitHub/CF
// blip mid-sequence fails the whole call; the caller must retry from scratch
// (safe only because every step is idempotent, but wasteful and opaque).
//
// runProvisionSteps() re-expresses the PUBLISH path as an ordered list of steps
// driven by an injected `doStep` runner. The Cloudflare Workflow shell
// (ProvisionWorkflow in provision-workflow.ts) passes `step.do`, so the engine
// PERSISTS progress and retries only the failed step with backoff — completed
// steps are memoized and never re-run. Keeping the orchestration here (free of
// the workerd-only `cloudflare:workers` import) lets it run under the Node test
// runner; the workflow shell stays a thin, workerd-only adapter.
//
// Fatal steps throw to engage retry; a bad id throws ProvisionValidationError
// (the shell maps it to a NonRetryableError — no point retrying validation);
// non-fatal steps (collaborator, analytics) return their skip/fail Step as data
// and never abort the run.
//
// Spike: the inline path stays the default. The workflow is wired behind
// /api/provision-workflow for evaluation before any cutover, and is the
// foundation for the parts provisionApp can't do well — waiting on CI to go
// green (step.waitForEvent) and human publish approval, both billed at $0 while
// idle. Refs proappstore-online/platform#24.

/** Serializable trigger payload for the provisioning workflow. */
export interface ProvisionParams {
  req: PublishRequest;
  /** Publish path adds the storefront registry entry; agent path omits it. */
  addRegistry?: boolean;
  /** Agent path: authored bundle to push (with canonical CI injected). When set,
   *  a push step runs and the registry step is skipped (apps iterate, then
   *  publish explicitly). Mirrors provisionApp's `opts.files`. */
  files?: Record<string, string>;
}

/** Thrown for a deterministic input error — the workflow shell maps this to a
 *  NonRetryableError so the engine doesn't retry a bad id/name. */
export class ProvisionValidationError extends Error {}

/** Runs one provisioning step. The workflow passes `step.do`; tests pass a
 *  pass-through. Every step yields a {@link Step}. */
export type StepRunner = (name: string, cb: () => Promise<Step>) => Promise<Step>;

/** Await a fatal step's result; throw (→ retry) if it failed. Generic so a
 *  step's extra fields (e.g. pushFilesToGitHub's commitSha) survive. */
async function fatalStep<T extends Step>(p: Promise<T>): Promise<T> {
  const s = await p;
  if (s.status === "fail") throw new Error(`${s.name}: ${s.detail}`);
  return s;
}

/**
 * The provisioning sequence, factored out so both the durable Workflow and the
 * Node test runner can drive it. Mirrors provisionApp(): publish path adds the
 * registry; agent path (params.files) pushes the bundle and skips the registry.
 */
export async function runProvisionSteps(
  params: ProvisionParams,
  env: Env,
  doStep: StepRunner,
): Promise<{ steps: Step[]; repoUrl: string; commitSha?: string }> {
  const { req, addRegistry, files } = params;
  const steps: Step[] = [];

  // Validation — deterministic; never worth retrying.
  const idError = validateId(req.id);
  if (idError) throw new ProvisionValidationError(`Validation: ${idError}`);
  if (!req.name) throw new ProvisionValidationError("Validation: name is required");

  // 1. GitHub repo (fatal, retryable).
  steps.push(await doStep("github-repo", () => fatalStep(createRepo(env, req))));

  // 1b. Grant the creator push access (non-fatal).
  const creator = req.creatorGithub;
  if (creator) {
    steps.push(await doStep("collaborator", () => addCollaborator(env, req.id, creator)));
  }

  // 2. R2 route — register <id>.<base> → apps/<id>/ (fatal, retryable, idempotent).
  steps.push(
    await doStep("r2-route", async (): Promise<Step> => {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
           VALUES (?, ?, ?, 'pas', 'r2', ?, ?)`,
      )
        .bind(req.id, env.APPS_DOMAIN_BASE, `apps/${req.id}`, Date.now(), Date.now())
        .run();
      return {
        name: "R2 route",
        status: "ok",
        detail: `${req.id}.${env.APPS_DOMAIN_BASE} → apps/${req.id}/`,
      };
    }),
  );

  // 3. Storefront listing (publish path only; fatal).
  if (addRegistry) {
    steps.push(await doStep("registry", () => fatalStep(addToRegistry(env, req))));
  }

  // 4. CF Web Analytics (non-fatal).
  steps.push(await doStep("analytics", () => ensureAnalytics(cfFor(env), req.id)));

  // 5. Agent path: push the bundle as one commit (fatal). Canonical CI is
  //    injected by buildAgentBundle so the push actually triggers a deploy.
  let commitSha: string | undefined;
  if (files) {
    const push = await doStep("push-files", () =>
      fatalStep(pushFilesToGitHub(env, req.id, buildAgentBundle(files, env))),
    );
    steps.push(push);
    // commitSha rides on the push Step object at runtime (pushFilesToGitHub).
    commitSha = (push as Step & { commitSha?: string }).commitSha;
  }

  return { steps, repoUrl: `https://github.com/${env.PUBLISHERS_ORG}/${req.id}`, commitSha };
}
