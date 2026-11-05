import type { Env } from '../types.js';
import type { CallerIdentity } from './app-worker-calls.js';
import { accountStatus, beginGoogleOAuth, completeGoogleOAuth, disconnectGoogleAccount, disconnectGoogleApp, requireAppAuthorization } from './google-calendar-accounts.js';
import { createCalendarGrant, listAccountCalendars, readCalendarGrant, revokeCalendarGrant } from './google-calendar-data.js';
import { GoogleCalendarError } from './google-calendar-common.js';

/** Called only after the existing worker authentication, caller-grant and invocation-budget checks. */
export async function workerGoogleCalendar(env: Env, appId: string, name: unknown, input: unknown, caller: CallerIdentity | null): Promise<Record<string, unknown>> {
  try {
    if (typeof name !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) throw new GoogleCalendarError('invalid_input');
    const declared = await env.DB.prepare("SELECT 1 AS declared FROM app_connectors WHERE app_id = ? AND name = ? AND kind = 'google_calendar'").bind(appId, name).first();
    if (!declared) throw new GoogleCalendarError('connector_not_declared', 403);
    const request = input as Record<string, unknown>;
    if (['status', 'start', 'complete', 'calendars', 'grant', 'disconnect_account', 'disconnect_app'].includes(String(request.operation))) {
      if (!caller) throw new GoogleCalendarError('user_required', 403);
      const authorizedVersion = ['calendars', 'grant', 'disconnect_account', 'disconnect_app'].includes(String(request.operation))
        ? await requireAppAuthorization(env, appId, caller.id) : undefined;
      switch (request.operation) {
        case 'status': return await accountStatus(env, appId, caller.id);
        case 'start': return await beginGoogleOAuth(env, appId, caller.id, request.callback_path, request.return_to, request.capabilities);
        case 'complete': return await completeGoogleOAuth(env, appId, caller.id, request.state, request.code);
        case 'calendars': return await listAccountCalendars(env, appId, caller.id, request.page_token, authorizedVersion!);
        case 'grant': return await createCalendarGrant(env, appId, caller.id, request.calendar_id, authorizedVersion!);
        case 'disconnect_account': return await disconnectGoogleAccount(env, caller.id, request.expected_version);
        case 'disconnect_app': return await disconnectGoogleApp(env, appId, caller.id, request.expected_version);
      }
    }
    if (request.operation === 'revoke_grant') return await revokeCalendarGrant(env, appId, request.grant_id);
    return await readCalendarGrant(env, appId, request);
  } catch (error) {
    if (error instanceof GoogleCalendarError) return { error: error.code, status: error.status };
    // Neither DB faults nor provider responses may expose credentials to an app.
    return { error: 'calendar_service_failed', status: 500 };
  }
}
