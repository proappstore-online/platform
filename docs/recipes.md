# Recipes

Pre-built code patterns for ProAppStore apps. Copy, paste, and adapt — each recipe uses the PAS SDK, the design system CSS classes, and pre-installed libraries (lucide-react, date-fns, react-i18next).

AI agents: use the `recipe` MCP tool to fetch any recipe programmatically.

## Data & CRUD

**crud-list** — CRUD List + Detail

Fetch rows through a registered app action, render a list with cards, click to
view detail.

```
// src/components/ItemList.tsx
import { useState, useEffect } from 'react'
import { app } from '../App'
import { Plus, ChevronRight } from 'lucide-react'

interface Item { id: string; title: string; created_at: string }

export function ItemList({ onSelect }: { onSelect: (id: string) => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    app.actions.call<{ rows: Item[] }>('list_items', { limit: 50 })
      .then(r => setItems(r.rows))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="empty-state"><p>Loading...</p></div>
  if (items.length === 0) return (
    <div className="empty-state">
      <h3>No items yet</h3>
      <p>Create your first item to get started.</p>
    </div>
  )

  return (
    <div className="space-y-2">
      {items.map(item => (
        <button key={item.id} onClick={() => onSelect(item.id)}
          className="card w-full text-left flex items-center justify-between">
          <span className="font-medium text-[var(--ink)]">{item.title}</span>
          <ChevronRight size={16} className="text-[var(--muted)]" />
        </button>
      ))}
    </div>
  )
}
```


**form-create** — Create Form with Validation

Form to create a row through a registered app action with inline validation.

```
// src/components/CreateItemForm.tsx
import { useState } from 'react'
import { app } from '../App'
import { Save, X } from 'lucide-react'

export function CreateItemForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { setError('Title is required'); return }
    setSaving(true); setError('')
    try {
      await app.actions.call('create_item', { title: title.trim() })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-[var(--ink)]">Title</span>
        <input value={title} onChange={e => setTitle(e.target.value)}
          className="input mt-1" placeholder="Enter title..." autoFocus />
      </label>
      {error && <p className="text-sm text-[var(--error)]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn btn-primary">
          <Save size={14} /> {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" onClick={onDone} className="btn btn-ghost">
          <X size={14} /> Cancel
        </button>
      </div>
    </form>
  )
}
```

Register those actions in the repo root `mcp.json`:

```json
{
  "tools": [
    {
      "name": "list_items",
      "description": "List the signed-in user's items",
      "operation": "query",
      "sql": "SELECT id, title, created_at FROM items WHERE user_id = :__user_id ORDER BY created_at DESC LIMIT :limit",
      "params": {
        "limit": { "type": "integer", "default": 50, "max": 100, "optional": true }
      },
      "requires_auth": true
    },
    {
      "name": "create_item",
      "description": "Create an item for the signed-in user",
      "operation": "execute",
      "sql": "INSERT INTO items (id, title, user_id, created_at) VALUES (:__uuid, :title, :__user_id, :__now)",
      "params": {
        "title": { "type": "string" }
      },
      "requires_auth": true
    }
  ]
}
```


**data-table** — Data Table with Pagination

Sortable table with pagination for loaded rows.

