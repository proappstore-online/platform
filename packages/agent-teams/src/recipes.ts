/**
 * Recipe library — pre-built code patterns that agents can reference instead
 * of generating boilerplate from scratch. Injected into the Dev prompt via
 * read_docs when the topic matches a recipe name.
 *
 * Each recipe is a complete, copy-paste-ready code snippet using the PAS SDK,
 * design system CSS classes, and pre-installed libraries (lucide-react,
 * date-fns, react-i18next).
 */

export const RECIPES: Record<string, { title: string; description: string; code: string }> = {

  'crud-list': {
    title: 'CRUD List + Detail',
    description: 'Fetch rows from app.db, render a list with cards, click to view detail.',
    code: `// src/components/ItemList.tsx
import { useState, useEffect } from 'react'
import { app } from '../App'
import { Plus, ChevronRight } from 'lucide-react'

interface Item { id: string; title: string; created_at: string }

export function ItemList({ onSelect }: { onSelect: (id: string) => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    app.db.query<Item>('SELECT * FROM items ORDER BY created_at DESC')
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
}`,
  },

  'form-create': {
    title: 'Create Form with Validation',
    description: 'Form to create a new DB row with inline validation.',
    code: `// src/components/CreateItemForm.tsx
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
      await app.db.execute(
        'INSERT INTO items (id, title, user_id, created_at) VALUES (:__uuid, ?, :__user_id, :__now)',
        [title.trim()]
      )
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
}`,
  },

  'search-filter': {
    title: 'Search + Filter + Sort',
    description: 'Search bar with debounce, category filter, sort dropdown.',
    code: `// src/components/SearchBar.tsx
import { useState, useEffect, useRef } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'

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
}`,
  },

  'modal': {
    title: 'Modal / Dialog',
    description: 'Accessible modal with backdrop, escape to close, focus trap.',
    code: `// src/components/Modal.tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function Modal({ open, onClose, title, children }: Props) {
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
        <button onClick={onClose} className="btn btn-ghost p-1" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  )
}`,
  },

  'file-upload': {
    title: 'File Upload with Preview',
    description: 'Upload images/files to app.storage with drag-drop and preview.',
    code: `// src/components/FileUpload.tsx
import { useState, useRef } from 'react'
import { app } from '../App'
import { Upload, X, Image } from 'lucide-react'

export function FileUpload({ onUploaded }: { onUploaded: (url: string) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setPreview(URL.createObjectURL(file))
    setUploading(true)
    try {
      await app.storage.uploadPublic(\`uploads/\${Date.now()}-\${file.name}\`, file, file.type)
      const url = app.storage.publicUrl(\`uploads/\${Date.now()}-\${file.name}\`)
      onUploaded(url)
    } catch { /* handle error */ }
    setUploading(false)
  }

  return (
    <div className="card space-y-3">
      {preview ? (
        <div className="relative">
          <img src={preview} alt="" className="w-full rounded-lg max-h-48 object-cover" />
          <button onClick={() => { setPreview(null) }} className="absolute top-2 right-2 btn btn-ghost bg-black/50 text-white p-1">
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
}`,
  },

  'data-table': {
    title: 'Data Table with Pagination',
    description: 'Sortable table with pagination for DB query results.',
    code: `// src/components/DataTable.tsx
import { useState } from 'react'
import { ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react'

interface Column<T> { key: keyof T; label: string; sortable?: boolean }

interface Props<T> {
  data: T[]
  columns: Column<T>[]
  pageSize?: number
}

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

  const toggleSort = (key: keyof T) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(true) }
  }

  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] bg-[var(--panel-hover)]">
            {columns.map(col => (
              <th key={String(col.key)} className="text-left px-4 py-2 font-semibold text-[var(--muted)]">
                {col.sortable ? (
                  <button onClick={() => toggleSort(col.key)} className="flex items-center gap-1 hover:text-[var(--ink)]">
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
}`,
  },

  'tabs': {
    title: 'Tab Navigation',
    description: 'Accessible tab switcher with active state.',
    code: `// src/components/Tabs.tsx
interface Tab { key: string; label: string }

export function Tabs({ tabs, active, onChange }: { tabs: Tab[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-[var(--line-strong)] p-0.5 w-fit" role="tablist">
      {tabs.map(t => (
        <button key={t.key} role="tab" aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={\`px-3 py-1.5 text-sm font-semibold rounded-md transition-colors \${
            active === t.key ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }\`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}`,
  },

  'i18n-setup': {
    title: 'i18n Setup (react-i18next)',
    description: 'Multi-language setup with language switcher.',
    code: `// src/lib/i18n.ts
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
// { "greeting": "Hello", "save": "Save", "cancel": "Cancel", "loading": "Loading..." }`,
  },

  'icons': {
    title: 'Common Icons (lucide-react)',
    description: 'Pre-installed icon library. Import by name, never use emoji.',
    code: `// lucide-react is pre-installed. Import icons by name:
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
// Colors: always via className, never via color prop`,
  },
};

/** Get a recipe by name, or list all available recipes. */
export function getRecipe(name?: string): string {
  if (!name) {
    return 'Available recipes (use read_docs with the recipe name):\n' +
      Object.entries(RECIPES).map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  }
  const r = RECIPES[name.toLowerCase().replace(/\s+/g, '-')];
  if (!r) return `Recipe "${name}" not found. Available: ${Object.keys(RECIPES).join(', ')}`;
  return `# Recipe: ${r.title}\n${r.description}\n\n${r.code}`;
}
