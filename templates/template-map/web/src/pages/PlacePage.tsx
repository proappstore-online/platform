import { useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { app, q, x, imageUrl, when, fmtCoord, RECORD, type Category, type Place } from '../api'
import { Badge, Section, State, stateFor } from '../components'
import { useCategories } from '../hooks'

export function PlaceDetail({ place, category, onChanged, compact }: { place: Place; category?: Category; onChanged: () => Promise<void>; compact?: boolean }) {
  const me = app.auth.user?.id
  const mine = place.owner_id === me
  const [msg, setMsg] = useState('')
  async function setStatus(status: 'active' | 'hidden') {
    const changed = await x('set_place_status', { id: place.id, status })
    setMsg(changed ? '' : 'Not allowed.')
    await onChanged()
  }
  async function remove() {
    if (!confirm(`Delete "${place.name}"?`)) return
    const changed = await x('delete_place', { id: place.id })
    if (!changed) { setMsg('Not allowed.'); return }
    location.hash = '#/'
  }
  return (
    <article aria-label={place.name}>
      {place.image_key ? <img src={imageUrl(place.image_key)} alt="" className={`mb-3 w-full rounded-[var(--radius)] object-cover ${compact ? 'max-h-40' : 'max-h-80'}`} /> : null}
      <h2 className={`display-font font-semibold text-[var(--ink)] ${compact ? 'text-lg' : 'text-2xl'}`}>{place.name}</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">{[category ? `${category.icon} ${category.name}`.trim() : null, place.address].filter(Boolean).join(' · ')}</p>
      <p className="text-xs text-[var(--muted)]">{fmtCoord(place.lat)}, {fmtCoord(place.lng)} · by {place.owner_name || 'a member'} · {when(place.updated_at)} {place.status === 'hidden' ? <Badge value="hidden" /> : null}</p>
      {place.description ? <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--ink)]">{place.description}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={`#/p/${place.id}`} className="self-center text-sm text-[var(--accent)] hover:underline">{compact ? 'Open' : ''}</a>
        <a href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=16/${place.lat}/${place.lng}`} target="_blank" rel="noreferrer" className="self-center text-sm text-[var(--muted)] hover:underline">Directions ↗</a>
        {mine ? <>
          <Button size="sm" variant="secondary" onClick={() => { location.hash = `#/p/${place.id}/edit` }}>Edit</Button>
          {place.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => setStatus('hidden')}>Hide</Button> : <Button size="sm" onClick={() => setStatus('active')}>Show</Button>}
          <Button size="sm" variant="danger" onClick={remove}>Delete</Button>
        </> : null}
      </div>
      {msg ? <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{msg}</p> : null}
    </article>
  )
}

export function PlacePage({ id }: { id: string }) {
  const { byId } = useCategories()
  const [place, setPlace] = useState<Place | null | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  const load = async () => {
    try { const [p] = await q<Place>('get_place', { id }); setPlace(p ?? null); setError(null) }
    catch (e) { setError(e) }
  }
  useEffect(() => { load() }, [id])
  return (
    <Section title={place?.name ?? RECORD.noun[0]!.toUpperCase() + RECORD.noun.slice(1)} action={<a href={`#/?sel=${id}`} className="text-sm text-[var(--accent)] hover:underline">Show on map</a>}>
      {error ? <State kind={stateFor(error)} action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>} /> : null}
      {!error && place === undefined ? <State kind="loading" /> : null}
      {!error && place === null ? <State kind="empty" title="Not found" description="It may have been removed or hidden by its owner." /> : null}
      {place ? <div className="max-w-2xl"><PlaceDetail place={place} category={byId.get(place.category_id ?? '')} onChanged={load} /></div> : null}
    </Section>
  )
}
