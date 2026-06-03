/**
 * Cloudflare provisioning primitives — Pages project, DNS CNAME, custom domain,
 * Web Analytics. Pure: takes a token + account/zone, uses the global fetch, no
 * Worker bindings. Shared by packages/admin (publish + agent-deploy) and
 * packages/backend (/v1/provision) so the CF hosting logic lives ONCE instead of
 * being copied per entrypoint (the copies had already drifted).
 *
 * All `ensure*` calls are idempotent: POST-first, and a CF "already exists"
 * error is reported as `skip`, not `fail`. Each returns a {@link Step} the
 * caller appends to its step list.
 */

export interface CfConfig {
  /** CF API token (Bearer). Needs Pages:Edit + DNS:Edit for these calls. */
  token: string;
  accountId: string;
  zoneId: string;
  /** Apex the app subdomains hang off, e.g. "proappstore.online". */
  domainBase: string;
}

/** A single provisioning step's outcome. The canonical shape shared by every
 *  provisioning path (admin publish/agent-deploy, backend /v1/provision). */
export interface Step {
  name: string;
  status: "ok" | "skip" | "fail";
  detail: string;
}

interface CfResponse {
  success?: boolean;
  result?: unknown;
  errors?: { message?: string; code?: number }[];
}

/** CF Pages project name for an app id (the wrangler deploy target). */
export function pagesProjectName(id: string): string {
  return `proappstore-${id}`;
}

async function cfApi(cfg: CfConfig, path: string, method = "GET", body?: unknown): Promise<CfResponse> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text) as CfResponse; } catch { return { success: false, errors: [{ message: text }] }; }
}

/** True when a CF error means the resource is already provisioned (idempotent). */
function alreadyExists(r: CfResponse): boolean {
  return (r.errors ?? []).some(
    (e) => /already|exists/i.test(e.message ?? "") || e.code === 81057,
  );
}

const firstErr = (r: CfResponse) => r.errors?.[0]?.message || "unknown error";

/** CF Pages project (POST-first; skip if it already exists). */
export async function ensurePagesProject(cfg: CfConfig, id: string): Promise<Step> {
  const name = pagesProjectName(id);
  const r = await cfApi(cfg, `/accounts/${cfg.accountId}/pages/projects`, "POST", {
    name,
    production_branch: "main",
  });
  if (r.success) return { name: "CF Pages project", status: "ok", detail: name };
  if (alreadyExists(r)) return { name: "CF Pages project", status: "skip", detail: `${name} already exists` };
  return { name: "CF Pages project", status: "fail", detail: firstErr(r) };
}

/** DNS CNAME <id>.<domainBase> → <project>.pages.dev (proxied). */
export async function ensureDnsCname(cfg: CfConfig, id: string): Promise<Step> {
  const host = `${id}.${cfg.domainBase}`;
  const r = await cfApi(cfg, `/zones/${cfg.zoneId}/dns_records`, "POST", {
    type: "CNAME",
    name: id,
    content: `${pagesProjectName(id)}.pages.dev`,
    proxied: true,
  });
  if (r.success) return { name: "DNS", status: "ok", detail: `${host} → ${pagesProjectName(id)}.pages.dev` };
  if (alreadyExists(r)) return { name: "DNS", status: "skip", detail: `${host} CNAME already exists` };
  return { name: "DNS", status: "fail", detail: firstErr(r) };
}

/** Attach the custom domain <id>.<domainBase> to the Pages project. */
export async function ensureCustomDomain(cfg: CfConfig, id: string): Promise<Step> {
  const host = `${id}.${cfg.domainBase}`;
  const r = await cfApi(cfg, `/accounts/${cfg.accountId}/pages/projects/${pagesProjectName(id)}/domains`, "POST", { name: host });
  if (r.success) return { name: "custom domain", status: "ok", detail: host };
  if (alreadyExists(r)) return { name: "custom domain", status: "skip", detail: `${host} already configured` };
  return { name: "custom domain", status: "fail", detail: firstErr(r) };
}

/** CF Web Analytics (RUM) site for the app host. Non-fatal by nature — minting
 *  analytics should never block a deploy, so failures come back as `skip`. */
export async function ensureAnalytics(cfg: CfConfig, id: string): Promise<Step> {
  const host = `${id}.${cfg.domainBase}`;
  try {
    const existing = await cfApi(cfg, `/accounts/${cfg.accountId}/rum/site_info/list`);
    if (existing.success && (existing.result as { host: string }[] | undefined)?.some((s) => s.host === host)) {
      return { name: "Analytics", status: "skip", detail: `RUM site already exists for ${host}` };
    }
    const r = await cfApi(cfg, `/accounts/${cfg.accountId}/rum/site_info`, "POST", {
      host,
      zone_tag: cfg.zoneId,
      auto_install: false,
    });
    if (r.success) return { name: "Analytics", status: "ok", detail: `Minted RUM site for ${host}` };
    return { name: "Analytics", status: "skip", detail: `(non-fatal) ${firstErr(r)}` };
  } catch (e) {
    return { name: "Analytics", status: "skip", detail: `(non-fatal) ${e}` };
  }
}
