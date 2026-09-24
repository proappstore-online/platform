import { initPro } from '@proappstore/sdk'

// platform-cookie is the current auth mode (PAS-AUTH-001): the host sets the session
// cookie and data calls go through /.pas/data on the app's own origin.
export const app = initPro({ appId: 'APPNAME', authMode: 'platform-cookie' })

/**
 * Extension points. The archetype is "owners publish listings, seekers request them";
 * the noun each side uses is yours to pick (booking, application, enquiry, match…).
 */
export const REQUEST = { noun: 'request', plural: 'requests', verb: 'Request' } as const
export const CATEGORIES = ['room', 'job', 'service', 'vehicle', 'other'] as const
/** Optional map capability: geocode a listing's location on save and show it on the detail page. */
export const MAPS_ENABLED = false

export type ListingStatus = 'active' | 'paused' | 'archived'
export type RequestStatus = 'pending' | 'accepted' | 'declined' | 'completed' | 'cancelled'

export interface Listing {
  id: string
  owner_id: string
  owner_name: string
  status: ListingStatus
  title: string
  description: string
  category: string
  location: string
  lat: number | null
  lng: number | null
  price: number | null
  price_unit: string
  /** JSON array of public storage keys (see uploadPhoto). */
  images: string
  created_at: number
  updated_at: number
}

export interface Request {
  id: string
  listing_id: string
  requester_id: string
  requester_name?: string
  status: RequestStatus
  note: string
  created_at: number
  updated_at: number
  listing_title: string
  owner_id?: string
  owner_name?: string
}

export interface Message {
  id: string
  listing_id: string
  sender_id: string
  sender_name: string
  recipient_id: string
  body: string
  created_at: number
}

export interface Conversation {
  listing_id: string
  listing_title: string
  other_id: string
  other_name: string
  last_at: number
}

export interface Review {
  id: string
  listing_id: string
  author_name: string
  rating: number
  comment: string
  created_at: number
}

/** Call a public query action (no session; PAS-DATA-011 tools only). */
export async function pub<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await app.actions.callPublic<{ rows: T[] }>(name, params)
  return res.rows
}

/** Call an authenticated query action; resolves to the rows. */
export async function q<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await app.actions.call<{ rows: T[] }>(name, params)
  return res.rows
}

/** Call an execute action; resolves to the number of rows changed (0 = refused by a guard). */
export async function x(name: string, params: Record<string, unknown> = {}): Promise<number> {
  const res = await app.actions.call<{ meta: { changes: number } }>(name, params)
  return res.meta.changes
}

export function images(listing: Pick<Listing, 'images'>): string[] {
  try {
    const parsed: unknown = JSON.parse(listing.images)
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

export function imageUrl(key: string): string {
  return app.storage.publicUrl(key)
}

/** Any signed-in user may upload listing photos under their own public prefix. */
export async function uploadPhoto(file: File): Promise<string> {
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const res = await app.storage.uploadUserPublic(`${crypto.randomUUID()}-${safe}`, file, file.type)
  return res.key
}

export function money(l: Pick<Listing, 'price' | 'price_unit'>): string {
  if (l.price === null || l.price === undefined) return ''
  const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(l.price)
  return l.price_unit ? `${amount} / ${l.price_unit}` : amount
}

export function when(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