```
// src/components/DataTable.tsx
import { useState } from 'react'
import { ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react'

interface Column<T> { key: keyof T; label: string; sortable?: boolean }
interface Props<T> { data: T[]; columns: Column<T>[]; pageSize?: number }

export function DataTable<T extends Record<string, unknown>>({ data, columns, pageSize = 10 }: Props<T>) {
  const [page, setPage] = useState(0)
  const [sortKey, setSortKey] = useState<keyof T | null>(null)
  const [sortAsc, setSortAsc] = useState(true)

  const sorted = sortKey
    ? [...data].sort((a, b) => {
        const va = String(a[sortKey] ?? ''), vb = String(b[sortKey] ?? '')
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      })
    : data
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize)
  const totalPages = Math.ceil(data.length / pageSize)

  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] bg-[var(--panel-hover)]">
            {columns.map(col => (
              <th key={String(col.key)} className="text-left px-4 py-2 font-semibold text-[var(--muted)]">
                {col.sortable ? (
                  <button onClick={() => sortKey === col.key ? setSortAsc(!sortAsc) : (setSortKey(col.key), setSortAsc(true))}
                    className="flex items-center gap-1 hover:text-[var(--ink)]">
                    {col.label} <ArrowUpDown size={12} />
                  </button>
                ) : col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paged.map((row, i) => (
            <tr key={i} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--panel-hover)]">
              {columns.map(col => (
                <td key={String(col.key)} className="px-4 py-2 text-[var(--ink)]">{String(row[col.key] ?? '')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--line)] text-xs text-[var(--muted)]">
          <span>Page {page + 1} of {totalPages}</span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="btn btn-ghost p-1 disabled:opacity-30"><ChevronLeft size={14} /></button>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="btn btn-ghost p-1 disabled:opacity-30"><ChevronRight size={14} /></button>
          </div>
        </div>
      )}
    </div>
  )
}
```

## UI Patterns

**search-filter** — Search + Filter + Sort

Search bar with debounce, category filter, sort dropdown.

```
// src/components/SearchBar.tsx
import { useState, useEffect, useRef } from 'react'
import { Search } from 'lucide-react'

interface Props {
  onSearch: (query: string, sort: string, filter: string) => void
  categories?: string[]
}

export function SearchBar({ onSearch, categories = [] }: Props) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('newest')
  const [filter, setFilter] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onSearch(query, sort, filter), 300)
    return () => clearTimeout(timer.current)
  }, [query, sort, filter, onSearch])

  return (
    <div className="flex flex-wrap gap-2">
      <div className="flex-1 min-w-[200px] relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input value={query} onChange={e => setQuery(e.target.value)}
          className="input pl-9" placeholder="Search..." />
      </div>
      {categories.length > 0 && (
        <select value={filter} onChange={e => setFilter(e.target.value)} className="input w-auto">
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <select value={sort} onChange={e => setSort(e.target.value)} className="input w-auto">
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="name">Name A-Z</option>
      </select>
    </div>
  )
}
```


**modal** — Modal / Dialog

Accessible modal with backdrop, escape to close, focus trap.

```
// src/components/Modal.tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

export function Modal({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])
  if (!open) return null
  return (
    <dialog ref={ref} onClose={onClose}
      className="backdrop:bg-black/50 bg-[var(--paper)] text-[var(--ink)] rounded-2xl border border-[var(--line)] shadow-xl max-w-lg w-full p-0 m-auto">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--line)]">
        <h2 className="font-bold text-[var(--ink)]">{title}</h2>
        <button onClick={onClose} className="btn btn-ghost p-1" aria-label="Close"><X size={18} /></button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  )
}
```


**tabs** — Tab Navigation

Accessible tab switcher with active state.

```
// src/components/Tabs.tsx
interface Tab { key: string; label: string }

export function Tabs({ tabs, active, onChange }: {
  tabs: Tab[]; active: string; onChange: (key: string) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-[var(--line-strong)] p-0.5 w-fit" role="tablist">
      {tabs.map(t => (
        <button key={t.key} role="tab" aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${
            active === t.key ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}
```


**icons** — Common Icons (lucide-react)

Pre-installed icon library. Import by name, never use emoji.

```
import {
  // Navigation
  Home, ArrowLeft, ChevronRight, ChevronDown, Menu, X, ExternalLink,
  // Actions
  Plus, Pencil, Trash2, Save, Copy, Download, Upload, Search, Filter,
  // Status
  Check, CheckCircle2, AlertTriangle, AlertCircle, Info, Loader2,
  // Content
  MapPin, Calendar, Clock, User, Users, Heart, Star, MessageSquare,
  // Media
  Image, Camera, FileText, Paperclip,
  // UI
  Settings, SlidersHorizontal, Eye, EyeOff, Lock, Unlock, Bell,
  // Money
  DollarSign, CreditCard, Receipt,
} from 'lucide-react'

// Usage: <MapPin size={16} className="text-[var(--muted)]" />
// Sizes: 14-16 for inline, 20-24 for buttons, 40-48 for empty states
```

