/**
 * Marketplace template — two-sided listings (poster/seeker).
 * Pattern extracted from: jobs, carsads, room-rent, clean-up
 *
 * Features: browse with search/filter, detail page, create listing,
 * saved listings, applications/bookings.
 *
 * Data access: every user-facing read/write goes through registered actions
 * (mcp.json → app.actions.call). Raw app.db SQL is restricted to the app's
 * team by the platform, so seeding raw SQL would ship an app that 403s for
 * every regular user. Identity comes from :__user_id server-side; privileged
 * reads (listing applications) carry owner EXISTS guards in the SQL itself.
 */
export function marketplaceFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();

  files.set('src/lib/app.ts', `import { initPro } from '@proappstore/sdk'
export const app = initPro({ appId: '${slug}' })
`);

  files.set('src/types.ts', `export interface Listing {
  id: string
  user_id: string
  title: string
  description: string
  category: string
  location: string
  price: number
  status: 'active' | 'closed'
  created_at: number
}

export interface Application {
  id: string
  user_id: string
  listing_id: string
  message: string
  status: 'pending' | 'accepted' | 'rejected'
  created_at: number
}
`);

  files.set('mcp.json', `{
  "tools": [
    {
      "name": "list_listings",
      "description": "Active listings, newest first, with optional search and category filter",
      "operation": "query",
      "sql": "SELECT * FROM listings WHERE status = 'active' AND (:category IS NULL OR category = :category) AND (:search IS NULL OR title LIKE '%' || :search || '%' OR description LIKE '%' || :search || '%') ORDER BY created_at DESC LIMIT 50",
      "params": {
        "search": { "type": "string", "optional": true },
        "category": { "type": "string", "optional": true }
      },
      "requires_auth": true
    },
    {
      "name": "get_listing",
      "description": "One listing by id",
      "operation": "query",
      "sql": "SELECT * FROM listings WHERE id = :id",
      "params": { "id": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "create_listing",
      "description": "Create a listing owned by the caller",
      "operation": "execute",
      "sql": "INSERT INTO listings (id, user_id, title, description, category, location, price, status, created_at) VALUES (:id, :__user_id, :title, :description, :category, :location, :price, 'active', :__now)",
      "params": {
        "id": { "type": "string" },
        "title": { "type": "string" },
        "description": { "type": "string", "optional": true },
        "category": { "type": "string", "optional": true },
        "location": { "type": "string", "optional": true },
        "price": { "type": "integer" }
      },
      "requires_auth": true
    },
    {
      "name": "list_my_listings",
      "description": "The caller's own listings, newest first",
      "operation": "query",
      "sql": "SELECT * FROM listings WHERE user_id = :__user_id ORDER BY created_at DESC",
      "params": {},
      "requires_auth": true
    },
    {
      "name": "save_listing",
      "description": "Save a listing for the caller",
      "operation": "execute",
      "sql": "INSERT OR IGNORE INTO saved_listings (user_id, listing_id, saved_at) VALUES (:__user_id, :listing_id, :__now)",
      "params": { "listing_id": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "unsave_listing",
      "description": "Remove a listing from the caller's saved list",
      "operation": "execute",
      "sql": "DELETE FROM saved_listings WHERE user_id = :__user_id AND listing_id = :listing_id",
      "params": { "listing_id": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "list_saved_listings",
      "description": "Listings the caller has saved, most recently saved first",
      "operation": "query",
      "sql": "SELECT l.* FROM listings l JOIN saved_listings s ON s.listing_id = l.id WHERE s.user_id = :__user_id ORDER BY s.saved_at DESC",
      "params": {},
      "requires_auth": true
    },
    {
      "name": "apply_to_listing",
      "description": "Apply to a listing as the caller",
      "operation": "execute",
      "sql": "INSERT INTO applications (id, user_id, listing_id, message, status, created_at) VALUES (:id, :__user_id, :listing_id, :message, 'pending', :__now)",
      "params": {
        "id": { "type": "string" },
        "listing_id": { "type": "string" },
        "message": { "type": "string", "optional": true }
      },
      "requires_auth": true
    },
    {
      "name": "list_applications",
      "description": "Applications for a listing (listing owner only), newest first",
      "operation": "query",
      "sql": "SELECT a.* FROM applications a WHERE a.listing_id = :listing_id AND EXISTS (SELECT 1 FROM listings l WHERE l.id = :listing_id AND l.user_id = :__user_id) ORDER BY a.created_at DESC",
      "params": { "listing_id": { "type": "string" } },
      "requires_auth": true
    }
  ]
}
`);

  files.set('src/lib/db.ts', `import { app } from './app'
import type { Listing, Application } from '../types'

const MIGRATIONS = [
  {
    name: '0001_init',
    sql: \`
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT, category TEXT, location TEXT, price INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','closed')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);
      CREATE TABLE IF NOT EXISTS saved_listings (
        user_id TEXT NOT NULL, listing_id TEXT NOT NULL, saved_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, listing_id)
      );
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, listing_id TEXT NOT NULL,
        message TEXT, status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
        created_at INTEGER NOT NULL, UNIQUE(user_id, listing_id)
      );
      CREATE INDEX IF NOT EXISTS idx_apps_listing ON applications(listing_id);
    \`
  }
]

// Raw SQL (including migrate) is team-only on PAS. Regular users get a 403
// here — that's fine: the schema is already applied, so swallow it and
// continue. Every user-facing read/write below goes through registered
// actions (mcp.json), never raw SQL.
export async function migrate() {
  try {
    await app.db.migrate(MIGRATIONS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes('403')) throw err
  }
}

async function q<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await app.actions.call<{ rows: T[] }>(name, params)
  return res.rows
}

async function x(name: string, params: Record<string, unknown> = {}): Promise<void> {
  await app.actions.call(name, params)
}

export async function listListings(opts?: { search?: string; category?: string }) {
  return q<Listing>('list_listings', { search: opts?.search ?? null, category: opts?.category ?? null })
}

export async function getListing(id: string) {
  return (await q<Listing>('get_listing', { id }))[0] ?? null
}

export async function createListing(data: Pick<Listing, 'title' | 'description' | 'category' | 'location' | 'price'>) {
  const id = crypto.randomUUID()
  await x('create_listing', { id, title: data.title, description: data.description, category: data.category, location: data.location, price: data.price })
  return id
}

export async function getMyListings() {
  return q<Listing>('list_my_listings')
}

export async function saveListing(listingId: string) {
  await x('save_listing', { listing_id: listingId })
}

export async function unsaveListing(listingId: string) {
  await x('unsave_listing', { listing_id: listingId })
}

export async function getSavedListings() {
  return q<Listing>('list_saved_listings')
}

export async function applyToListing(listingId: string, message: string) {
  const id = crypto.randomUUID()
  await x('apply_to_listing', { id, listing_id: listingId, message })
  return id
}

export async function getApplications(listingId: string) {
  return q<Application>('list_applications', { listing_id: listingId })
}
`);

  files.set('src/App.tsx', `import { useState, useEffect } from 'react'
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
import { Avatar, ThemeToggle } from '@proappstore/sdk/ui'
import { app } from './lib/app'
import { migrate } from './lib/db'
import { Browse } from './pages/Browse'
import { Detail } from './pages/Detail'
import { Create } from './pages/Create'

type Route = { page: 'browse' } | { page: 'detail'; id: string } | { page: 'create' } | { page: 'saved' } | { page: 'my-listings' }

function parseHash(): Route {
  const h = location.hash.slice(1)
  if (h.startsWith('/listing/')) return { page: 'detail', id: h.slice(9) }
  if (h === '/create') return { page: 'create' }
  if (h === '/saved') return { page: 'saved' }
  if (h === '/my-listings') return { page: 'my-listings' }
  return { page: 'browse' }
}

export default function App() {
  const { user, loading } = useProAuth(app)
  const { theme } = useTheme()
  const [route, setRoute] = useState<Route>(parseHash)
  const [ready, setReady] = useState(false)

  useEffect(() => { const h = () => setRoute(parseHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  useEffect(() => { if (user) migrate().then(() => setReady(true)).catch(() => setReady(true)) }, [user])

  if (loading) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Loading...</div>
  if (!user) return (
    <div className="min-h-[100dvh] flex items-center justify-center">
      <div className="card text-center space-y-4 max-w-sm">
        <h1 className="text-xl font-bold text-[var(--ink-strong)] display-font">${slug}</h1>
        <p className="text-muted">Sign in to get started</p>
        <button onClick={() => app.auth.signIn('github')} className="btn btn-primary w-full">Sign in with GitHub</button>
        <button onClick={() => app.auth.signIn('google')} className="btn btn-secondary w-full">Sign in with Google</button>
      </div>
    </div>
  )
  if (!ready) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Setting up...</div>

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <button onClick={() => { window.location.hash = '#/' }} className="font-bold text-[var(--ink)] display-font">${slug}</button>
          <nav className="flex items-center gap-3 text-sm">
            <a href="#/" className="text-[var(--muted)] hover:text-[var(--ink)]">Browse</a>
            <a href="#/saved" className="text-[var(--muted)] hover:text-[var(--ink)]">Saved</a>
            <a href="#/my-listings" className="text-[var(--muted)] hover:text-[var(--ink)]">My Listings</a>
            <a href="#/create" className="btn btn-primary text-xs">Post</a>
            <ThemeToggle />
            <Avatar user={user} size={28} />
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        {route.page === 'browse' && <Browse userId={user.id} />}
        {route.page === 'detail' && <Detail id={route.id} userId={user.id} />}
        {route.page === 'create' && <Create userId={user.id} />}
        {route.page === 'saved' && <Browse userId={user.id} savedOnly />}
        {route.page === 'my-listings' && <Browse userId={user.id} myOnly />}
      </main>
    </div>
  )
}
`);

  files.set('src/pages/Browse.tsx', `import { useState, useEffect } from 'react'
import type { Listing } from '../types'
import { listListings, getSavedListings, getMyListings } from '../lib/db'

const CATEGORIES = ['Services', 'Jobs', 'Housing', 'For Sale', 'Events', 'Other']

export function Browse({ userId, savedOnly, myOnly }: { userId: string; savedOnly?: boolean; myOnly?: boolean }) {
  const [items, setItems] = useState<Listing[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const load = savedOnly ? () => getSavedListings()
      : myOnly ? () => getMyListings()
      : () => listListings({ search: search || undefined, category: category || undefined })
    load().then(setItems).finally(() => setLoading(false))
  }, [search, category, savedOnly, myOnly, userId])

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-[var(--ink-strong)]">
        {savedOnly ? 'Saved' : myOnly ? 'My Listings' : 'Browse Listings'}
      </h2>
      {!savedOnly && !myOnly && (
        <div className="flex gap-2 flex-wrap">
          <input className="input flex-1 min-w-[200px]" placeholder="Search..." value={search}
            onChange={(e) => setSearch(e.target.value)} />
          <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
      {loading ? <p className="text-muted">Loading...</p> : items.length === 0 ? (
        <div className="empty-state"><h3>No listings found</h3><p>Try adjusting your search or filters.</p></div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <a key={item.id} href={'#/listing/' + item.id} className="card hover:border-[var(--accent)] transition-colors block">
              <div className="flex justify-between items-start">
                <h3 className="font-semibold text-[var(--ink-strong)]">{item.title}</h3>
                {item.price > 0 && <span className="badge badge-accent">{'$' + item.price}</span>}
              </div>
              <p className="text-sm text-muted line-clamp-2 mt-1">{item.description}</p>
              <div className="flex gap-2 mt-2 text-xs text-muted">
                {item.category && <span className="badge badge-accent">{item.category}</span>}
                {item.location && <span>{item.location}</span>}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
`);

  files.set('src/pages/Detail.tsx', `import { useState, useEffect } from 'react'
import type { Listing } from '../types'
import { getListing, saveListing, unsaveListing, applyToListing } from '../lib/db'

export function Detail({ id, userId }: { id: string; userId: string }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [saved, setSaved] = useState(false)
  const [message, setMessage] = useState('')
  const [applied, setApplied] = useState(false)

  useEffect(() => { getListing(id).then(setListing) }, [id])

  if (!listing) return <p className="text-muted">Loading...</p>

  const isOwner = listing.user_id === userId
  const toggleSave = async () => {
    if (saved) { await unsaveListing(id); setSaved(false) }
    else { await saveListing(id); setSaved(true) }
  }

  const handleApply = async () => {
    await applyToListing(id, message)
    setApplied(true)
  }

  return (
    <div className="max-w-2xl space-y-4">
      <a href="#/" className="text-sm text-[var(--accent)] hover:underline">&larr; Back</a>
      <h1 className="text-2xl font-bold text-[var(--ink-strong)]">{listing.title}</h1>
      <div className="flex gap-2 text-sm text-muted">
        {listing.category && <span className="badge badge-accent">{listing.category}</span>}
        {listing.location && <span>{listing.location}</span>}
        {listing.price > 0 && <span className="font-semibold text-[var(--ink)]">{'$' + listing.price}</span>}
      </div>
      <p className="text-[var(--ink)] leading-relaxed whitespace-pre-wrap">{listing.description}</p>
      <div className="flex gap-2">
        {!isOwner && <button onClick={toggleSave} className="btn btn-secondary">{saved ? 'Unsave' : 'Save'}</button>}
      </div>
      {!isOwner && !applied && (
        <div className="card space-y-3">
          <h3 className="font-semibold text-[var(--ink-strong)]">Apply / Respond</h3>
          <textarea className="input min-h-[80px]" placeholder="Add a message..." value={message}
            onChange={(e) => setMessage(e.target.value)} />
          <button onClick={handleApply} className="btn btn-primary">Submit</button>
        </div>
      )}
      {applied && <p className="text-[var(--success)] font-semibold">Application submitted!</p>}
    </div>
  )
}
`);

  files.set('src/pages/Create.tsx', `import { useState } from 'react'
import { createListing } from '../lib/db'

const CATEGORIES = ['Services', 'Jobs', 'Housing', 'For Sale', 'Events', 'Other']

export function Create({ userId }: { userId: string }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [loc, setLoc] = useState('')
  const [price, setPrice] = useState(0)
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    const id = await createListing({ title, description, category, location: loc, price })
    window.location.hash = '#/listing/' + id
  }

  return (
    <div className="max-w-lg">
      <a href="#/" className="text-sm text-[var(--accent)] hover:underline">&larr; Back</a>
      <h2 className="text-lg font-bold text-[var(--ink-strong)] mt-4 mb-4">Create Listing</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-sm font-medium text-[var(--ink)]">Title *</label>
          <input className="input mt-1" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div>
          <label className="text-sm font-medium text-[var(--ink)]">Description</label>
          <textarea className="input mt-1 min-h-[100px]" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium text-[var(--ink)]">Category</label>
            <select className="input mt-1" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Select...</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-[var(--ink)]">Price</label>
            <input type="number" className="input mt-1" value={price} onChange={(e) => setPrice(Number(e.target.value))} min={0} />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium text-[var(--ink)]">Location</label>
          <input className="input mt-1" value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="e.g. Sydney, AU" />
        </div>
        <button type="submit" className="btn btn-primary w-full" disabled={saving || !title.trim()}>
          {saving ? 'Creating...' : 'Create Listing'}
        </button>
      </form>
    </div>
  )
}
`);

  return files;
}
