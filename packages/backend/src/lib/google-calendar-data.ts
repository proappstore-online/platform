import type { Env } from '../types.js';
import { account, accountToken, assertAppAuthorization, type AppGoogleAuthorization } from './google-calendar-accounts.js';
import type { GoogleCapability } from './google-calendar-policy.js';
import { calendarId, GoogleCalendarError, googleJson, resourceReceipt, textInput, verifyResourceReceipt } from './google-calendar-common.js';

interface Grant { id: string; app_id: string; user_id: string; account_version: number; authorization_version: number; calendar_id: string; calendar_name: string; email: string; capabilities_json: string; declared_capabilities_json: string }
const eventId = (value: unknown) => textInput(value, /^[A-Za-z0-9_-]{1,1024}$/);
const pageToken = (value: unknown) => value === undefined || value === '' ? '' : textInput(value, /^[A-Za-z0-9._~+/=-]{1,2048}$/);
const EVENT_FIELDS = 'id,summary,status,recurringEventId,start,end,hangoutLink,conferenceData(entryPoints(entryPointType,uri))';
async function get(token: string, base: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(path, base); url.search = new URLSearchParams(params).toString();
  return googleJson(url, { headers: { Authorization: `Bearer ${token}` } });
}
const calendarGet = (token: string, path: string, params: Record<string, string> = {}) => get(token, 'https://www.googleapis.com/calendar/v3/', path, params);

