/**
 * Helpers for talking to GitHub + the PAS/FAS platform APIs, plus
 * connection-token extraction/verification for the MCP transport.
 */

export async function getDeployStatus(org: string, appId: string) {
  const res = await fetch(
    `https://api.github.com/repos/${org}/${appId}/actions/runs?per_page=5`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "proappstore-mcp" } }
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

export async function pasApi(apiBase: string, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers });
  if (!res.ok) return { error: `API ${res.status}: ${await res.text()}` };
  return await res.json();
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
 * Verify a session token against the FAS API. Returns user info or null.
 */
export async function verifyToken(apiBase: string, token: string): Promise<{ id: string; login: string } | null> {
  const fasBase = apiBase.replace('proappstore', 'freeappstore');
  const res = await fetch(`${fasBase}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as { id: string; login: string };
}
