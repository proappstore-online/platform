/**
 * Redirect validation for an app's own checkout (#507). Stripe sends the buyer to these URLs,
 * so each must be on one of THAT app's origins: its PAS subdomain, its active (verified) custom
 * domains and their subdomains, or localhost. `isAllowedRedirectUrl` in routes/subscription.ts
 * (any *.proappstore.online, *.pages.dev) is for the platform's own Pro flow and stays as it is:
 * accepting it here would let app A send its buyers to app B.
 */

async function appRedirectHosts(db: D1Database, appId: string): Promise<{ exact: string[]; domains: string[] }> {
  const { results } = await db.prepare("SELECT domain FROM app_custom_domains WHERE app_id = ? AND status = 'active'")
    .bind(appId).all<{ domain: string }>();
  return { exact: [`${appId}.proappstore.online`], domains: (results ?? []).map((r) => r.domain.toLowerCase()) };
}

export function hostAllowedForApp(host: string, allowed: { exact: string[]; domains: string[] }): boolean {
  return allowed.exact.includes(host) || allowed.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function isAllowedAppRedirectUrl(db: D1Database, appId: string, raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return url.protocol === 'http:' || url.protocol === 'https:';
  if (url.protocol !== 'https:') return false;
  return hostAllowedForApp(host, await appRedirectHosts(db, appId));
}