## SDK Features

**file-upload** — File Upload with Preview (app.storage)

Upload images/files to app.storage with drag-drop and preview.

```
// src/components/FileUpload.tsx
import { useState, useRef } from 'react'
import { app } from '../App'
import { Upload, X } from 'lucide-react'

export function FileUpload({ onUploaded }: { onUploaded: (url: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setPreview(URL.createObjectURL(file))
    setUploading(true)
    try {
      await app.storage.uploadPublic(`uploads/${Date.now()}-${file.name}`, file, file.type)
      const url = app.storage.publicUrl(`uploads/${Date.now()}-${file.name}`)
      onUploaded(url)
    } catch { /* handle error */ }
    setUploading(false)
  }

  return (
    <div className="card space-y-3">
      {preview ? (
        <div className="relative">
          <img src={preview} alt="" className="w-full rounded-lg max-h-48 object-cover" />
          <button onClick={() => setPreview(null)} className="absolute top-2 right-2 btn btn-ghost bg-black/50 text-white p-1">
            <X size={16} />
          </button>
        </div>
      ) : (
        <button onClick={() => inputRef.current?.click()}
          className="w-full py-8 border-2 border-dashed border-[var(--line)] rounded-xl text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors">
          <Upload size={24} className="mx-auto mb-2" />
          <span className="text-sm">{uploading ? 'Uploading...' : 'Click to upload'}</span>
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
    </div>
  )
}
```


**maps-autocomplete** — Address Autocomplete (app.maps)

Location input with debounced geocode, dropdown results, lat/lng capture.

```
// src/components/LocationInput.tsx
import { useState, useEffect, useRef } from 'react'
import { app } from '../App'
import { MapPin, Loader2 } from 'lucide-react'

interface Result { lat: number; lng: number; displayName: string }

export function LocationInput({ onSelect }: { onSelect: (r: Result) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); setOpen(false); return }
    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await app.maps.geocode(query, 5)
        setResults(r); setOpen(r.length > 0)
      } catch { setResults([]) }
      setLoading(false)
    }, 400)
    return () => clearTimeout(timer.current)
  }, [query])

  return (
    <div className="relative">
      <div className="relative">
        <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <input value={query} onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          className="input pl-9" placeholder="Search address..." />
        {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--muted)]" />}
      </div>
      {open && (
        <ul className="absolute z-50 w-full mt-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg max-h-48 overflow-y-auto">
          {results.map((r, i) => (
            <li key={i}>
              <button className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--panel-hover)] text-[var(--ink)]"
                onClick={() => { setQuery(r.displayName); setOpen(false); onSelect(r) }}>
                {r.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```


**map-embed** — Map Embed + Route (app.maps)

Embed an OpenStreetMap iframe and show driving directions.

```
// Embed a map (no API key, free forever):
function MapView({ lat, lng }: { lat: number; lng: number }) {
  return (
    <iframe
      src={app.maps.embedUrl(lat, lng, 15)}
      className="w-full h-64 rounded-lg border border-[var(--line)]"
      title="Map"
    />
  )
}

// Static map tile (for thumbnails, no JS needed):
// <img src={app.maps.staticUrl(lat, lng, 15)} alt="Map" />

// Driving route between two points:
// const route = await app.maps.route(from, to)
// route.geometry, route.distanceMeters, route.durationSeconds
```


**realtime-chat** — Real-time Chat Room (app.rooms)

WebSocket chat room with presence, message history, and typing indicator.

