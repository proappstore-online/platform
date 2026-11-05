import type { Env } from '../../types.js';
import { githubSource } from './github.js';
import { runContributionTick } from './ingest.js';

/** Scheduled boundary: report disabled ingestion without exposing credentials or contributor data. */
export async function scheduleContributions(env: Pick<Env, 'DB' | 'GITHUB_TOKEN'>, now: number): Promise<void> {
  const result = await runContributionTick(env.DB, env.GITHUB_TOKEN ? githubSource(env.GITHUB_TOKEN) : null, now);
  if (result === 'unconfigured') console.warn('[contributions] tick unconfigured: GITHUB_TOKEN is not configured');
}
