import { HttpError } from '../auth.js';

// First SDK release with cookie-auth referral claiming (#553).
const supportedSdk = (version: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number) as [number, number, number];
  return major > 1 || (major === 1 && (minor > 16 || (minor === 16 && patch >= 104)));
};

/** Shared by discovery and the atomic enrollment writes. A token mint alone never qualifies. */
export const READY_SQL = `EXISTS (SELECT 1 FROM app_referral_readiness r
  WHERE r.app_id = a.id AND r.verified = 1
    AND r.deploy_id = (SELECT MAX(d.id) FROM deploy_audit d WHERE d.app_id = a.id))`;

export async function referralReadiness(db: D1Database, appId: string) {
  const row = await db.prepare(`SELECT r.sdk_version, r.auth_mode, r.verified FROM app_referral_readiness r
    WHERE r.app_id = ?1 AND r.deploy_id = (SELECT MAX(id) FROM deploy_audit WHERE app_id = ?1)`)
    .bind(appId).first<{ sdk_version: string; auth_mode: string; verified: number }>();
  const reason = !row ? 'deployment_unverified' : row.auth_mode !== 'platform-cookie' ? 'legacy_auth'
    : !supportedSdk(row.sdk_version) ? 'sdk_unsupported' : !row.verified ? 'synthetic_check_required' : null;
  return { ready: reason === null, reason, protocol_version: 1 };
}

/**
 * Attestation from the app's authorized main-branch deploy workflow, AFTER upload
 * and synthetic verification. This is a trusted deployment contract, not browser
 * telemetry or an inference from a bundle, visibility or an issued session.
 */
export async function attestReferralReadiness(db: D1Database, appId: string, repository: string, sha: string | undefined, body: unknown) {
  const b = body as Record<string, unknown> | null;
  if (!b || b.protocol_version !== 1 || !Number.isSafeInteger(b.deploy_id) || typeof b.sdk_version !== 'string'
    || b.sdk_version.length > 40 || !['platform-cookie', 'legacy-bearer'].includes(String(b.auth_mode))
    || typeof b.synthetic_verified !== 'boolean') throw new HttpError('invalid_readiness_attestation', 400);
  const verified = supportedSdk(b.sdk_version) && b.auth_mode === 'platform-cookie' && b.synthetic_verified;
  // The ID is returned by the credential mint's audit record. Compare again in
  // the write so a stale workflow cannot restore readiness after a newer mint.
  const result = await db.prepare(`INSERT INTO app_referral_readiness (app_id, deploy_id, sdk_version, auth_mode, verified, recorded_at)
    SELECT ?1, d.id, ?5, ?6, ?7, ?8 FROM deploy_audit d
    WHERE d.app_id = ?1 AND d.id = ?2 AND d.repository = ?3 AND d.sha = ?4
      AND d.id = (SELECT MAX(id) FROM deploy_audit WHERE app_id = ?1)
    ON CONFLICT(app_id) DO UPDATE SET deploy_id = excluded.deploy_id, sdk_version = excluded.sdk_version,
      auth_mode = excluded.auth_mode, verified = excluded.verified, recorded_at = excluded.recorded_at`)
    .bind(appId, b.deploy_id, repository, sha ?? null, b.sdk_version, b.auth_mode, verified ? 1 : 0, Date.now()).run();
  if (!result.meta?.changes) throw new HttpError('stale_or_unknown_deployment', 409);
  return referralReadiness(db, appId);
}
