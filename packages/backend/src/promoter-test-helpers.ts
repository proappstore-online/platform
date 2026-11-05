import { attestReferralReadiness } from './lib/promoters/readiness.js';

/** Ready deployment fixture for suites about enrollment/attribution, not readiness. */
export async function seedReferralReady(db: D1Database, ...appIds: string[]) {
  for (const appId of appIds) {
    const repository = `proappstore-online/${appId}`;
    const row = await db.prepare(`INSERT INTO deploy_audit (app_id, repository, ref, sha, prefix, minted_at)
      VALUES (?, ?, 'refs/heads/main', 'fixture-sha', ?, 1) RETURNING id`)
      .bind(appId, repository, `apps/${appId}/`).first<{ id: number }>();
    await attestReferralReadiness(db, appId, repository, 'fixture-sha', {
      protocol_version: 1, deploy_id: row!.id, sdk_version: '1.16.104', auth_mode: 'platform-cookie', synthetic_verified: true,
    });
  }
}
