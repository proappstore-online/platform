import type { GitHub } from '@proappstore/build-core';
import { checkRoute } from './directory-tools.js';

/** Read-only diagnostics, separate from the immutable provisioning receipt. */
export async function readCurrentDeployment(gh: Pick<GitHub, 'getDeployStatus'>, host: Fetcher, appId: string): Promise<string> {
  const appUrl = `https://${appId}.proappstore.online`;
  const checkedAt = new Date().toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>(resolve => {
    timer = setTimeout(() => resolve('GitHub Actions: unavailable (timed out)'), 5000);
  });
  const workflows = (async () => {
    try {
      const result = await gh.getDeployStatus(appId, 5);
      if (!result?.ok) return `GitHub Actions: unavailable${result?.status ? ` (HTTP ${result.status})` : ''}`;
      const runs = (result.data as { workflow_runs?: { name: string; conclusion: string | null; status: string; updated_at: string }[] } | null)?.workflow_runs;
      if (!Array.isArray(runs)) return 'GitHub Actions: unavailable (invalid response)';
      if (!runs.length) return 'No workflow runs found; the first deployment may not have started.';
      return runs.map(run => `${run.conclusion === 'success' ? '+' : run.conclusion === 'failure' ? '!' : '~'} ${run.name}: ${run.conclusion ?? run.status} (${run.updated_at})`).join('\n');
    } catch {
      return 'GitHub Actions: unavailable';
    }
  })();
  try {
    const [deployment, health] = await Promise.all([Promise.race([workflows, deadline]), checkRoute(host, appUrl)]);
    return `Current deployment and route health (checked ${checkedAt}):\n${deployment}\nCurrent route health: ${health} (${appUrl})`;
  } finally {
    clearTimeout(timer);
  }
}