```
// src/components/ChatRoom.tsx
import { useState, useEffect, useRef } from 'react'
import { app } from '../App'
import { useProAuth } from '@proappstore/sdk/hooks'
import { Send, Users } from 'lucide-react'

export function ChatRoom({ roomId }: { roomId: string }) {
  const { user } = useProAuth(app)
  const [messages, setMessages] = useState<{ user: string; text: string; at: number }[]>([])
  const [input, setInput] = useState('')
  const [peers, setPeers] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user) return
    const room = app.rooms.join(roomId)
    room.onMessage((msg) => {
      if (msg.type === 'chat') {
        setMessages(prev => [...prev.slice(-100), { user: msg.user, text: msg.text, at: msg.at }])
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    })
    room.onPeers((p) => setPeers(p.length))
    return () => room.close()
  }, [roomId, user])

  const send = () => {
    if (!input.trim() || !user) return
    app.rooms.join(roomId).send({ type: 'chat', user: user.login, text: input.trim(), at: Date.now() })
    setInput('')
  }

  return (
    <div className="card flex flex-col h-96">
      <div className="flex items-center justify-between pb-2 border-b border-[var(--line)]">
        <span className="font-semibold text-[var(--ink)]">Chat</span>
        <span className="badge badge-accent"><Users size={12} /> {peers} online</span>
      </div>
      <div className="flex-1 overflow-y-auto py-2 space-y-2">
        {messages.map((m, i) => (
          <div key={i} className="text-sm">
            <span className="font-bold text-[var(--accent)]">{m.user}: </span>
            <span className="text-[var(--ink)]">{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 pt-2 border-t border-[var(--line)]">
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          className="input" placeholder="Type a message..." />
        <button onClick={send} className="btn btn-primary"><Send size={14} /></button>
      </div>
    </div>
  )
}
```


**ai-chat** — AI Chat Interface (app.ai)

Multi-turn chat with server-side AI (Workers AI). System prompt + history.

```
// src/components/AIChat.tsx
import { useState } from 'react'
import { app } from '../App'
import { Send, Bot, User, Loader2 } from 'lucide-react'

interface Message { role: 'user' | 'assistant'; content: string }

export function AIChat({ systemPrompt = 'You are a helpful assistant.' }: { systemPrompt?: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const send = async () => {
    if (!input.trim() || loading) return
    const userMsg: Message = { role: 'user', content: input.trim() }
    const history = [...messages, userMsg]
    setMessages(history); setInput(''); setLoading(true)
    try {
      const { text } = await app.ai.chat([
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ])
      setMessages([...history, { role: 'assistant', content: text }])
    } catch {
      setMessages([...history, { role: 'assistant', content: 'Sorry, something went wrong.' }])
    }
    setLoading(false)
  }

  return (
    <div className="card flex flex-col h-[500px]">
      <div className="flex-1 overflow-y-auto space-y-3 p-2">
        {messages.length === 0 && <p className="text-center text-[var(--muted)] py-8">Ask me anything!</p>}
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
            {m.role === 'assistant' && <Bot size={18} className="text-[var(--accent)] mt-1 flex-shrink-0" />}
            <div className={`rounded-xl px-3 py-2 max-w-[80%] text-sm ${
              m.role === 'user' ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel-hover)] text-[var(--ink)]'
            }`}>{m.content}</div>
            {m.role === 'user' && <User size={18} className="text-[var(--muted)] mt-1 flex-shrink-0" />}
          </div>
        ))}
        {loading && <div className="flex gap-2"><Bot size={18} className="text-[var(--accent)]" /><Loader2 size={16} className="animate-spin text-[var(--muted)]" /></div>}
      </div>
      <div className="flex gap-2 pt-2 border-t border-[var(--line)]">
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          disabled={loading} className="input" placeholder="Message..." />
        <button onClick={send} disabled={loading} className="btn btn-primary"><Send size={14} /></button>
      </div>
    </div>
  )
}
```


**notifications** — Push Notifications (app.notifications)

Subscribe to push, send to users, notification bell with count.

```
// src/components/NotificationBell.tsx
import { app } from '../App'
import { useProNotifications } from '@proappstore/sdk/hooks'
import { Bell, BellOff } from 'lucide-react'

export function NotificationBell() {
  const { permission, isSubscribed, subscribe, unsubscribe, loading } = useProNotifications(app)
  if (permission === 'denied') return null
  return (
    <button onClick={isSubscribed ? unsubscribe : subscribe} disabled={loading}
      className="btn btn-ghost p-1.5" title={isSubscribed ? 'Disable notifications' : 'Enable notifications'}>
      {isSubscribed ? <Bell size={18} className="text-[var(--accent)]" /> : <BellOff size={18} className="text-[var(--muted)]" />}
    </button>
  )
}

// Send to a user:  await app.notifications.send('user-123', { title: 'Hey!', body: '...' })
// Broadcast:       await app.notifications.broadcast({ title: 'Update', body: '...' })
```


