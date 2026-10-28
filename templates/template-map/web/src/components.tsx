import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { ActionError, imageUrl, type Category, type Place } from './api'

export function Section({ title, action, children, flush }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={flush ? 'w-full' : 'mx-auto w-full max-w-5xl px-4 py-6 sm:px-6'}>
      {flush ? null : (
        <div className="mb-4 flex items-end justify-between gap-4">
          <h1 className="display-font text-2xl font-semibold text-ink">{title}</h1>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function TextArea({ 'aria-label': label, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { 'aria-label': string }) {
  return (
    <textarea
      aria-label={label}
      {...rest}
      className="w-full rounded-pas-sm border border-line-strong bg-panel-strong px-3 py-2 text-sm text-ink outline-none focus:border-accent"
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}

export const selectClass = 'w-full rounded-pas-sm border border-line-strong bg-panel-strong px-3 py-2 text-sm text-ink'

export function Badge({ value, color }: { value: string; color?: string }) {
  const tone: Record<string, string> = { active: 'var(--success)', hidden: 'var(--muted)' }
  return (
    <span className="rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ color: color ?? tone[value] ?? 'var(--muted)', borderColor: 'var(--line)' }}>
      {value}
    </span>
  )
}

/** Loading, empty, offline, denied and error states share one shape so every screen has all of them. */
export function State({ kind, title, description, action }: { kind: 'loading' | 'empty' | 'offline' | 'denied' | 'error'; title?: string; description?: string; action?: ReactNode }) {
  const defaults: Record<typeof kind, { title: string; description: string }> = {
    loading: { title: 'Loading…', description: 'Fetching the latest records.' },
    empty: { title: 'Nothing here yet', description: 'No records match. Clear the filters or add the first one.' },
    offline: { title: "You're offline", description: 'Records will load when the connection is back. Map tiles may be missing until then.' },
    denied: { title: 'Not allowed', description: "Your account doesn't have permission for this. Ask an admin for the editor role." },
    error: { title: 'Something went wrong', description: 'The request failed. Try again in a moment.' },
  }
  const d = defaults[kind]
  return (
    <div role={kind === 'loading' ? 'status' : 'alert'} aria-live="polite" data-state={kind} className="rounded-pas border border-dashed border-line-strong p-8 text-center">
      <p className="font-semibold text-ink">{title ?? d.title}</p>
      <p className="mt-1 text-sm text-muted">{description ?? d.description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** Map an ActionError to the right state kind. */
export function stateFor(e: unknown): 'offline' | 'denied' | 'error' {
  if (e instanceof ActionError) return e.offline ? 'offline' : e.denied ? 'denied' : 'error'
  return 'error'
}

export function PlaceCard({ place, category, selected, onSelect }: { place: Place; category?: Category; selected?: boolean; onSelect?: () => void }) {
  return (
    <li>
      <a
        href={`#/p/${place.id}`}
        onClick={onSelect ? (e) => { e.preventDefault(); onSelect() } : undefined}
        aria-current={selected ? 'true' : undefined}
        className={`flex gap-3 rounded-pas-sm border p-3 hover:bg-panel ${selected ? 'border-accent' : 'border-line'}`}
      >
        {place.image_key ? <img src={imageUrl(place.image_key)} alt="" className="h-14 w-14 shrink-0 rounded-pas-sm object-cover" /> : <span aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center rounded-pas-sm bg-paper-deep text-xl">{category?.icon || '📍'}</span>}
        <span className="min-w-0">
          <span className="block truncate font-semibold text-ink">{place.name}</span>
          <span className="block truncate text-xs text-muted">{[category?.name, place.address].filter(Boolean).join(' · ') || `${place.lat.toFixed(3)}, ${place.lng.toFixed(3)}`}</span>
          {place.status === 'hidden' ? <span className="mt-1 inline-block"><Badge value="hidden" /></span> : null}
        </span>
      </a>
    </li>
  )
}
