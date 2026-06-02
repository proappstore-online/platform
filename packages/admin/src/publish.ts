import type { Env } from "./env.js";

export interface PublishRequest {
  id: string;
  name: string;
  category: string;
  icon: string;
  iconBg: string;
  description: string;
  proFeatures?: string[];
}

interface Step {
  name: string;
  status: "ok" | "skip" | "fail";
  detail: string;
}

function validateId(id: string): string | null {
  if (!id) return "id is required";
  if (id.length > 58) return "id must be 58 chars or less";
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return "id: lowercase alphanumeric + dashes, must start with letter";
  if (id.startsWith("pro")) return "id must not start with 'pro'";
  return null;
}

async function cfApi(env: Env, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { success: false, text }; }
}

async function ghApi(env: Env, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "proappstore-admin/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ...JSON.parse(text), __status: res.status }; } catch { return { __status: res.status, __raw: text }; }
}

// Step 1: GitHub repo
async function createRepo(env: Env, req: PublishRequest): Promise<Step> {
  const check = await ghApi(env, `/repos/${env.PUBLISHERS_ORG}/${req.id}`);
  if (check.id) return { name: "GitHub repo", status: "skip", detail: `${env.PUBLISHERS_ORG}/${req.id} already exists` };

  const result = await ghApi(env, `/orgs/${env.PUBLISHERS_ORG}/repos`, "POST", {
    name: req.id,
    private: false,
    description: req.description,
    auto_init: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  });
  if (result.id) return { name: "GitHub repo", status: "ok", detail: `Created ${env.PUBLISHERS_ORG}/${req.id}` };
  return { name: "GitHub repo", status: "fail", detail: result.message || "Failed to create repo" };
}

// Step 2: CF Pages project
async function createPagesProject(env: Env, id: string): Promise<Step> {
  const projectName = `proappstore-${id}`;
  const check = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${projectName}`);
  if (check.success) return { name: "CF Pages project", status: "skip", detail: `${projectName} already exists` };

  const result = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects`, "POST", {
    name: projectName,
    production_branch: "main",
  });
  if (result.success) return { name: "CF Pages project", status: "ok", detail: `Created ${projectName}` };
  return { name: "CF Pages project", status: "fail", detail: result.errors?.[0]?.message || "Failed" };
}

// Step 3: Custom domain on Pages project
async function addCustomDomain(env: Env, id: string): Promise<Step> {
  const projectName = `proappstore-${id}`;
  const domain = `${id}.${env.APPS_DOMAIN_BASE}`;

  const existing = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${projectName}/domains`);
  if (existing.success && existing.result?.some((d: { name: string }) => d.name === domain)) {
    return { name: "Custom domain", status: "skip", detail: `${domain} already configured` };
  }

  const result = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${projectName}/domains`, "POST", { name: domain });
  if (result.success) return { name: "Custom domain", status: "ok", detail: `Added ${domain} to ${projectName}` };
  return { name: "Custom domain", status: "fail", detail: result.errors?.[0]?.message || "Failed" };
}

// Step 4: DNS CNAME
async function createDnsCname(env: Env, id: string): Promise<Step> {
  const name = `${id}.${env.APPS_DOMAIN_BASE}`;
  const target = `proappstore-${id}.pages.dev`;

  const existing = await cfApi(env, `/zones/${env.PAS_ZONE_ID}/dns_records?name=${name}&type=CNAME`);
  if (existing.success && existing.result?.length > 0) {
    return { name: "DNS CNAME", status: "skip", detail: `${name} already exists` };
  }

  const result = await cfApi(env, `/zones/${env.PAS_ZONE_ID}/dns_records`, "POST", {
    type: "CNAME",
    name: id,
    content: target,
    proxied: true,
  });
  if (result.success) return { name: "DNS CNAME", status: "ok", detail: `${name} → ${target}` };
  return { name: "DNS CNAME", status: "fail", detail: result.errors?.[0]?.message || "Failed to create CNAME" };
}

