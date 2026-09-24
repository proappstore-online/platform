import { useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { q, RECORD, type Place } from '../api'
import { PlaceCard, Section, State, stateFor } from '../components'
import { useCategories } from '../hooks'

export function MinePage() {
  const { byId } = useCategories()
  const [places, setPlaces] = useState<Place[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = async () => { try { setPlaces(await q<Place>('list_my_places')); setError(null) } catch (e) { setError(e) } }
  useEffect(() => { load() }, [])
  return (
    <Section title={`My ${RECORD.plural}`} action={<a href="#/new" className="text-sm font-semibold text-[var(--accent)] hover:underline">+ Add</a>}>
      {error ? <State kind={stateFor(error)} action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>} /> : null}
      {!error && places === null ? <State kind="loading" /> : null}
      {places && places.length === 0 ? <State kind="empty" title={`You haven't added a ${RECORD.noun} yet`} /> : null}
      <ul aria-label={`my ${RECORD.plural}`} className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {(places ?? []).map((p) => <PlaceCard key={p.id} place={p} category={byId.get(p.category_id ?? '')} />)}
      </ul>
    </Section>
  )
}