export async function listAccountCalendars(env: Env, appId: string, userId: string, page: unknown, authorization: AppGoogleAuthorization) {
  const token = await accountToken(env, userId, authorization.account_version);
  await assertAppAuthorization(env, appId, userId, authorization);
  const data = await calendarGet(token, 'users/me/calendarList', { maxResults: '100', fields: 'items(id,summary,primary,accessRole),nextPageToken', pageToken: pageToken(page) });
  await assertAppAuthorization(env, appId, userId, authorization);
  return { calendars: (data.items ?? []).filter((c: any) => ['reader', 'writer', 'owner'].includes(c.accessRole)).map((c: any) => ({ id: c.id, name: c.summary ?? c.id, primary: !!c.primary })), next_page_token: data.nextPageToken ?? null };
}
export async function createCalendarGrant(env: Env, appId: string, userId: string, selectedCalendar: unknown, authorization: AppGoogleAuthorization) {
  const id = calendarId(selectedCalendar), row = await account(env, userId);
  if (!row || row.status !== 'connected' || row.version !== authorization.account_version) throw new GoogleCalendarError('reconnect_required', 409);
  const token = await accountToken(env, userId, row.version);
  await assertAppAuthorization(env, appId, userId, authorization);
  const data = await calendarGet(token, `users/me/calendarList/${encodeURIComponent(id)}`, { fields: 'id,summary,accessRole' });
  if (data.id !== id || !['reader', 'writer', 'owner'].includes(data.accessRole)) throw new GoogleCalendarError('google_forbidden', 403);
  const grantId = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO google_calendar_grants (id, app_id, user_id, account_version, calendar_id, calendar_name, created_at, authorization_version)
    SELECT ?, ?, a.user_id, a.version, ?, ?, ?, ? FROM google_calendar_accounts a WHERE a.user_id = ? AND a.version = ? AND a.status = 'connected'
    AND EXISTS (SELECT 1 FROM google_calendar_app_authorizations auth JOIN app_connectors k ON k.app_id = auth.app_id AND k.kind = 'google_calendar' AND k.contract_hash = auth.contract_hash
      WHERE auth.app_id = ? AND auth.user_id = a.user_id AND auth.account_version = a.version AND auth.authorization_version = ?)
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = a.user_id)`)
    .bind(grantId, appId, id, String(data.summary ?? id).slice(0, 500), Date.now(), authorization.authorization_version, userId, row.version, appId, authorization.authorization_version, appId).run();
  if (!result.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { grant_id: grantId, calendar_id: id, calendar_name: String(data.summary ?? id).slice(0, 500), account_email: row.email, user_id: userId };
}
async function activeGrant(env: Env, appId: string, grantId: unknown, capability: GoogleCapability = 'calendar.read'): Promise<Grant> {
  const id = textInput(grantId, /^[A-Za-z0-9-]{36}$/);
  const row = await env.DB.prepare(`SELECT g.*, a.email, auth.capabilities_json, k.capabilities_json AS declared_capabilities_json FROM google_calendar_grants g JOIN google_calendar_accounts a ON a.user_id = g.user_id
    JOIN google_calendar_app_authorizations auth ON auth.app_id = g.app_id AND auth.user_id = g.user_id AND auth.account_version = g.account_version AND auth.authorization_version = g.authorization_version
    JOIN app_connectors k ON k.app_id = g.app_id AND k.kind = 'google_calendar' AND k.contract_hash = auth.contract_hash
    JOIN apps app ON app.id = g.app_id WHERE g.id = ? AND g.app_id = ? AND g.revoked_at IS NULL AND a.status = 'connected' AND g.account_version = a.version
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = g.app_id AND d.user_id = g.user_id)`)
    .bind(id, appId).first<Grant>();
  if (!row) throw new GoogleCalendarError('reconnect_required', 409);
  if (!(JSON.parse(row.capabilities_json) as string[]).includes(capability) || !(JSON.parse(row.declared_capabilities_json) as string[]).includes(capability)) throw new GoogleCalendarError('capability_not_granted', 403);
  return row;
}
export async function revokeCalendarGrant(env: Env, appId: string, grantId: unknown) {
  const id = textInput(grantId, /^[A-Za-z0-9-]{36}$/);
  const result = await env.DB.prepare('UPDATE google_calendar_grants SET revoked_at = ? WHERE id = ? AND app_id = ? AND revoked_at IS NULL').bind(Date.now(), id, appId).run();
  return { revoked: Boolean(result.meta.changes) };
}
function list(data: Record<string, any>, field: string): any[] {
  if (data[field] !== undefined && !Array.isArray(data[field])) throw new GoogleCalendarError('google_invalid_response', 502);
  return data[field] ?? [];
}
function eventTiming(data: Record<string, any>) {
  const starts = Date.parse(data.start?.dateTime ?? ''), ends = Date.parse(data.end?.dateTime ?? '');
  const links = [data.hangoutLink, ...(data.conferenceData?.entryPoints ?? []).filter((p: any) => p.entryPointType === 'video').map((p: any) => p.uri)];
  const code = links.map((v: unknown) => typeof v === 'string' ? /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[?#].*)?$/.exec(v)?.[1] : null).find(Boolean);
  if (data.status === 'cancelled' || !code || !Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts || ends - starts > 86_400_000) throw new GoogleCalendarError('meeting_unavailable', 409);
  return { starts, ends, code };
}

/** Each read rechecks the grant. Meet child resources need a receipt from the preceding scoped read. */
export async function readCalendarGrant(env: Env, appId: string, input: Record<string, unknown>) {
  const capability = ['conferences', 'participants', 'sessions'].includes(String(input.operation)) ? 'meet.read' : 'calendar.read';
  const grant = await activeGrant(env, appId, input.grant_id, capability);
  if (input.operation === 'grant_status') return { grant_id: grant.id, calendar_id: grant.calendar_id, calendar_name: grant.calendar_name, account_email: grant.email, user_id: grant.user_id };
  const token = await accountToken(env, grant.user_id, grant.account_version);
  const result = await readGrantedData(env, appId, input, grant, token, capability);
  // A provider request cannot be recalled, but its response must not be
  // delivered after deletion/revocation won during the network round trip.
  await activeGrant(env, appId, grant.id, capability);
  return result;
}

async function readGrantedData(env: Env, appId: string, input: Record<string, unknown>, grant: Grant, token: string, capability: GoogleCapability) {
  const calendarRead = async (path: string, params: Record<string, string> = {}) => {
    await activeGrant(env, appId, grant.id, capability);
    return calendarGet(token, path, params);
  };
  const prefix = `calendars/${encodeURIComponent(grant.calendar_id)}/events`;
  if (input.operation === 'instances') {
    const starts = input.starts_at, ends = input.ends_at, now = Date.now();
    if (typeof starts !== 'number' || typeof ends !== 'number' || !Number.isSafeInteger(starts) || !Number.isSafeInteger(ends)
      || starts < now - 28 * 86_400_000 || ends > now + 30 * 86_400_000 || ends <= starts || ends - starts > 31 * 86_400_000) throw new GoogleCalendarError('invalid_meeting_window');
    const data = await calendarRead(`${prefix}/${encodeURIComponent(eventId(input.event_id))}/instances`, {
      maxResults: '100', showDeleted: 'true', timeMin: new Date(starts).toISOString(), timeMax: new Date(ends).toISOString(),
      fields: `items(${EVENT_FIELDS}),nextPageToken`, pageToken: pageToken(input.page_token),
    });
    return { items: list(data, 'items'), nextPageToken: data.nextPageToken ?? null };
  }
  if (input.operation === 'events') {
    const now = Date.now();
    const data = await calendarRead(prefix, { singleEvents: 'true', orderBy: 'startTime', maxResults: '100', timeMin: new Date(now - 7 * 86_400_000).toISOString(), timeMax: new Date(now + 30 * 86_400_000).toISOString(), fields: `items(${EVENT_FIELDS}),nextPageToken`, pageToken: pageToken(input.page_token) });
    return { items: list(data, 'items'), nextPageToken: data.nextPageToken ?? null };
  }
  if (input.operation === 'event') return calendarRead(`${prefix}/${encodeURIComponent(eventId(input.event_id))}`, { fields: EVENT_FIELDS });
  let path: string, field: string, fields: string, parent = '';
  const params: Record<string, string> = { pageSize: '100', pageToken: pageToken(input.page_token) };
  if (input.operation === 'conferences') {
    const event = await calendarRead(`${prefix}/${encodeURIComponent(eventId(input.event_id))}`, { fields: EVENT_FIELDS });
    const timing = eventTiming(event);
    if (input.starts_at !== timing.starts || input.ends_at !== timing.ends || input.meeting_code !== timing.code) throw new GoogleCalendarError('meeting_changed', 409);
    if (timing.ends > Date.now() || timing.starts < Date.now() - 28 * 86_400_000) throw new GoogleCalendarError('invalid_meeting_window');
    path = 'conferenceRecords'; field = 'conferenceRecords'; fields = 'conferenceRecords(name,startTime,endTime),nextPageToken';
    params.filter = `space.meeting_code = "${timing.code}" AND start_time < "${new Date(timing.ends).toISOString()}" AND end_time > "${new Date(timing.starts).toISOString()}"`;
  } else if (input.operation === 'participants') {
    parent = textInput(input.resource, /^conferenceRecords\/[A-Za-z0-9_-]{1,256}$/);
    await verifyResourceReceipt(env, input.receipt, grant.id, parent);
    path = `${parent}/participants`; field = 'participants'; fields = 'participants(name,signedinUser(user,displayName),anonymousUser(displayName),phoneUser(displayName),earliestStartTime,latestEndTime),nextPageToken';
  } else if (input.operation === 'sessions') {
    parent = textInput(input.resource, /^conferenceRecords\/[A-Za-z0-9_-]{1,256}\/participants\/[A-Za-z0-9_-]{1,256}$/);
    await verifyResourceReceipt(env, input.receipt, grant.id, parent);
    path = `${parent}/participantSessions`; field = 'participantSessions'; fields = 'participantSessions(name,startTime,endTime),nextPageToken';
  } else throw new GoogleCalendarError('unknown_operation');
  await activeGrant(env, appId, grant.id, capability);
  const data = await get(token, 'https://meet.googleapis.com/v2/', path, { ...params, fields });
  const items = await Promise.all(list(data, field).map(async item => {
    const pattern = field === 'conferenceRecords' ? /^conferenceRecords\/[A-Za-z0-9_-]{1,256}$/ : field === 'participants' ? /^conferenceRecords\/[A-Za-z0-9_-]{1,256}\/participants\/[A-Za-z0-9_-]{1,256}$/ : /^conferenceRecords\/[A-Za-z0-9_-]{1,256}\/participants\/[A-Za-z0-9_-]{1,256}\/participantSessions\/[A-Za-z0-9_-]{1,256}$/;
    const name = textInput(item.name, pattern, 'google_invalid_response');
    if (parent && !name.startsWith(`${parent}/`)) throw new GoogleCalendarError('google_invalid_response', 502);
    if (field === 'participants') return {
      name, earliestStartTime: item.earliestStartTime, latestEndTime: item.latestEndTime,
      ...(item.signedinUser ? { signedinUser: { user: item.signedinUser.user, displayName: String(item.signedinUser.displayName ?? '').slice(0, 500) } } : {}),
      ...(item.anonymousUser ? { anonymousUser: { displayName: String(item.anonymousUser.displayName ?? '').slice(0, 500) } } : {}),
      ...(item.phoneUser ? { phoneUser: { displayName: String(item.phoneUser.displayName ?? '').slice(0, 500) } } : {}),
      receipt: await resourceReceipt(env, grant.id, name),
    };
    return { name, startTime: item.startTime, endTime: item.endTime, ...(field === 'conferenceRecords' ? { receipt: await resourceReceipt(env, grant.id, name) } : {}) };
  }));
  return { [field]: items, nextPageToken: data.nextPageToken ?? null };
}
