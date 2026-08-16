/**
 * Helpers for talking to GitHub + the PAS platform API, plus
 * connection-token extraction/verification for the MCP transport.
 */

export async function getDeployStatus(org: string, appId: string, ghToken?: string) {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "proappstore-mcp" };
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  const res = await fetch(
    `https://api.github.com/repos/${org}/${appId}/actions/runs?per_page=5`,
    { headers },
  );
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  const data = (await res.json()) as {
    workflow_runs: Array<{
      name: string;
      conclusion: string | null;
      status: string;
      updated_at: string;
      html_url: string;
      head_sha: string;
    }>;
  };
  return (data.workflow_runs ?? []).map((r) => ({
    name: r.name,
    status: r.conclusion ?? r.status,
    updatedAt: r.updated_at,
    url: r.html_url,
    sha: r.head_sha?.slice(0, 7),
  }));
}

export async function pasApi(api: Fetcher, apiBase: string, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await api.fetch(`${apiBase}${path}`, { headers });
  if (!res.ok) return { error: `API ${res.status}: ${await res.text()}` };
  return await res.json();
}

/** The signed-in user's account details, as returned by `/v1/auth/me/account` (#136). */
export interface AccountDetails {
  provider: string;
  providerLabel: string;
  accountType: "oauth" | "credential" | "child";
  email: string | null;
  emailVerified: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
}

/**
 * Fetch the connected user's email / sign-in provider / account type (#136).
 *
 * Sends BOTH credentials the backend route demands: the user's session token
 * (who they are) and INTERNAL_TOKEN (that this is a first-party Worker). The
 * route is gated on the latter precisely so creator-controlled app JS — which
 * holds a user session but not the shared worker secret — cannot read addresses.
 *
 * Returns null on ANY failure, including an unset INTERNAL_TOKEN, so `whoami`
 * degrades to the identity it can always derive from the session token itself
 * rather than breaking when the secret is not deployed.
 */
export async function fetchAccount(
  api: Fetcher,
  apiBase: string,
  token: string,
  internalToken: string | undefined,
): Promise<AccountDetails | null> {
  if (!internalToken) return null;
  try {
    const res = await api.fetch(`${apiBase}/v1/auth/me/account`, {
      headers: { Authorization: `Bearer ${token}`, "X-Internal-Token": internalToken },
    });
    if (!res.ok) return null;
    return (await res.json()) as AccountDetails;
  } catch {
    return null;
  }
}

/**
 * Extract session token from the MCP transport's initial request headers.
 * The agent passes `Authorization: Bearer <token>` when connecting.
 */
export function extractToken(props: Record<string, unknown>): string | null {
  // McpAgent passes connection props; check for auth header
  const auth = (props as { authToken?: string }).authToken;
  return auth ?? null;
}

/**
 * Verify a session token locally via HMAC. Returns user info or null.
 */
export async function verifyToken(signingKey: string, token: string): Promise<{ id: string; login: string } | null> {
  const { verifySession } = await import("./session.js");
  const payload = await verifySession(token, signingKey);
  if (!payload) return null;
  return { id: payload.uid, login: (payload as { login?: string }).login ?? payload.uid };
}
