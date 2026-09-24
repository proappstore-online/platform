import { useCallback, useEffect, useState } from 'react'
import { app, q, ActionError, MANAGER_ROLES, type Category, type Filters, type Place } from './api'

/** navigator.onLine plus the online/offline events — the offline state everywhere. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    addEventListener('online', on); addEventListener('offline', off)
    return () => { removeEventListener('online', on); removeEventListener('offline', off) }
  }, [])
  return online
}

/** The caller's app roles (assigned through app.roles or the console); `manager` unlocks the admin table. */
export function useRoles(): { roles: string[]; manager: boolean; loaded: boolean } {
  const [roles, setRoles] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { app.roles.myRoles().then(setRoles).catch(() => setRoles([])).finally(() => setLoaded(true)) }, [])
  return { roles, manager: roles.some((r) => (MANAGER_ROLES as readonly string[]).includes(r)), loaded }
}

export function useCategories(): { categories: Category[]; byId: Map<string, Category>; reload: () => Promise<void> } {
  const [categories, setCategories] = useState<Category[]>([])
  const reload = useCallback(async () => { setCategories(await q<Category>('list_categories').catch(() => [])) }, [])
  useEffect(() => { reload() }, [reload])
  return { categories, byId: new Map(categories.map((c) => [c.id, c])), reload }
}

export type LoadState = { kind: 'loading' } | { kind: 'ready'; places: Place[]; total: number } | { kind: 'offline' | 'denied' | 'error'; message: string }

/** The records for a set of filters — the map and the list both read through here, so they always agree. */
export function usePlaces(filters: Filters | null): { state: LoadState; reload: () => Promise<void> } {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const key = JSON.stringify(filters)
  const reload = useCallback(async () => {
    if (!filters) return
    try {
      const params: Record<string, unknown> = { ...filters }
      const [places, count] = await Promise.all([q<Place>('list_places', params), q<{ count: number }>('count_places', params)])
      setState({ kind: 'ready', places, total: count[0]?.count ?? places.length })
    } catch (e) {
      const kind = e instanceof ActionError ? (e.offline ? 'offline' : e.denied ? 'denied' : 'error') : 'error'
      setState({ kind, message: e instanceof Error ? e.message : String(e) })
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload() }, [reload])
  return { state, reload }
}

/** Current position, asked for once when requested. */
export function useGeolocation(): { locate: () => void; position: { lat: number; lng: number } | null; error: string | null; busy: boolean } {
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) { setError('Location is not available in this browser.'); return }
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => { setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setError(null); setBusy(false) },
      (err) => { setError(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : 'Could not get your location.'); setBusy(false) },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    )
  }, [])
  return { locate, position, error, busy }
}