// Step 5: Set CLOUDFLARE_API_TOKEN repo secret for CI deploys
async function setRepoSecret(env: Env, id: string): Promise<Step> {
  const repo = `${env.PUBLISHERS_ORG}/${id}`;
  // Get repo public key for secret encryption
  const keyRes = await ghApi(env, `/repos/${repo}/actions/secrets/public-key`);
  if (!keyRes.key) return { name: "Repo secret", status: "skip", detail: "Could not get repo public key (repo may need first push)" };

  // GitHub Actions secrets need to be encrypted with libsodium.
  // Workers don't have libsodium, so we skip this step and document it.
  return { name: "Repo secret", status: "skip", detail: "CLOUDFLARE_API_TOKEN must be set manually via gh CLI or GitHub UI" };
}

// Step 6: Registry entry
async function addToRegistry(env: Env, req: PublishRequest): Promise<Step> {
  const registryPath = `/repos/${env.PUBLISHERS_ORG}/proappstore/contents/registry.json`;
  const file = await ghApi(env, registryPath);
  if (!file.content) return { name: "Registry", status: "fail", detail: "Could not read registry.json" };

  const raw = new TextDecoder().decode(
    Uint8Array.from(atob(file.content.replace(/\n/g, "")), c => c.charCodeAt(0)),
  );
  const content = JSON.parse(raw);
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

  const encoded = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(content, null, 2)))
      .map(b => String.fromCharCode(b))
      .join(""),
  );

  const update = await ghApi(env, registryPath, "PUT", {
    message: `Add ${req.name} to registry`,
    content: encoded,
    sha: file.sha,
  });

  if (update.content || update.__status === 200) return { name: "Registry", status: "ok", detail: `Added ${req.name}` };
  if (update.__status === 409) return { name: "Registry", status: "fail", detail: "Registry write contended — retry" };
  return { name: "Registry", status: "fail", detail: update.message || "Failed to update registry" };
}

