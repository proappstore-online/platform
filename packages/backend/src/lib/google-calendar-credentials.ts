import type { Env } from '../types.js';
import { toUint8 } from './bytes.js';
import { openSecret, sealSecret } from './encryption.js';
import { GoogleCalendarError, googleJson, requireGoogleConfiguration } from './google-calendar-common.js';

interface Account {
  user_id: string; version: number; status: string; email: string | null; google_subject: string | null;
  credential_ct: unknown; credential_dek: unknown; credential_iv: unknown; credential_revision: number; scopes_json: string;
}
interface Credential { userId: string; subject: string; version: number; refreshToken: string; accessToken: string; expiresAt: number }
export const account = (env: Env, userId: string) => env.DB.prepare('SELECT * FROM google_calendar_accounts WHERE user_id = ?').bind(userId).first<Account>();
export async function sealCredential(env: Env, credential: Credential) { return sealSecret(JSON.stringify(credential), env.APP_SECRET_KEK!); }

/** Credentials remain platform-held. A refresh may never overwrite a newer consent. */
export async function accountToken(env: Env, userId: string, expectedVersion?: number, attempt = 0): Promise<string> {
  requireGoogleConfiguration(env);
  const row = await account(env, userId);
  if (!row || row.status !== 'connected' || (expectedVersion !== undefined && row.version !== expectedVersion)) throw new GoogleCalendarError('reconnect_required', 409);
  let credential: Credential;
  try {
    credential = JSON.parse(await openSecret({ keyCiphertext: toUint8(row.credential_ct), dekWrapped: toUint8(row.credential_dek), iv: toUint8(row.credential_iv) }, env.APP_SECRET_KEK!));
    if (credential.userId !== userId || credential.subject !== row.google_subject || credential.version !== row.version || !credential.refreshToken) throw new Error();
  } catch { throw new GoogleCalendarError('reconnect_required', 409); }
  if (credential.expiresAt > Date.now() + 60_000 && credential.accessToken) return credential.accessToken;
  const token = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
  });
  if (typeof token.access_token !== 'string' || !token.access_token) throw new GoogleCalendarError('google_invalid_response', 502);
  if (typeof token.scope === 'string' && !(JSON.parse(row.scopes_json) as string[]).every(s => token.scope.split(' ').includes(s))) throw new GoogleCalendarError('missing_google_permissions');
  credential.accessToken = token.access_token;
  credential.expiresAt = Date.now() + Math.min(Number(token.expires_in) || 0, 3600) * 1000;
  const sealed = await sealCredential(env, credential);
  const saved = await env.DB.prepare("UPDATE google_calendar_accounts SET credential_ct = ?, credential_dek = ?, credential_iv = ?, credential_revision = credential_revision + 1 WHERE user_id = ? AND version = ? AND credential_revision = ? AND status = 'connected'")
    .bind(sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, userId, row.version, row.credential_revision).run();
  if (!saved.meta.changes) {
    if (!attempt) return accountToken(env, userId, row.version, 1);
    throw new GoogleCalendarError('connection_changed', 409);
  }
  return credential.accessToken;
}
