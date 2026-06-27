/**
 * Dashboard / CRUD template — generic list/detail/create with filters.
 * Pattern extracted from: timetrack, grasskarma, flights
 *
 * Features: stats overview, filterable item list, detail view,
 * create/edit forms, category-based organization.
 */
export function dashboardFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();

  files.set('src/lib/app.ts', `import { initPro } from '@proappstore/sdk'
export const app = initPro({ appId: '${slug}' })
`);

  files.set('src/types.ts', `export interface Item {
  id: string
  user_id: string
  title: string
  description: string
  category: string
  status: 'active' | 'archived'
  priority: 'low' | 'medium' | 'high'
  created_at: number
  updated_at: number
}

export interface Stats {
  total: number
  active: number
  archived: number
  byCategory: Array<{ category: string; count: number }>
}
`);

  files.set('src/lib/db.ts', `import { app } from './app'
import type { Item, Stats } from '../types'

const MIGRATIONS = [
  {
    name: '0001_init',
    sql: \`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT DEFAULT '', category TEXT DEFAULT '',
        status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_cat ON items(user_id, category);
    \`
  }
]

export async function migrate() { await app.db.migrate(MIGRATIONS) }

export async function getStats(userId: string): Promise<Stats> {
  const [totals, cats] = await Promise.all([
    app.db.query<{ status: string; c: number }>('SELECT status, COUNT(*) as c FROM items WHERE user_id = ? GROUP BY status', [userId]),
    app.db.query<{ category: string; count: number }>('SELECT category, COUNT(*) as count FROM items WHERE user_id = ? AND status = ? GROUP BY category ORDER BY count DESC', [userId, 'active']),
  ])
  const active = totals.rows.find((r) => r.status === 'active')?.c ?? 0
  const archived = totals.rows.find((r) => r.status === 'archived')?.c ?? 0
  return { total: active + archived, active, archived, byCategory: cats.rows }
}

export async function listItems(userId: string, opts?: { search?: string; category?: string; status?: string }) {
  let sql = 'SELECT * FROM items WHERE user_id = ?'
  const params: unknown[] = [userId]
  if (opts?.status) { sql += ' AND status = ?'; params.push(opts.status) } else { sql += ' AND status = ?'; params.push('active') }
  if (opts?.category) { sql += ' AND category = ?'; params.push(opts.category) }
  if (opts?.search) { sql += ' AND (title LIKE ? OR description LIKE ?)'; params.push('%' + opts.search + '%', '%' + opts.search + '%') }
  sql += ' ORDER BY created_at DESC LIMIT 100'
  return (await app.db.query<Item>(sql, params)).rows
}

export async function getItem(id: string) {
  return (await app.db.query<Item>('SELECT * FROM items WHERE id = ?', [id])).rows[0] ?? null
}

export async function createItem(userId: string, data: Pick<Item, 'title' | 'description' | 'category' | 'priority'>) {
  const id = crypto.randomUUID()
  const now = Date.now()
  await app.db.execute(
    'INSERT INTO items (id,user_id,title,description,category,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, userId, data.title, data.description, data.category, data.priority, 'active', now, now]
  )
  return id
}

export async function updateItem(id: string, data: Partial<Pick<Item, 'title' | 'description' | 'category' | 'priority' | 'status'>>) {
  const sets: string[] = []
  const params: unknown[] = []
  if (data.title !== undefined) { sets.push('title=?'); params.push(data.title) }
  if (data.description !== undefined) { sets.push('description=?'); params.push(data.description) }
  if (data.category !== undefined) { sets.push('category=?'); params.push(data.category) }
  if (data.priority !== undefined) { sets.push('priority=?'); params.push(data.priority) }
  if (data.status !== undefined) { sets.push('status=?'); params.push(data.status) }
  sets.push('updated_at=?'); params.push(Date.now())
  params.push(id)
  await app.db.execute('UPDATE items SET ' + sets.join(',') + ' WHERE id=?', params)
}

export async function deleteItem(id: string) {
  await app.db.execute('DELETE FROM items WHERE id = ?', [id])
}
`);

  files.set('src/App.tsx', `import { useState, useEffect } from 'react'
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
import { Avatar, ThemeToggle } from '@proappstore/sdk/ui'
import { app } from './lib/app'
import { migrate, getStats } from './lib/db'
import { Dashboard } from './pages/Dashboard'
import { ItemList } from './pages/ItemList'
import { ItemDetail } from './pages/ItemDetail'
import { ItemForm } from './pages/ItemForm'
import type { Stats } from './types'

type Route = { page: 'dashboard' } | { page: 'list' } | { page: 'detail'; id: string } | { page: 'create' } | { page: 'edit'; id: string }

function parseHash(): Route {
  const h = location.hash.slice(1)
  if (h.startsWith('/item/') && h.endsWith('/edit')) return { page: 'edit', id: h.slice(6, -5) }
  if (h.startsWith('/item/')) return { page: 'detail', id: h.slice(6) }
  if (h === '/list') return { page: 'list' }
  if (h === '/create') return { page: 'create' }
  return { page: 'dashboard' }
}

export default function App() {
  const { user, loading } = useProAuth(app)
  const { theme } = useTheme()
  const [route, setRoute] = useState<Route>(parseHash)
  const [stats, setStats] = useState<Stats | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => { const h = () => setRoute(parseHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  useEffect(() => {
    if (!user) return
    migrate().then(() => getStats(user.id)).then((s) => { setStats(s); setReady(true) })
  }, [user])

  if (loading) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Loading...</div>
  if (!user) return (
    <div className="min-h-[100dvh] flex items-center justify-center">
      <div className="card text-center space-y-4 max-w-sm">
        <h1 className="text-xl font-bold text-[var(--ink-strong)] display-font">${slug}</h1>
        <p className="text-muted">Track and manage your items</p>
        <button onClick={() => app.auth.signIn('github')} className="btn btn-primary w-full">Sign in with GitHub</button>
        <button onClick={() => app.auth.signIn('google')} className="btn btn-secondary w-full">Sign in with Google</button>
      </div>
    </div>
  )
  if (!ready) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Setting up...</div>

  const refreshStats = () => getStats(user.id).then(setStats)

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <button onClick={() => { location.hash = '#/' }} className="font-bold text-[var(--ink)] display-font">${slug}</button>
          <nav className="flex items-center gap-3 text-sm">
            <a href="#/" className="text-[var(--muted)] hover:text-[var(--ink)]">Dashboard</a>
            <a href="#/list" className="text-[var(--muted)] hover:text-[var(--ink)]">Items</a>
            <a href="#/create" className="btn btn-primary text-xs">New</a>
            <ThemeToggle />
            <Avatar user={user} size={28} />
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        {route.page === 'dashboard' && stats && <Dashboard stats={stats} />}
        {route.page === 'list' && <ItemList userId={user.id} />}
        {route.page === 'detail' && <ItemDetail id={route.id} userId={user.id} onUpdate={refreshStats} />}
        {route.page === 'create' && <ItemForm userId={user.id} onSave={refreshStats} />}
        {route.page === 'edit' && <ItemForm userId={user.id} editId={route.id} onSave={refreshStats} />}
      </main>
    </div>
  )
}
`);

  files.set('src/pages/Dashboard.tsx', `import type { Stats } from '../types'

export function Dashboard({ stats }: { stats: Stats }) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-[var(--ink-strong)]">Dashboard</h2>
      <div className="grid grid-cols-3 gap-3">
        <div className="card text-center">
          <div className="text-2xl font-bold text-[var(--ink-strong)]">{stats.total}</div>
          <div className="text-xs text-muted">Total</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-bold text-[var(--accent)]">{stats.active}</div>
          <div className="text-xs text-muted">Active</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-bold text-muted">{stats.archived}</div>
          <div className="text-xs text-muted">Archived</div>
        </div>
      </div>
      {stats.byCategory.length > 0 && (
        <div className="card">
          <h3 className="font-semibold text-sm text-[var(--ink-strong)] mb-3">By Category</h3>
          <div className="space-y-2">
            {stats.byCategory.map((c) => (
              <div key={c.category || 'uncategorized'} className="flex justify-between items-center">
                <span className="text-sm text-[var(--ink)]">{c.category || 'Uncategorized'}</span>
                <span className="badge badge-accent">{c.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <a href="#/list" className="btn btn-secondary w-full text-center block">View All Items</a>
    </div>
  )
}
`);

  files.set('src/pages/ItemList.tsx', `import { useState, useEffect } from 'react'
import type { Item } from '../types'
import { listItems } from '../lib/db'

export function ItemList({ userId }: { userId: string }) {
  const [items, setItems] = useState<Item[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    listItems(userId, { search: search || undefined, category: category || undefined })
      .then(setItems).finally(() => setLoading(false))
  }, [search, category, userId])

  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[var(--ink-strong)]">Items</h2>
        <a href="#/create" className="btn btn-primary text-sm">+ New</a>
      </div>
      <div className="flex gap-2 flex-wrap">
        <input className="input flex-1 min-w-[200px]" placeholder="Search..." value={search}
          onChange={(e) => setSearch(e.target.value)} />
        {categories.length > 0 && (
          <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
      {loading ? <p className="text-muted">Loading...</p> : items.length === 0 ? (
        <div className="empty-state"><h3>No items</h3><p>Create your first item to get started.</p></div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <a key={item.id} href={'#/item/' + item.id} className="card flex items-center gap-3 hover:border-[var(--accent)] transition-colors block">
              <div className={'w-2 h-2 rounded-full flex-shrink-0 ' +
                (item.priority === 'high' ? 'bg-[var(--error)]' : item.priority === 'medium' ? 'bg-[var(--warning)]' : 'bg-[var(--muted)]')} />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-[var(--ink-strong)]">{item.title}</div>
                {item.description && <div className="text-xs text-muted truncate">{item.description}</div>}
              </div>
              {item.category && <span className="badge badge-accent text-xs">{item.category}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
`);

  files.set('src/pages/ItemDetail.tsx', `import { useState, useEffect } from 'react'
import type { Item } from '../types'
import { getItem, updateItem, deleteItem } from '../lib/db'

export function ItemDetail({ id, userId, onUpdate }: { id: string; userId: string; onUpdate: () => void }) {
  const [item, setItem] = useState<Item | null>(null)

  useEffect(() => { getItem(id).then(setItem) }, [id])
  if (!item) return <p className="text-muted">Loading...</p>

  const handleArchive = async () => {
    await updateItem(id, { status: item.status === 'active' ? 'archived' : 'active' })
    onUpdate(); setItem(await getItem(id))
  }

  const handleDelete = async () => {
    await deleteItem(id); onUpdate(); window.location.hash = '#/list'
  }

  return (
    <div className="max-w-2xl space-y-4">
      <a href="#/list" className="text-sm text-[var(--accent)] hover:underline">&larr; Back</a>
      <div className="flex items-start justify-between">
        <h1 className="text-xl font-bold text-[var(--ink-strong)]">{item.title}</h1>
        <div className="flex gap-2">
          <a href={'#/item/' + id + '/edit'} className="btn btn-secondary text-xs">Edit</a>
          <button onClick={handleArchive} className="btn btn-ghost text-xs">{item.status === 'active' ? 'Archive' : 'Restore'}</button>
        </div>
      </div>
      <div className="flex gap-2 text-xs">
        {item.category && <span className="badge badge-accent">{item.category}</span>}
        <span className={'badge ' + (item.priority === 'high' ? 'badge-error' : item.priority === 'medium' ? 'badge-accent' : '')}>{item.priority}</span>
        <span className="text-muted">{new Date(item.created_at).toLocaleDateString()}</span>
      </div>
      {item.description && <p className="text-[var(--ink)] leading-relaxed whitespace-pre-wrap">{item.description}</p>}
      <button onClick={handleDelete} className="text-xs text-[var(--error)] hover:underline">Delete permanently</button>
    </div>
  )
}
`);

  files.set('src/pages/ItemForm.tsx', `import { useState, useEffect } from 'react'
import { createItem, getItem, updateItem } from '../lib/db'

export function ItemForm({ userId, editId, onSave }: { userId: string; editId?: string; onSave: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (editId) getItem(editId).then((item) => {
      if (item) { setTitle(item.title); setDescription(item.description); setCategory(item.category); setPriority(item.priority) }
    })
  }, [editId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    if (editId) {
      await updateItem(editId, { title, description, category, priority })
      onSave(); window.location.hash = '#/item/' + editId
    } else {
      const newId = await createItem(userId, { title, description, category, priority })
      onSave(); window.location.hash = '#/item/' + newId
    }
  }

  return (
    <div className="max-w-lg">
      <a href={editId ? '#/item/' + editId : '#/list'} className="text-sm text-[var(--accent)] hover:underline">&larr; Back</a>
      <h2 className="text-lg font-bold text-[var(--ink-strong)] mt-4 mb-4">{editId ? 'Edit' : 'New'} Item</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div><label className="text-sm font-medium text-[var(--ink)]">Title *</label>
          <input className="input mt-1" value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
        <div><label className="text-sm font-medium text-[var(--ink)]">Description</label>
          <textarea className="input mt-1 min-h-[100px]" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-sm font-medium text-[var(--ink)]">Category</label>
            <input className="input mt-1" value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <div><label className="text-sm font-medium text-[var(--ink)]">Priority</label>
            <select className="input mt-1" value={priority} onChange={(e) => setPriority(e.target.value as 'low' | 'medium' | 'high')}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select></div>
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={saving || !title.trim()}>
          {saving ? 'Saving...' : editId ? 'Update' : 'Create'}
        </button>
      </form>
    </div>
  )
}
`);

  return files;
}
