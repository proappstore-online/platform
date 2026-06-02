/**
 * App-ownership check (issue #5): verify the calling user owns the app before
 * letting build tools mutate its repo. Asks the PAS API for the user's apps.
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
    const data = (await res.json()) as { apps?: { id: string }[] };
    return (data.apps ?? []).some((a) => a.id === appId);
  } catch {
    return false;
  }
}
