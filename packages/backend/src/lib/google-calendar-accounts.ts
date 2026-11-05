import type { Env } from '../types.js';
import { GoogleCalendarError, googleConfigured } from './google-calendar-common.js';
import { googleCapabilities, type GoogleCapability } from './google-calendar-policy.js';

export interface AppGoogleAuthorization {
  account_version: number; authorization_version: number; capabilities_json: string; contract_hash: string;
  consent_version: number; consented_at: number | null;
}
async function appAuthorization(env: Env, appId: string, userId: string) {
  return env.DB.prepare(`SELECT auth.*, a.email FROM google_calendar_app_authorizations auth
    JOIN google_calendar_accounts a ON a.user_id = auth.user_id AND a.version = auth.account_version AND a.status = 'connected'
    JOIN app_connectors k ON k.app_id = auth.app_id AND k.kind = 'google_calendar' AND k.contract_hash = auth.contract_hash
    WHERE auth.app_id = ? AND auth.user_id = ?
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = auth.app_id AND d.user_id = auth.user_id)`)
    .bind(appId, userId).first<AppGoogleAuthorization & { email: string | null }>();
}
const authorizedApps = async (env: Env, userId: string) => Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM google_calendar_app_authorizations WHERE user_id = ?').bind(userId).first<{ n: number }>())?.n ?? 0);
export async function accountStatus(env: Env, appId: string, userId: string) {
  const auth = await appAuthorization(env, appId, userId);
  // A count, never other apps' identities: enough for this app to warn before a global disconnect.
  return { configured: googleConfigured(env), connected: !!auth, email: auth?.email ?? null, version: auth?.account_version ?? 0,
    authorized_apps: auth ? await authorizedApps(env, userId) : 0,
    authorization_version: auth?.authorization_version ?? 0, capabilities: auth ? JSON.parse(auth.capabilities_json) as GoogleCapability[] : [],
    consent_version: auth?.consent_version ?? 0, consented_at: auth?.consented_at ?? null };
}
export async function requireAppAuthorization(env: Env, appId: string, userId: string, capability: GoogleCapability = 'calendar.read') {
  const auth = await appAuthorization(env, appId, userId);
  if (!auth) throw new GoogleCalendarError('reconnect_required', 409);
  if (!googleCapabilities(JSON.parse(auth.capabilities_json)).includes(capability)) throw new GoogleCalendarError('capability_not_granted', 403);
  return auth;
}
export async function assertAppAuthorization(env: Env, appId: string, userId: string, expected: AppGoogleAuthorization) {
  const current = await requireAppAuthorization(env, appId, userId);
  if (current.account_version !== expected.account_version || current.authorization_version !== expected.authorization_version) throw new GoogleCalendarError('connection_changed', 409);
}
export async function disconnectGoogleApp(env: Env, appId: string, userId: string, expectedVersion: unknown) {
  if (!Number.isSafeInteger(expectedVersion)) throw new GoogleCalendarError('invalid_version');
  const result = await env.DB.prepare('DELETE FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ? AND authorization_version = ?').bind(appId, userId, expectedVersion).run();
  if (!result.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { disconnected: true };
}
/**
 * Disconnect the shared Google account for every app. `guard` makes the cross-app effect explicit:
 * `acknowledgedApps` must equal the app authorizations that will end, and the same count is
 * re-checked inside the UPDATE, so an app connected after the warning was shown fails closed.
 * `appId` is the calling app; if it is the only authorization there is nothing else to warn about.
 * No guard is only for the PAS-owned consent page, which carries its own explicit confirmation.
 */
export async function disconnectGoogleAccount(env: Env, userId: string, expectedVersion: unknown, guard?: { appId?: string; acknowledgedApps: unknown }) {
  if (!Number.isSafeInteger(expectedVersion)) throw new GoogleCalendarError('invalid_version');
  const affected = guard ? await authorizedApps(env, userId) : 0;
  if (guard) {
    const own = guard.appId && await env.DB.prepare('SELECT 1 AS own FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ?').bind(guard.appId, userId).first() ? 1 : 0;
    if (affected > own && guard.acknowledgedApps !== affected) throw new GoogleCalendarError('cross_app_acknowledgement_required', 409);
  }
  const changed = await env.DB.prepare(`UPDATE google_calendar_accounts SET version = version + 1, status = 'disconnected', google_subject = NULL, email = NULL, credential_ct = NULL, credential_dek = NULL, credential_iv = NULL, scopes_json = '[]', credential_revision = credential_revision + 1, updated_at = ? WHERE user_id = ? AND version = ?${guard ? ' AND (SELECT COUNT(*) FROM google_calendar_app_authorizations WHERE user_id = ?) = ?' : ''}`)
    .bind(...[Date.now(), userId, expectedVersion, ...(guard ? [userId, affected] : [])]).run();
  if (!changed.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { disconnected: true };
}

interface GoogleConnectionApp {
  app_id: string; name: string; capabilities: GoogleCapability[]; authorization_version: number;
  consent_version: number; consented_at: number | null; legacy: boolean;
}
/** What the signed-in user has connected: the shared account and each app that can use it, so one can be revoked alone. */
export async function listGoogleConnections(env: Env, userId: string) {
  const shared = await env.DB.prepare("SELECT status, email, version FROM google_calendar_accounts WHERE user_id = ? AND status = 'connected'").bind(userId).first<{ status: string; email: string | null; version: number }>();
  if (!shared) return { configured: googleConfigured(env), account: null, apps: [] as GoogleConnectionApp[] };
  const rows = await env.DB.prepare(`SELECT auth.app_id, auth.capabilities_json, auth.authorization_version, auth.consent_version, auth.consented_at,
      COALESCE((SELECT name FROM submissions WHERE app_id = auth.app_id ORDER BY created_at DESC LIMIT 1), auth.app_id) AS name
    FROM google_calendar_app_authorizations auth
    JOIN app_connectors k ON k.app_id = auth.app_id AND k.kind = 'google_calendar' AND k.contract_hash = auth.contract_hash
    WHERE auth.user_id = ? AND auth.account_version = ?
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = auth.app_id AND d.user_id = auth.user_id)
    ORDER BY auth.app_id`).bind(userId, shared.version).all<{ app_id: string; capabilities_json: string; authorization_version: number; consent_version: number; consented_at: number | null; name: string }>();
  const apps = (rows.results ?? []).map(r => ({ app_id: r.app_id, name: r.name, capabilities: googleCapabilities(JSON.parse(r.capabilities_json)), authorization_version: r.authorization_version,
    consent_version: r.consent_version, consented_at: r.consented_at, legacy: r.consent_version === 0 }));
  return { configured: googleConfigured(env), account: { email: shared.email, version: shared.version }, apps };
}
