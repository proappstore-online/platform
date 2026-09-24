import { useEffect, useMemo, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { RECORD, type Filters } from '../api'
import { PlaceCard, Section, State, stateFor } from '../components'
import { useCategories, useGeolocation, usePlaces } from '../hooks'
import { distanceKm } from '../map/geo'
import { FilterBar, type FilterValues } from './FilterBar'

/** The accessible alternative to the map: the same records, same filters, as a list you can Tab through. */
export function ListPage() {
  const { categories, byId } = useCategories()
  const geo = useGeolocation()
  const [filter, setFilter] = useState<FilterValues>({ q: '', category_id: '' })
  const [debounced, setDebounced] = useState(filter)
  useEffect(() => { const t = setTimeout(() => setDebounced(filter), 250); return () => clearTimeout(t) }, [filter])
  const filters: Filters = useMemo(() => ({ q: debounced.q.trim() || null, category_id: debounced.category_id || null }), [debounced])
  const { state, reload } = usePlaces(filters)
  const places = state.kind === 'ready' ? state.places : []
  const sorted = useMemo(() => (geo.position ? [...places].sort((a, b) => distanceKm(a, geo.position!) - distanceKm(b, geo.position!)) : places), [places, geo.position])

  return (
    <Section title={`All ${RECORD.plural}`} action={<a href="#/new" className="text-sm font-semibold text-[var(--accent)] hover:underline">+ Add</a>}>
      <div className="mb-4"><FilterBar value={filter} onChange={setFilter} categories={categories} onLocate={geo.locate} locating={geo.busy} /></div>
      {geo.error ? <p role="alert" className="mb-2 text-xs text-[var(--danger)]">{geo.error}</p> : null}
      {state.kind === 'ready' ? <p className="mb-2 text-xs text-[var(--muted)]">{state.total} {state.total === 1 ? RECORD.noun : RECORD.plural}{geo.position ? ', nearest first' : ''}</p> : null}
      {state.kind === 'loading' ? <State kind="loading" /> : null}
      {state.kind === 'offline' || state.kind === 'denied' || state.kind === 'error' ? <State kind={stateFor(new Error(state.message))} action={<Button size="sm" variant="secondary" onClick={reload}>Retry</Button>} /> : null}
      {state.kind === 'ready' && sorted.length === 0 ? <State kind="empty" /> : null}
      <ul aria-label={`${RECORD.plural} list`} className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {sorted.map((p) => <PlaceCard key={p.id} place={p} category={byId.get(p.category_id ?? '')} />)}
      </ul>
    </Section>
  )
}