// Step 7: CF Web Analytics
async function provisionAnalytics(env: Env, id: string): Promise<Step> {
  const host = `${id}.${env.APPS_DOMAIN_BASE}`;
  try {
    const existing = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/rum/site_info/list`);
    if (existing?.success && existing.result?.some((s: { host: string }) => s.host === host)) {
      return { name: "Analytics", status: "skip", detail: `RUM site already exists for ${host}` };
    }
    const result = await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/rum/site_info`, "POST", {
      host,
      zone_tag: env.PAS_ZONE_ID,
      auto_install: false,
    });
    if (result.success) return { name: "Analytics", status: "ok", detail: `Minted RUM site for ${host}` };
    return { name: "Analytics", status: "skip", detail: `(non-fatal) ${result.errors?.[0]?.message || "failed"}` };
  } catch (e) {
    return { name: "Analytics", status: "skip", detail: `(non-fatal) ${e}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Push a file bundle to the repo as one commit via the Git Data API
// (blobs → tree → commit → ref). Ported from fas/agent/src/deploy.ts.
async function pushFilesToGitHub(env: Env, id: string, files: Record<string, string>): Promise<Step> {
  const repo = `${env.PUBLISHERS_ORG}/${id}`;
  const entries = Object.entries(files);
  if (entries.length === 0) return { name: "Push files", status: "skip", detail: "no files to push" };

  // Git Data API needs an existing ref. Seed an empty repo via the Contents API.
  const ref = await ghApi(env, `/repos/${repo}/git/ref/heads/main`);
  if (!ref.object?.sha) {
    await ghApi(env, `/repos/${repo}/contents/README.md`, "PUT", {
      message: "Initialize repo",
      content: btoa("# Initial commit\n"),
    });
    await sleep(1000); // let GitHub register the ref
  }

  const headRef = await ghApi(env, `/repos/${repo}/git/ref/heads/main`);
  const parentSha: string | undefined = headRef.object?.sha;

  const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const [path, content] of entries) {
    const blob = await ghApi(env, `/repos/${repo}/git/blobs`, "POST", { content, encoding: "utf-8" });
    if (!blob.sha) return { name: "Push files", status: "fail", detail: `blob failed for ${path}: ${blob.message || "unknown"}` };
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Build the tree on top of the existing one (so we don't drop untouched files).
  let baseTree: string | undefined;
  if (parentSha) {
    const parentCommit = await ghApi(env, `/repos/${repo}/git/commits/${parentSha}`);
    baseTree = parentCommit.tree?.sha;
  }
  const tree = await ghApi(env, `/repos/${repo}/git/trees`, "POST",
    baseTree ? { base_tree: baseTree, tree: treeItems } : { tree: treeItems });
  if (!tree.sha) return { name: "Push files", status: "fail", detail: `tree failed: ${tree.message || "unknown"}` };

  const commit = await ghApi(env, `/repos/${repo}/git/commits`, "POST", {
    message: "Build update — ProAppStore Agent Teams",
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (!commit.sha) return { name: "Push files", status: "fail", detail: `commit failed: ${commit.message || "unknown"}` };

  const upd = await ghApi(env, `/repos/${repo}/git/refs/heads/main`, "PATCH", { sha: commit.sha });
  if (!upd.ref && upd.__status !== 200) {
    return { name: "Push files", status: "fail", detail: `ref update failed: ${upd.message || "unknown"}` };
  }
  return { name: "Push files", status: "ok", detail: `Pushed ${treeItems.length} file(s) (${commit.sha.slice(0, 7)})` };
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
 * Internal: create the repo (if needed), push the authored file bundle, and
 * register the app. Called by the agent-teams Worker over the service binding.
 * Hosting provisioning (CF/Path B) stays with the human publish flow / issue #7;
 * this is the "ship the agent's code to a sanctioned repo + register it" path.
 */
export async function handleAgentDeploy(
  req: AgentDeployRequest,
  env: Env,
): Promise<{ steps: Step[]; success: boolean; repoUrl: string | null }> {
  const idError = validateId(req.id);
  if (idError) return { steps: [{ name: "Validation", status: "fail", detail: idError }], success: false, repoUrl: null };
  if (!req.name) return { steps: [{ name: "Validation", status: "fail", detail: "name is required" }], success: false, repoUrl: null };

  const pubReq: PublishRequest = {
    id: req.id,
    name: req.name,
    category: req.category || "Productivity",
    icon: req.icon || "📦",
    iconBg: req.iconBg || "#7c3aed",
    description: req.description || req.name,
  };
  const repoUrl = `https://github.com/${env.PUBLISHERS_ORG}/${req.id}`;
  const steps: Step[] = [];

  const repoStep = await createRepo(env, pubReq);
  steps.push(repoStep);
  if (repoStep.status === "fail") return { steps, success: false, repoUrl: null };

  const pushStep = await pushFilesToGitHub(env, req.id, req.files || {});
  steps.push(pushStep);
  if (pushStep.status === "fail") return { steps, success: false, repoUrl };

  const registryStep = await addToRegistry(env, pubReq);
  steps.push(registryStep);

  return { steps, success: steps.every((s) => s.status !== "fail"), repoUrl };
}

export async function handlePublish(req: PublishRequest, env: Env): Promise<{ steps: Step[]; success: boolean }> {
  const idError = validateId(req.id);
  if (idError) return { steps: [{ name: "Validation", status: "fail", detail: idError }], success: false };
  if (!req.name) return { steps: [{ name: "Validation", status: "fail", detail: "name is required" }], success: false };

  const steps: Step[] = [];

  const repoStep = await createRepo(env, req);
  steps.push(repoStep);
  if (repoStep.status === "fail") return { steps, success: false };

  const pagesStep = await createPagesProject(env, req.id);
  steps.push(pagesStep);
  if (pagesStep.status === "fail") return { steps, success: false };

  const domainStep = await addCustomDomain(env, req.id);
  steps.push(domainStep);

  const dnsStep = await createDnsCname(env, req.id);
  steps.push(dnsStep);
  if (dnsStep.status === "fail") return { steps, success: false };

  const secretStep = await setRepoSecret(env, req.id);
  steps.push(secretStep);

  const registryStep = await addToRegistry(env, req);
  steps.push(registryStep);

  const analyticsStep = await provisionAnalytics(env, req.id);
  steps.push(analyticsStep);

  const success = steps.every(s => s.status !== "fail");
  return { steps, success };
}
