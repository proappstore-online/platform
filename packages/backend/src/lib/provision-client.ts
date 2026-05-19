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

export interface ProvisionStep {
  name: string;
  status: 'ok' | 'skip' | 'fail';
  detail: string;
}

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
