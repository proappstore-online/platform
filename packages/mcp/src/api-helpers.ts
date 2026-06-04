/**
 * Helpers for talking to GitHub + the PAS platform API, plus connection-token
 * extraction/verification for the MCP transport.
 */

import { verifySession } from '@proappstore/build-core';

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
 * Verify a PAS session token locally (build-core/session-jwt) with the shared
 * SESSION_SIGNING_KEY. No network, no FAS.
 */
export async function verifyToken(signingKey: string, token: string): Promise<{ id: string; login: string } | null> {
  const claims = await verifySession(token, signingKey);
  if (!claims) return null;
  return { id: claims.sub, login: claims.login };
}
