import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { Card } from '@proappstore/sdk/ui'
import { images, imageUrl, money, type Listing } from './api'

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <h1 className="display-font text-2xl font-semibold text-[var(--ink)]">{title}</h1>
        {action}
      </div>
      {children}
    </section>
  )
}

export function TextArea({ 'aria-label': label, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { 'aria-label': string }) {
  return (
    <textarea
      aria-label={label}
      {...rest}
      className="w-full rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</span>
      {children}
    </label>
  )
}

export function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating} out of 5`} className="text-[var(--warning)]">
      {'★'.repeat(Math.round(rating))}
      <span className="text-[var(--line-strong)]">{'★'.repeat(5 - Math.round(rating))}</span>
    </span>
  )
}

export function Status({ value }: { value: string }) {
  const tone: Record<string, string> = {
    active: 'var(--success)', accepted: 'var(--success)', completed: 'var(--sky)',
    pending: 'var(--warning)', paused: 'var(--muted)', declined: 'var(--danger)', cancelled: 'var(--muted)', archived: 'var(--muted)',
  }
  return (
    <span className="rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ color: tone[value] ?? 'var(--muted)', borderColor: 'var(--line)' }}>
      {value}
    </span>
  )
}

export function ListingCard({ listing, saved, onToggleSave }: { listing: Listing; saved?: boolean; onToggleSave?: () => void }) {
  const [cover] = images(listing)
  return (
    <Card padding="0">
      <a href={`#/l/${listing.id}`} className="block">
        <div className="aspect-[4/3] w-full overflow-hidden rounded-t-[var(--radius)] bg-[var(--paper-deep)]">
          {cover ? <img src={imageUrl(cover)} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-semibold text-[var(--ink)]">{listing.title}</h2>
            {onToggleSave ? (
              <button
                type="button"
                aria-label={saved ? 'Remove from saved' : 'Save'}
                aria-pressed={saved}
                onClick={(e) => { e.preventDefault(); onToggleSave() }}
                className="text-lg leading-none"
                style={{ color: saved ? 'var(--accent)' : 'var(--muted)' }}
              >
                {saved ? '♥' : '♡'}
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">{[listing.category, listing.location].filter(Boolean).join(' · ')}</p>
          <p className="mt-2 text-sm font-semibold text-[var(--ink)]">{money(listing)}</p>
        </div>
      </a>
    </Card>
  )
}

export function Empty({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] p-8 text-center">
      <p className="font-semibold text-[var(--ink)]">{title}</p>
      {description ? <p className="mt-1 text-sm text-[var(--muted)]">{description}</p> : null}
    </div>
  )
}
