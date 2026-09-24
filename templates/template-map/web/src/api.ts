import { initPro } from '@proappstore/sdk'

// platform-cookie is the current auth mode (PAS-AUTH-001).
export const app = initPro({ appId: 'APPNAME', authMode: 'platform-cookie' })

/**
 * Extension points. The map is the workspace; the record is a "place" with a
 * category — rename freely. Optional modules sit behind flags so removing one
 * leaves no dead dependency.
 */
export const RECORD = { noun: 'place', plural: 'places' } as const
/** Photos on records through app.storage. Off = no upload UI, no storage calls. */
export const STORAGE_ENABLED = true
/** Address → coordinates on the form through app.maps.geocode; off = coordinates only. */
export const GEOCODING_ENABLED = true
/** Roles that unlock the admin table (assigned with app.roles / the console). */
export const MANAGER_ROLES = ['admin', 'editor'] as const
/** Where the map opens before any records or location are known. */
export const DEFAULT_VIEW = { center: { lat: -37.81, lng: 144.96 }, zoom: 12 }

export type PlaceStatus = 'active' | 'hidden'
export interface Category { id: string; name: string; color: string; icon: string; sort_order: number }
export interface CategoryStat { id: string; name: string; active_count: number }
export interface Place {
  id: string; owner_id: string; owner_name: string; category_id: string | null; name: string; description: string; address: string
  lat: number; lng: number; status: PlaceStatus; image_key: string | null; created_at: number; updated_at: number
}
export type Filters = { category_id: string | null; q: string | null; south?: number | null; north?: number | null; west?: number | null; east?: number | null }

/** Query action → rows. Throws ActionError with the HTTP status so screens can tell 403 from a network failure. */
export async function q<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await call<{ rows: T[] }>(name, params)
  return res.rows
}
/** Execute action → rows changed (0 = refused by a guard). */
export async function x(name: string, params: Record<string, unknown> = {}): Promise<number> {
  const res = await call<{ meta: { changes: number } }>(name, params)
  return res.meta.changes
}
export async function batch(name: string, params: Record<string, unknown> = {}): Promise<number[]> {
  const res = await call<{ results: { meta: { changes: number } }[] }>(name, params)
  return res.results.map((r) => r.meta.changes)
}

export class ActionError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) { super(message); this.status = status }
  get denied() { return this.status === 403 }
  get offline() { return this.status === null }
}
async function call<T>(name: string, params: Record<string, unknown>): Promise<T> {
  try {
    return await app.actions.call<T>(name, params)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const m = /failed: (\d{3})/.exec(msg)
    throw new ActionError(msg, m ? Number(m[1]) : navigator.onLine ? 500 : null)
  }
}

export function imageUrl(key: string): string {
  return app.storage.publicUrl(key)
}
export async function uploadPhoto(file: File): Promise<string> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const res = await app.storage.uploadUserPublic(`${crypto.randomUUID()}-${safe}`, file, file.type)
  return res.key
}

export function when(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
export const fmtCoord = (n: number) => n.toFixed(5)
