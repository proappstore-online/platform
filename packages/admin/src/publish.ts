import { makeGitHub } from "@proappstore/build-core";
import type { Env } from "./env.js";

const ghFor = (env: Env) => makeGitHub(env.GITHUB_TOKEN, env.PUBLISHERS_ORG);

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

// Step 1: GitHub repo (via build-core)
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
  const keyRes = await ghFor(env).api(`/repos/${env.PUBLISHERS_ORG}/${id}/actions/secrets/public-key`);
  if (!(keyRes.data as { key?: string }).key) {
    return { name: "Repo secret", status: "skip", detail: "Could not get repo public key (repo may need first push)" };
  }
  // GitHub Actions secrets need libsodium encryption, unavailable in Workers —
  // skip and document.
  return { name: "Repo secret", status: "skip", detail: "CLOUDFLARE_API_TOKEN must be set manually via gh CLI or GitHub UI" };
}

// Step 6: Registry entry
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
 * Internal: create the repo (if needed) and push the authored file bundle.
 * Called by the agent-teams Worker over the service binding.
 *
 * Deliberately does NOT add a registry entry: hosting (CF/Path B) isn't
 * provisioned here (issue #7), so listing the app would advertise an appUrl
 * that 404s. The storefront listing happens at the real publish/provision step.
 * This is purely "ship the agent's code to a sanctioned repo."
 */
export async function handleAgentDeploy(
  req: AgentDeployRequest,
  env: Env,
): Promise<{ steps: Step[]; success: boolean; repoUrl: string | null; commitSha?: string }> {
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

  return { steps, success: steps.every((s) => s.status !== "fail"), repoUrl, commitSha: pushStep.commitSha };
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
