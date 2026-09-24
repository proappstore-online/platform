import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { DEFAULT_VIEW, RECORD, type Filters, type Place } from '../api'
import { PlaceCard, State, stateFor } from '../components'
import { useCategories, useGeolocation, useOnline, usePlaces } from '../hooks'
import { MapView, type MapView as View } from '../map/MapView'
import { distanceKm, fitBounds, type Bounds } from '../map/geo'
import { FilterBar, type FilterValues } from './FilterBar'
import { PlaceDetail } from './PlacePage'

const VIEW_KEY = 'APPNAME:map-view'

/**
 * The primary workspace: a full-bleed map with the records in the viewport,
 * clustered; a side panel (desktop) or bottom sheet (mobile) with the same rows
 * as a keyboard-navigable list; selection opens the detail panel.
 */
export function MapPage({ selected }: { selected: string | null }) {
  const online = useOnline()
  const { categories, byId } = useCategories()
  const geo = useGeolocation()
  const [filter, setFilter] = useState<FilterValues>({ q: '', category_id: '' })
  const [debounced, setDebounced] = useState(filter)
  const [view, setView] = useState<View>(() => { try { return JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? '') as View } catch { return DEFAULT_VIEW } })
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [fitted, setFitted] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => { const t = setTimeout(() => setDebounced(filter), 250); return () => clearTimeout(t) }, [filter])
  const filters: Filters | null = useMemo(() => (bounds ? { q: debounced.q.trim() || null, category_id: debounced.category_id || null, ...bounds } : null), [debounced, bounds])
  const { state, reload } = usePlaces(filters)

  const onViewChange = useCallback((v: View, b: Bounds) => {
    setView(v)
    setBounds(b)
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(v)) } catch { /* private mode */ }
  }, [])

  // First load with nothing remembered: fit whatever is visible, once.
  useEffect(() => {
    if (fitted || state.kind !== 'ready' || sessionStorage.getItem(VIEW_KEY)) { if (state.kind === 'ready') setFitted(true); return }
    if (state.places.length) setView(fitBounds(state.places, 800, 600))
    setFitted(true)
  }, [state, fitted])

  useEffect(() => { if (geo.position) setView({ center: geo.position, zoom: 14 }) }, [geo.position])

  const places = state.kind === 'ready' ? state.places : []
  const sorted = useMemo(() => (geo.position ? [...places].sort((a, b) => distanceKm(a, geo.position!) - distanceKm(b, geo.position!)) : places), [places, geo.position])
  const markers = useMemo(() => places.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.name, color: byId.get(p.category_id ?? '')?.color })), [places, byId])
  const select = (id: string | null) => { location.hash = id ? `#/?sel=${id}` : '#/'; if (id) setSheetOpen(true) }
  const selectedPlace: Place | undefined = places.find((p) => p.id === selected)

  return (
    <div className="flex flex-1 flex-col md:flex-row" style={{ minHeight: 'calc(100dvh - 8rem)' }}>
      <div className="relative flex-1">
        <MapView view={view} onViewChange={onViewChange} markers={markers} selectedId={selected} onSelect={select} offline={!online} className="absolute inset-0" />
        <div className="absolute left-2 right-14 top-2 z-10 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel-strong)] p-2 shadow md:right-auto md:w-[28rem]">
          <FilterBar value={filter} onChange={setFilter} categories={categories} onLocate={geo.locate} locating={geo.busy} extra={<a href="#/new" className="text-sm font-semibold text-[var(--accent)] hover:underline">+ Add</a>} />
          {geo.error ? <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{geo.error}</p> : null}
        </div>
        <button type="button" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen} aria-controls="map-sheet" className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-2 text-sm font-semibold text-[var(--ink)] shadow md:hidden">
          {state.kind === 'ready' ? `${state.total} ${state.total === 1 ? RECORD.noun : RECORD.plural} here` : 'List'}
        </button>
      </div>
      <aside id="map-sheet" aria-label={`${RECORD.plural} in view`} className={`border-t border-[var(--line)] bg-[var(--paper)] md:w-96 md:border-l md:border-t-0 ${sheetOpen ? 'max-h-[55dvh]' : 'max-h-0 md:max-h-none'} overflow-y-auto transition-all md:max-h-none`}>
        {selectedPlace ? (
          <div className="p-4">
            <button type="button" onClick={() => select(null)} className="mb-2 text-xs text-[var(--muted)] hover:underline">← Back to the list</button>
            <PlaceDetail place={selectedPlace} category={byId.get(selectedPlace.category_id ?? '')} onChanged={reload} compact />
          </div>
        ) : (
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--muted)]">
              <span>{state.kind === 'ready' ? `${state.total} in view${state.total > state.places.length ? ` (showing ${state.places.length})` : ''}` : ''}</span>
              <a href="#/list" className="font-semibold text-[var(--accent)] hover:underline">Full list</a>
            </div>
            {state.kind === 'loading' ? <State kind="loading" /> : null}
            {state.kind === 'offline' || state.kind === 'denied' || state.kind === 'error' ? <State kind={stateFor(new Error(state.message))} action={<Button size="sm" variant="secondary" onClick={reload}>Retry</Button>} /> : null}
            {state.kind === 'ready' && sorted.length === 0 ? <State kind="empty" title={`No ${RECORD.plural} in this area`} description="Zoom out, clear the filters, or add one." action={<a href="#/new" className="text-sm font-semibold text-[var(--accent)] hover:underline">Add a {RECORD.noun}</a>} /> : null}
            <ul aria-label={`${RECORD.plural} list`} className="space-y-2">
              {sorted.map((p) => <PlaceCard key={p.id} place={p} category={byId.get(p.category_id ?? '')} selected={p.id === selected} onSelect={() => select(p.id)} />)}
            </ul>
          </div>
        )}
      </aside>
    </div>
  )
}
