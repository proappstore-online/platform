/**
 * App-ownership check (issue #5): verify the calling user OWNS the app before
 * letting build tools mutate its repo. Asks the PAS API for the user's apps.
 *
 * SECURITY: `/v1/apps` returns every app the caller is a team *member* of, at
 * ANY role, so membership alone is NOT ownership — a read-only `viewer` on an
 * app must not pass this gate and mutate the repo / deploy over MCP. Require the
 * effective team role to be `owner` (the creator resolves to `owner`). Same
 * team-role-vs-membership fix as the data-worker (#78) and agent-teams (#79);
 * `/v1/apps` now returns `team_role` per app for exactly this.
 */
export async function verifyAppOwnership(
  apiBase: string,
  userToken: string,
  appId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/v1/apps`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { apps?: { id: string; team_role?: string }[] };
    const app = (data.apps ?? []).find((a) => a.id === appId);
    return app?.team_role === 'owner';
  } catch {
    return false;
  }
}
