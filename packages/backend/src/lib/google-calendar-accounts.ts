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
export async function accountStatus(env: Env, appId: string, userId: string) {
  const auth = await appAuthorization(env, appId, userId);
  return { configured: googleConfigured(env), connected: !!auth, email: auth?.email ?? null, version: auth?.account_version ?? 0,
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
export async function disconnectGoogleAccount(env: Env, userId: string, expectedVersion: unknown) {
  if (!Number.isSafeInteger(expectedVersion)) throw new GoogleCalendarError('invalid_version');
  const changed = await env.DB.prepare("UPDATE google_calendar_accounts SET version = version + 1, status = 'disconnected', google_subject = NULL, email = NULL, credential_ct = NULL, credential_dek = NULL, credential_iv = NULL, scopes_json = '[]', credential_revision = credential_revision + 1, updated_at = ? WHERE user_id = ? AND version = ?")
    .bind(Date.now(), userId, expectedVersion).run();
  if (!changed.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { disconnected: true };
}