**roles-rbac** — Role-Based Access Control (app.roles)

Assign roles, check permissions, gate UI by role.

```
// Built-in RBAC — never roll your own roles table
const isMod = await app.roles.check('moderator')
await app.roles.assign('user-456', 'editor')     // owner only
await app.roles.revoke('user-456', 'editor')
const myRoles = await app.roles.myRoles()         // ['member', 'editor']

// Gate UI by role:
function AdminPanel() {
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => { app.roles.check('moderator').then(setIsAdmin) }, [])
  if (!isAdmin) return null
  return <div className="card">Admin-only content</div>
}
```


**kv-preferences** — User Preferences (app.kv)

Per-user settings stored in KV with React state sync.

```
// src/hooks/usePreferences.ts
import { useState, useEffect, useCallback } from 'react'
import { app } from '../App'

interface Prefs { theme: 'light' | 'dark' | 'system'; notifications: boolean; language: string }
const DEFAULTS: Prefs = { theme: 'system', notifications: true, language: 'en' }

export function usePreferences() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    app.kv.get('preferences').then((v) => { if (v) setPrefs(v) })
      .finally(() => setLoading(false))
  }, [])

  const update = useCallback(async (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    await app.kv.set('preferences', next)
  }, [prefs])

  return { prefs, update, loading }
}
```


**stripe-paywall** — Subscription Paywall (app.subscription)

Gate premium features behind a Stripe subscription.

```
// src/components/ProGate.tsx
import { useProGate } from '@proappstore/sdk/hooks'
import { app } from '../App'
import { Lock, Sparkles } from 'lucide-react'

export function ProGate({ children }: { children: React.ReactNode }) {
  const { gate, user, signIn, upgrade } = useProGate(app, { allowFree: false })

  if (gate === 'loading') return <div className="empty-state"><p>Loading...</p></div>
  if (gate === 'signed-out') return (
    <div className="empty-state">
      <Lock size={40} className="mx-auto mb-2 text-[var(--muted)]" />
      <h3>Sign in required</h3>
      <button onClick={signIn} className="btn btn-primary mt-3">Sign in</button>
    </div>
  )
  if (gate === 'no-subscription') return (
    <div className="empty-state">
      <Sparkles size={40} className="mx-auto mb-2 text-[var(--accent)]" />
      <h3>Pro feature</h3>
      <button onClick={() => upgrade()} className="btn btn-primary mt-3">Upgrade to Pro</button>
    </div>
  )
  return <>{children}</>
}
```


**email-send** — Transactional Email (app.email)

Send confirmation/notification emails (100/day free).

```
// Send a transactional email (must be app owner or editor):
await app.email.send(
  'alice@example.com',
  'Your reservation is confirmed',
  '<h1>Confirmed!</h1><p>Your reservation for June 1 is all set.</p>',
)

// With reply-to:
await app.email.send(
  'bob@example.com',
  'Password reset',
  '<p>Click <a href="...">here</a> to reset your password.</p>',
  { replyTo: 'support@myapp.com' },
)

// Limits: 100 emails/day per app, 200 char subject, 50KB body.
```

## i18n

**i18n-setup** — i18n Setup (react-i18next)

Multi-language setup with language switcher.

```
// src/lib/i18n.ts
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../locales/en.json'

i18next.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: localStorage.getItem('lang') || 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18next

// To add a language: create src/locales/xx.json, import and add to resources.
// In components: import { useTranslation } from 'react-i18next'
// const { t } = useTranslation(); <p>{t('greeting')}</p>

// src/locales/en.json
// { "greeting": "Hello", "save": "Save", "cancel": "Cancel", "loading": "Loading..." }
```
