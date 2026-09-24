import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, pub, q, x, CATEGORIES, type Listing } from '../api'
import { Empty, ListingCard, Section } from '../components'

/** Saved ids for the signed-in user; empty and inert when signed out. */
export function useSaved() {
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const signedIn = !!app.auth.user
  useEffect(() => {
    if (!signedIn) return
    q<{ listing_id: string }>('list_my_favorite_ids').then((rows) => setSaved(new Set(rows.map((r) => r.listing_id)))).catch(() => {})
  }, [signedIn])
  const toggle = useCallback(async (id: string) => {
    if (!signedIn) { location.hash = '#/saved'; return }
    const has = saved.has(id)
    const next = new Set(saved)
    if (has) next.delete(id); else next.add(id)
    setSaved(next)
    await x(has ? 'remove_favorite' : 'add_favorite', { listing_id: id })
  }, [saved, signedIn])
  return { saved, toggle, signedIn }
}

export function Browse() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [rows, setRows] = useState<Listing[]>([])
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(true)
  const { saved, toggle, signedIn } = useSaved()

  const load = useCallback(async (before?: number) => {
    setBusy(true)
    try {
      const page = query.trim()
        ? await pub<Listing>('search_listings', { q: query.trim() })
        : await pub<Listing>('list_listings', { category: category || null, before: before ?? null })
      setRows((prev) => (before ? [...prev, ...page] : page))
      setDone(!!query.trim() || page.length < 24)
    } finally {
      setBusy(false)
    }
  }, [query, category])

  useEffect(() => { load() }, [load])

  return (
    <Section title="Browse">
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); load() }} role="search">
        <div className="min-w-48 flex-1"><Input aria-label="Search" placeholder="Search title, description or location" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-3 py-2 text-sm text-[var(--ink)]">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      {rows.length === 0 && !busy ? <Empty title="No listings yet" description="Be the first: sign in and publish one." /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((l) => <ListingCard key={l.id} listing={l} saved={saved.has(l.id)} onToggleSave={signedIn ? () => toggle(l.id) : undefined} />)}
      </div>
      {!done ? <div className="mt-6 text-center"><Button variant="ghost" loading={busy} onClick={() => load(rows[rows.length - 1]?.created_at)}>Load more</Button></div> : null}
    </Section>
  )
}

export function Saved() {
  const [rows, setRows] = useState<Listing[] | null>(null)
  const { saved, toggle } = useSaved()
  useEffect(() => { q<Listing>('list_my_favorites').then(setRows) }, [saved.size])
  return (
    <Section title="Saved">
      {rows && rows.length === 0 ? <Empty title="Nothing saved" description="Tap the heart on a listing to keep it here." /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(rows ?? []).map((l) => <ListingCard key={l.id} listing={l} saved onToggleSave={() => toggle(l.id)} />)}
      </div>
    </Section>
  )
}
