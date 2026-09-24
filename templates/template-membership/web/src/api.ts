import { initPro } from '@proappstore/sdk'

// platform-cookie is the current auth mode (PAS-AUTH-001).
export const app = initPro({ appId: 'APPNAME', authMode: 'platform-cookie' })

/**
 * Extension points. The spine — groups, members with a role, consumable join codes, events
 * with RSVPs and a waitlist, a thread, an activity log — is generic; the vocabulary is yours.
 */
export const GROUP = { noun: 'group', plural: 'groups' } as const
export const ROLES = ['admin', 'moderator', 'member'] as const
/** Optional modules behind flags: a live thread on app.rooms instead of polling, group avatars on app.storage. */
export const ROOMS_THREAD = false
export const STORAGE_AVATARS = false
/** Thread polling interval when ROOMS_THREAD is off. */
export const THREAD_POLL_MS = 15_000

export type Role = (typeof ROLES)[number]
export type RsvpStatus = 'going' | 'waitlist' | 'not_going'

export interface Group { id: string; slug: string; name: string; description: string; avatar_url: string | null; created_by: string; created_at: number; updated_at: number; role: Role; member_count: number }
export interface Member { user_id: string; display_name: string; role: Role; joined_at: number; invited_by: string | null }
export interface JoinCode { id: string; code: string; role: Role; created_by: string; expires_at: number | null; used_at: number | null; used_by: string | null; max_uses: number; use_count: number }
export interface Event { id: string; group_id: string; title: string; description: string; location: string; starts_at: number; ends_at: number | null; capacity: number | null; created_by: string; created_at: number; updated_at: number; going_count: number; waitlist_count: number; my_status: RsvpStatus | null }
export interface Rsvp { user_id: string; display_name: string | null; status: RsvpStatus; waitlist_position: number | null; created_at: number }
export interface Message { id: string; user_id: string; display_name: string | null; content: string; created_at: number; updated_at: number }
export interface Activity { id: string; user_id: string; display_name: string | null; action: string; metadata: string; created_at: number }

/** Query action → rows. */
export async function q<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await app.actions.call<{ rows: T[] }>(name, params)
  return res.rows
}

/** Execute action → rows changed (0 = refused by a guard). */
export async function x(name: string, params: Record<string, unknown> = {}): Promise<number> {
  const res = await app.actions.call<{ meta: { changes: number } }>(name, params)
  return res.meta.changes
}

/** Batch action → rows changed per statement, in order. */
export async function batch(name: string, params: Record<string, unknown> = {}): Promise<number[]> {
  const res = await app.actions.call<{ results: { meta: { changes: number } }[] }>(name, params)
  return res.results.map((r) => r.meta.changes)
}

export const isMod = (g: Group | null) => !!g && (g.role === 'admin' || g.role === 'moderator')

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'group'
}

export function when(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
}

export function toLocalInput(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
