import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, q, x, images, imageUrl, uploadPhoto, money, CATEGORIES, MAPS_ENABLED, type Listing } from '../api'
import { Empty, Field, Section, Status, TextArea } from '../components'

export function OwnerDashboard() {
  const [rows, setRows] = useState<Listing[] | null>(null)
  const load = () => q<Listing>('list_my_listings').then(setRows)
  useEffect(() => { load() }, [])

  async function setStatus(l: Listing, status: string) {
    await x('set_listing_status', { id: l.id, status })
    await load()
  }

  return (
    <Section title="My listings" action={<Button onClick={() => { location.hash = '#/mine/new' }}>New listing</Button>}>
      {rows && rows.length === 0 ? <Empty title="You have no listings" description="Publish one and it appears in the public catalogue immediately." /> : null}
      <ul className="space-y-3">
        {(rows ?? []).map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] p-3">
            <div>
              <a href={`#/l/${l.id}`} className="font-semibold text-[var(--ink)] hover:underline">{l.title}</a>
              <p className="text-xs text-[var(--muted)]">{[l.category, l.location, money(l)].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex items-center gap-2">
              <Status value={l.status} />
              <Button variant="ghost" size="sm" onClick={() => { location.hash = `#/mine/${l.id}/edit` }}>Edit</Button>
              {l.status === 'active' ? <Button variant="secondary" size="sm" onClick={() => setStatus(l, 'paused')}>Pause</Button> : null}
              {l.status === 'paused' ? <Button variant="secondary" size="sm" onClick={() => setStatus(l, 'active')}>Activate</Button> : null}
              {l.status !== 'archived' ? <Button variant="danger" size="sm" onClick={() => setStatus(l, 'archived')}>Archive</Button> : null}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

type Draft = { title: string; description: string; category: string; location: string; price: string; price_unit: string; images: string[] }
const EMPTY: Draft = { title: '', description: '', category: CATEGORIES[0], location: '', price: '', price_unit: '', images: [] }

export function ListingForm({ id }: { id?: string }) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  useEffect(() => {
    if (!id) return
    q<Listing>('get_my_listing', { id }).then(([l]) => {
      if (!l) { location.hash = '#/mine'; return }
      setDraft({ title: l.title, description: l.description, category: l.category, location: l.location, price: l.price === null ? '' : String(l.price), price_unit: l.price_unit, images: images(l) })
    })
  }, [id])

  async function addPhotos(files: FileList | null) {
    if (!files) return
    setBusy(true)
    try {
      const keys: string[] = []
      for (const f of Array.from(files).slice(0, 6)) keys.push(await uploadPhoto(f))
      set({ images: [...draft.images, ...keys].slice(0, 6) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const user = app.auth.user
    if (!user || !draft.title.trim()) return
    setBusy(true)
    setError('')
    try {
      let lat: number | null = null
      let lng: number | null = null
      if (MAPS_ENABLED && draft.location.trim()) {
        const [hit] = await app.maps.geocode(draft.location.trim(), 1).catch(() => [])
        if (hit) { lat = hit.lat; lng = hit.lng }
      }
      const params = {
        title: draft.title.trim(), description: draft.description, category: draft.category, location: draft.location.trim(),
        lat, lng, price: draft.price === '' ? null : Number(draft.price), price_unit: draft.price_unit.trim(), images: JSON.stringify(draft.images),
      }
      const changes = id
        ? await x('update_listing', { id, ...params })
        : await x('create_listing', { id: crypto.randomUUID(), owner_name: user.name, ...params })
      if (!changes) throw new Error('Nothing was saved. If you are editing, the listing may not be yours.')
      location.hash = '#/mine'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={id ? 'Edit listing' : 'New listing'}>
      <form onSubmit={submit} className="max-w-xl space-y-4">
        <Field label="Title"><Input aria-label="Title" required maxLength={120} value={draft.title} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Description"><TextArea aria-label="Description" rows={6} maxLength={4000} value={draft.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category">
            <select aria-label="Category" value={draft.category} onChange={(e) => set({ category: e.target.value })} className="w-full rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-3 py-2 text-sm text-[var(--ink)]">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Location"><Input aria-label="Location" placeholder="Suburb, city" value={draft.location} onChange={(e) => set({ location: e.target.value })} /></Field>
          <Field label="Price"><Input aria-label="Price" type="number" min={0} step="0.01" value={draft.price} onChange={(e) => set({ price: e.target.value })} /></Field>
          <Field label="Per"><Input aria-label="Price unit" placeholder="night, hour, month, fixed" value={draft.price_unit} onChange={(e) => set({ price_unit: e.target.value })} /></Field>
        </div>
        <Field label="Photos (up to 6)">
          <input aria-label="Photos" type="file" accept="image/*" multiple onChange={(e) => addPhotos(e.target.files)} className="block text-sm text-[var(--muted)]" />
        </Field>
        {draft.images.length ? (
          <div className="flex flex-wrap gap-2">
            {draft.images.map((k) => (
              <div key={k} className="relative">
                <img src={imageUrl(k)} alt="" className="h-20 w-28 rounded-[var(--radius-sm)] object-cover" />
                <button type="button" aria-label="Remove photo" onClick={() => set({ images: draft.images.filter((i) => i !== k) })} className="absolute -right-1 -top-1 rounded-full bg-[var(--paper)] px-1.5 text-xs text-[var(--danger)] shadow">✕</button>
              </div>
            ))}
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>{id ? 'Save changes' : 'Publish'}</Button>
          <Button type="button" variant="ghost" onClick={() => { location.hash = '#/mine' }}>Cancel</Button>
        </div>
      </form>
    </Section>
  )
}
