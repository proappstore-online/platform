/**
 * Listed apps go live (#658). Serge, 2026-11-23: an app listed in the public store
 * goes live automatically — its staged actions are switched on. An unlisted app stays
 * staged until its owner promotes it (#428).
 *
 * On the fifteen-minute cron tick this reads the public catalogue.json and, for each
 * listed app that exists and has no app_go_live row, does what the owner's promote does
 * (`promoteStaged`), recorded as went_live_by = 'catalogue'. Once recorded, the app is
 * skipped on every later tick, and stagedStates registers its later deploys live.
 * It never demotes, and an unreadable or empty catalogue changes nothing.
 */

import type { Env } from '../types.js';
import { promoteStaged } from '../routes/tools.js';
import { CATALOGUE_URL } from './host-probe.js';

const TIMEOUT_MS = 10_000;

/** The listed app ids, or none when the catalogue cannot be read. */
async function listedIds(fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(CATALOGUE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = (await res.json()) as { apps?: unknown };
    return (Array.isArray(data.apps) ? data.apps : [])
      .map((a: { id?: unknown } | null) => a?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/** Promotes every listed app not yet live; returns the ids that went live on this tick. */
export async function goLiveListedApps(opts: { env: Env; fetchImpl?: typeof fetch }): Promise<string[]> {
  const ids = await listedIds(opts.fetchImpl ?? fetch);
  if (!ids.length) return [];
  const pending = await opts.env.DB.prepare(
    'SELECT id FROM apps WHERE id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT app_id FROM app_go_live) ORDER BY id',
  ).bind(JSON.stringify(ids)).all<{ id: string }>();
  const wentLive: string[] = [];
  for (const { id } of pending.results ?? []) {
    const promoted = await promoteStaged(opts.env.DB, id, 'catalogue');
    console.log(`[catalogue-go-live] app=${id} promoted=${promoted.join(',') || '(none)'}`);
    wentLive.push(id);
  }
  return wentLive;
}
