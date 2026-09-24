import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, q, x, imageUrl, uploadPhoto, DEFAULT_VIEW, GEOCODING_ENABLED, RECORD, STORAGE_ENABLED, type Place } from '../api'
import { Field, Section, State, TextArea, selectClass, stateFor } from '../components'
import { useCategories } from '../hooks'
import { MapView, type MapView as View } from '../map/MapView'

type Draft = { name: string; description: string; address: string; category_id: string; lat: string; lng: string; image_key: string | null }
const EMPTY: Draft = { name: '', description: '', address: '', category_id: '', lat: '', lng: '', image_key: null }

/** Create or edit one of the caller's own records. The point is picked on the map, typed, geocoded from the address, or taken from the device. */
export function PlaceForm({ id }: { id?: string }) {
  const { categories } = useCategories()
  const [d, setD] = useState<Draft>(EMPTY)
  const [view, setView] = useState<View>(DEFAULT_VIEW)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }))
  const point = d.lat !== '' && d.lng !== '' && !Number.isNaN(Number(d.lat)) && !Number.isNaN(Number(d.lng)) ? { lat: Number(d.lat), lng: Number(d.lng) } : null

  useEffect(() => {
    if (!id) return
    q<Place>('get_place', { id }).then(([p]) => {
      if (!p || p.owner_id !== app.auth.user?.id) { setError(Object.assign(new Error('not yours'), { status: 403 })); return }
      setD({ name: p.name, description: p.description, address: p.address, category_id: p.category_id ?? '', lat: String(p.lat), lng: String(p.lng), image_key: p.image_key })
      setView({ center: { lat: p.lat, lng: p.lng }, zoom: 15 })
    }).catch(setError)
  }, [id])

  async function geocode() {
    if (!GEOCODING_ENABLED || !d.address.trim()) return
    setBusy(true)
    try {
      const [hit] = await app.maps.geocode(d.address.trim(), 1)
      if (!hit) { setNotice('No match for that address.'); return }
      set({ lat: String(hit.lat), lng: String(hit.lng) })
      setView({ center: { lat: hit.lat, lng: hit.lng }, zoom: 15 })
      setNotice(`Found: ${hit.displayName}`)
    } catch { setNotice('Geocoding is unavailable right now.') } finally { setBusy(false) }
  }
  function useDevice() {
    navigator.geolocation?.getCurrentPosition((pos) => {
      set({ lat: String(pos.coords.latitude), lng: String(pos.coords.longitude) })
      setView({ center: { lat: pos.coords.latitude, lng: pos.coords.longitude }, zoom: 15 })
    }, () => setNotice('Could not get your location.'))
  }
  async function addPhoto(files: FileList | null) {
    if (!files?.[0]) return
    setBusy(true)
    try { set({ image_key: await uploadPhoto(files[0]) }) } catch (e) { setNotice(e instanceof Error ? e.message : 'Upload failed') } finally { setBusy(false) }
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    const user = app.auth.user
    if (!user || !d.name.trim() || !point) { setNotice('A name and a point on the map are needed.'); return }
    setBusy(true)
    try {
      const params = { name: d.name.trim(), description: d.description, address: d.address.trim(), category_id: d.category_id || null, lat: point.lat, lng: point.lng, image_key: d.image_key }
      const changed = id ? await x('update_place', { id, ...params }) : await x('create_place', { id: crypto.randomUUID(), owner_name: user.name, ...params })
      if (!changed) throw new Error('Nothing was saved: check the coordinates and category, and that this record is yours.')
      location.hash = id ? `#/p/${id}` : '#/'
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  if (error && id && (error as { status?: number }).status === 403) return <Section title="Edit"><State kind="denied" description={`Only the owner can edit this ${RECORD.noun}.`} /></Section>

  return (
    <Section title={id ? `Edit ${RECORD.noun}` : `New ${RECORD.noun}`}>
      <form onSubmit={submit} className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="Name"><Input aria-label="Name" required maxLength={120} value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Category">
            <select aria-label="Category" value={d.category_id} onChange={(e) => set({ category_id: e.target.value })} className={selectClass}>
              <option value="">None</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
            </select>
          </Field>
          <Field label="Description"><TextArea aria-label="Description" rows={4} maxLength={2000} value={d.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <Field label="Address"><Input aria-label="Address" value={d.address} onChange={(e) => set({ address: e.target.value })} placeholder="Street, suburb, city" /></Field>
          <div className="flex flex-wrap gap-2">
            {GEOCODING_ENABLED ? <Button type="button" variant="secondary" size="sm" loading={busy} onClick={geocode}>Find on map</Button> : null}
            <Button type="button" variant="secondary" size="sm" onClick={useDevice}>Use my location</Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude"><Input aria-label="Latitude" type="number" step="any" min={-90} max={90} value={d.lat} onChange={(e) => set({ lat: e.target.value })} /></Field>
            <Field label="Longitude"><Input aria-label="Longitude" type="number" step="any" min={-180} max={180} value={d.lng} onChange={(e) => set({ lng: e.target.value })} /></Field>
          </div>
          {STORAGE_ENABLED ? (
            <Field label="Photo">
              <input aria-label="Photo" type="file" accept="image/*" onChange={(e) => addPhoto(e.target.files)} className="block text-sm text-[var(--muted)]" />
            </Field>
          ) : null}
          {d.image_key ? <div className="flex items-center gap-2"><img src={imageUrl(d.image_key)} alt="" className="h-16 w-24 rounded-[var(--radius-sm)] object-cover" /><Button type="button" variant="ghost" size="sm" onClick={() => set({ image_key: null })}>Remove photo</Button></div> : null}
          {notice ? <p role="status" className="text-sm text-[var(--muted)]">{notice}</p> : null}
          {error && !(id && (error as { status?: number }).status === 403) ? <State kind={stateFor(error)} description={error instanceof Error ? error.message : undefined} /> : null}
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>{id ? 'Save' : 'Add to the map'}</Button>
            <Button type="button" variant="ghost" onClick={() => { location.hash = id ? `#/p/${id}` : '#/' }}>Cancel</Button>
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Tap the map to place the point</p>
          <MapView
            view={view}
            onViewChange={(v) => setView(v)}
            markers={point ? [{ id: 'draft', lat: point.lat, lng: point.lng, label: d.name || 'New point' }] : []}
            selectedId="draft"
            picking
            onPick={(p) => set({ lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) })}
            className="h-80 rounded-[var(--radius)] border border-[var(--line)] md:h-[28rem]"
          />
        </div>
      </form>
    </Section>
  )
}
