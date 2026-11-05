import type { Env } from '../types.js';
import { GOOGLE_CALENDAR_SCOPES, GoogleCalendarError, hashState } from './google-calendar-common.js';

const GOOGLE_CAPABILITIES = ['calendar.read', 'meet.read'] as const;
export type GoogleCapability = typeof GOOGLE_CAPABILITIES[number];
export const GOOGLE_CONSENT_VERSION = 1;
export interface GoogleDisclosure {
  purpose: string; audience: string; retention: string; privacy_path: string; deletion_path: string;
}
export interface GooglePolicy {
  name: string; capabilities_json: string; disclosure_json: string | null; contract_hash: string;
}
export function googleCapabilities(value: unknown): GoogleCapability[] {
  if (!Array.isArray(value) || !value.length || value.length > 2 || new Set(value).size !== value.length
    || value.some(v => !GOOGLE_CAPABILITIES.includes(v)) || !value.includes('calendar.read')) {
    throw new GoogleCalendarError('invalid_google_capabilities');
  }
  return GOOGLE_CAPABILITIES.filter(v => value.includes(v));
}
export function googleDisclosure(value: unknown): GoogleDisclosure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleCalendarError('connector_disclosure_required');
  const source = value as Record<string, unknown>;
  const fields = ['purpose', 'audience', 'retention', 'privacy_path', 'deletion_path'];
  if (Object.keys(source).some(k => !fields.includes(k))) throw new GoogleCalendarError('invalid_connector_disclosure');
  const result: Record<string, string> = {};
  for (const field of fields) {
    const text = source[field];
    if (typeof text !== 'string' || text.trim().length < (field.endsWith('_path') ? 1 : 10)
      || text.length > 1000 || /[\x00-\x1f\x7f]/.test(text)) throw new GoogleCalendarError('invalid_connector_disclosure');
    if (field.endsWith('_path') && (!/^\/(?!\/)[^\\\s]{0,999}$/.test(text)
      || new URL(text, 'https://app.proappstore.online').origin !== 'https://app.proappstore.online')) throw new GoogleCalendarError('invalid_connector_disclosure');
    result[field] = text.trim();
  }
  return result as unknown as GoogleDisclosure;
}
export const googleScopes = (capabilities: GoogleCapability[]) => GOOGLE_CALENDAR_SCOPES.filter(s =>
  s !== 'https://www.googleapis.com/auth/meetings.space.readonly' || capabilities.includes('meet.read'));
export const googleContractHash = (name: string, capabilities: GoogleCapability[], disclosure: GoogleDisclosure) =>
  hashState(JSON.stringify({ version: GOOGLE_CONSENT_VERSION, name, capabilities, disclosure }));

export async function googlePolicy(env: Env, appId: string, name?: string): Promise<GooglePolicy> {
  const row = await env.DB.prepare(`SELECT name, capabilities_json, disclosure_json, contract_hash FROM app_connectors
    WHERE app_id = ? AND kind = 'google_calendar' AND (? IS NULL OR name = ?)`)
    .bind(appId, name ?? null, name ?? null).first<GooglePolicy>();
  if (!row) throw new GoogleCalendarError('connector_not_declared', 403);
  return row;
}
