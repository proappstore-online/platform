import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { batch, q, x, when, RECORD, type Category, type CategoryStat, type Place } from '../api'
import { Badge, Field, Section, State, selectClass, stateFor } from '../components'
import { useRoles } from '../hooks'

/** The management table: every record in every status, and the categories. App roles admin / editor only — the actions refuse everyone else. */
export function AdminPage() {
  const { manager, loaded } = useRoles()
  const [places, setPlaces] = useState<Place[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [stats, setStats] = useState<CategoryStat[]>([])
  const [error, setError] = useState<unknown>(null)
  const [filter, setFilter] = useState({ q: '', status: '', category_id: '' })
  const [cat, setCat] = useState({ name: '', icon: '', color: '#d86f4d' })
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const [p, c, s] = await Promise.all([
        q<Place>('admin_list_places', { q: filter.q.trim() || null, status: filter.status || null, category_id: filter.category_id || null }),
        q<Category>('list_categories'), q<CategoryStat>('category_stats'),
      ])
      setPlaces(p); setCategories(c); setStats(s); setError(null)
    } catch (e) { setError(e) }
  }, [filter])
  useEffect(() => { if (loaded && manager) load() }, [load, loaded, manager])

  if (loaded && !manager) return <Section title="Admin"><State kind="denied" /></Section>

  async function setStatus(p: Place, status: string) { setMsg((await x('admin_set_place_status', { id: p.id, status })) ? '' : 'Not allowed.'); await load() }
  async function remove(p: Place) { if (!confirm(`Delete "${p.name}" by ${p.owner_name}?`)) return; setMsg((await x('admin_delete_place', { id: p.id })) ? '' : 'Not allowed.'); await load() }
  async function recategorise(p: Place, category_id: string) { setMsg((await x('admin_update_place', { id: p.id, category_id: category_id || null, name: p.name, description: p.description, address: p.address })) ? '' : 'Not allowed.'); await load() }
  async function addCategory(e: FormEvent) {
    e.preventDefault()
    if (!cat.name.trim()) return
    const changed = await x('admin_create_category', { id: crypto.randomUUID(), name: cat.name.trim(), icon: cat.icon.trim(), color: cat.color, sort_order: categories.length })
    setMsg(changed ? '' : 'Not allowed.'); setCat({ name: '', icon: '', color: '#d86f4d' }); await load()
  }
  async function deleteCategory(c: Category) {
    if (!confirm(`Delete category "${c.name}"? Its ${RECORD.plural} stay, uncategorised.`)) return
    const changes = await batch('admin_delete_category', { id: c.id })
    setMsg(changes[1] ? '' : 'Not allowed.'); await load()
  }

  return (
    <Section title="Admin">
      <h2 className="display-font text-lg font-semibold text-[var(--ink)]">Categories</h2>
      <form onSubmit={addCategory} className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-40"><Field label="Name"><Input aria-label="Category name" value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} /></Field></div>
        <div className="w-20"><Field label="Icon"><Input aria-label="Category icon" value={cat.icon} onChange={(e) => setCat({ ...cat, icon: e.target.value })} placeholder="☕" /></Field></div>
        <Field label="Colour"><input aria-label="Category colour" type="color" value={cat.color} onChange={(e) => setCat({ ...cat, color: e.target.value })} className="h-9 w-12 rounded border border-[var(--line)]" /></Field>
        <Button type="submit" size="sm">Add category</Button>
      </form>
      <ul className="mt-2 flex flex-wrap gap-2">
        {categories.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded-full border border-[var(--line)] px-3 py-1 text-sm">
            <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ background: c.color }} />
            <span className="text-[var(--ink)]">{c.icon} {c.name}</span>
            <span className="text-xs text-[var(--muted)]">{stats.find((s) => s.id === c.id)?.active_count ?? 0} active</span>
            <button type="button" aria-label={`Delete category ${c.name}`} onClick={() => deleteCategory(c)} className="text-xs text-[var(--danger)] hover:underline">✕</button>
          </li>
        ))}
      </ul>

      <h2 className="display-font mt-8 text-lg font-semibold text-[var(--ink)]">All {RECORD.plural}</h2>
      <form role="search" onSubmit={(e) => { e.preventDefault(); load() }} className="mt-2 flex flex-wrap gap-2">
        <div className="min-w-40 flex-1"><Input aria-label="Search records" placeholder="Name or owner" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} /></div>
        <select aria-label="Status" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} className={selectClass + ' w-auto'}><option value="">Any status</option><option value="active">active</option><option value="hidden">hidden</option></select>
        <select aria-label="Category filter" value={filter.category_id} onChange={(e) => setFilter({ ...filter, category_id: e.target.value })} className={selectClass + ' w-auto'}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <Button type="submit" variant="secondary" size="sm">Filter</Button>
      </form>
      {error ? <div className="mt-3"><State kind={stateFor(error)} action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>} /></div> : null}
      {!error && places === null ? <div className="mt-3"><State kind="loading" /></div> : null}
      {places && places.length === 0 ? <div className="mt-3"><State kind="empty" /></div> : null}
      {places && places.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]"><th className="py-2">Name</th><th>Owner</th><th>Category</th><th>Status</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {places.map((p) => (
                <tr key={p.id} className="border-t border-[var(--line)]">
                  <td className="py-2"><a href={`#/p/${p.id}`} className="font-medium text-[var(--ink)] hover:underline">{p.name}</a></td>
                  <td className="text-[var(--muted)]">{p.owner_name || p.owner_id}</td>
                  <td><select aria-label={`Category for ${p.name}`} value={p.category_id ?? ''} onChange={(e) => recategorise(p, e.target.value)} className={selectClass + ' w-auto py-1'}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
                  <td><Badge value={p.status} /></td>
                  <td className="text-[var(--muted)]">{when(p.updated_at)}</td>
                  <td className="whitespace-nowrap text-right">
                    {p.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => setStatus(p, 'hidden')}>Hide</Button> : <Button size="sm" variant="ghost" onClick={() => setStatus(p, 'active')}>Show</Button>}
                    <Button size="sm" variant="danger" onClick={() => remove(p)}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {msg ? <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{msg}</p> : null}
    </Section>
  )
}
