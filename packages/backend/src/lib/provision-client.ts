/**
 * Shared helper for calling the FAS admin Worker's /api/provision endpoint
 * via the ADMIN service binding. Used by:
 *   - /v1/provision (direct provision call from `pas create` / `pas publish`)
 *   - /v1/submissions/:id/approve (admin approves a dev submission)
 *
 * Service-binding fetches bypass the public edge (and CF Access). The
 * synthetic "internal-admin" host is intentional — fas/admin's
 * isAuthenticated() treats any *.freeappstore.online host as a public call
 * requiring a CF Access JWT, which service-binding calls don't have.
 */

import type { Step } from '@proappstore/build-core';

/** Provisioning step outcome — canonical shape lives in build-core. */
export type ProvisionStep = Step;

export interface ProvisionBody {
  appId: string;
  /** Display name. Defaults to a Title Case of appId. */
  name?: string;
  category?: string;
  icon?: string;
  iconBg?: string;
  description?: string;
  /** "standalone" | "connected". Defaults to "connected" for pro apps. */
  type?: string;
  proFeatures?: string[];
  /** Skip the FAS-admin call (e.g. when the GitHub repo + CF Pages already exist). */
  skipPublish?: boolean;
  /**
   * Override the default repo location (`proappstore-online/<appId>`) for the
   * server-side compliance check. Use for third-party publisher orgs whose
   * source repo lives outside `proappstore-online` (e.g. `carsads-online`).
   */
  repoOwner?: string;
  repoName?: string;
  /** Ref/branch/SHA to check. Defaults to `main`. */
  ref?: string;
  /**
   * Skip the server-side compliance check. Intended only for the bootstrap
   * call from `pas create` (when the GitHub repo doesn't exist yet). Routine
   * `pas publish` MUST leave this false — it's the only un-bypassable
   * enforcement boundary the platform has.
   */
  skipCompliance?: boolean;
}

export type AdminProvisionResult =
  | { steps: ProvisionStep[]; success: boolean }
  | { error: string };

export function toTitleCase(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Call one of the FAS admin Worker's /api/apps/:proj/domains endpoints via
 * the ADMIN service binding. Used by /v1/apps/:appId/domains in the PAS
 * backend to attach/check/remove BYO custom domains on a Pro app's CF Pages
 * project. The admin Worker proxies to CF's /pages/projects/:proj/domains
 * with the platform's CF_API_TOKEN — PAS never touches CF Pages directly.
 *
 * Returns CF's response body verbatim (parsed) plus the HTTP status. CF's
 * shape on success is `{ success: true, result: { name, status, verification_data, ... } }`;
 * on failure `{ success: false, errors: [{ code, message }] }`. The caller
 * is responsible for shaping that into the PAS API response.
 */
export interface AdminDomainResponse {
  status: number;
  body: unknown;
}

export async function callAdminDomain(
  admin: Fetcher,
  proj: string,
  init: {
    domain?: string;
    method: 'POST' | 'GET' | 'PATCH' | 'DELETE';
    body?: unknown;
  },
): Promise<AdminDomainResponse> {
  const path = init.domain
    ? `/api/apps/${encodeURIComponent(proj)}/domains/${encodeURIComponent(init.domain)}`
    : `/api/apps/${encodeURIComponent(proj)}/domains`;
  const fetchInit: RequestInit = { method: init.method };
  if (init.body !== undefined) {
    fetchInit.headers = { 'Content-Type': 'application/json' };
    fetchInit.body = JSON.stringify(init.body);
  }
  const res = await admin.fetch(`https://internal-admin${path}`, fetchInit);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = { error: `non-JSON response from admin (${res.status})` };
  }
  return { status: res.status, body: parsed };
}

export async function callAdminProvision(
  admin: Fetcher,
  body: ProvisionBody & { appId: string },
): Promise<AdminProvisionResult> {
  const payload = {
    id: body.appId,
    name: body.name || toTitleCase(body.appId),
    category: body.category || 'utilities',
    icon: body.icon || '&#128230;',
    iconBg: body.iconBg || '#f5f3ff',
    description: body.description || `${body.name || toTitleCase(body.appId)} — pro app on ProAppStore.`,
    store: 'apps_pro',
    type: body.type || 'connected',
    proFeatures: body.proFeatures,
  };
  const res = await admin.fetch('https://internal-admin/api/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // FAS admin returns 200 on full success, 400 if any step failed but the
  // call itself completed. Both shapes carry { steps, success }.
  if (res.status >= 500) {
    return { error: `FAS admin returned ${res.status}: ${await res.text()}` };
  }
  try {
    return (await res.json()) as { steps: ProvisionStep[]; success: boolean };
  } catch (e) {
    return { error: `Invalid response from FAS admin: ${e}` };
  }
}
