import type { ReactNode, TextareaHTMLAttributes } from 'react'

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

export const selectClass = 'w-full rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-3 py-2 text-sm text-[var(--ink)]'

export function Status({ value }: { value: string }) {
  const tone: Record<string, string> = {
    draft: 'var(--muted)', submitted: 'var(--warning)', approved: 'var(--success)', closed: 'var(--sky)', rejected: 'var(--danger)',
    admin: 'var(--accent)', manager: 'var(--sky)', member: 'var(--muted)', pending: 'var(--warning)',
  }
  return (
    <span className="rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ color: tone[value] ?? 'var(--muted)', borderColor: 'var(--line)' }}>
      {value}
    </span>
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

export function Row({ children }: { children: ReactNode }) {
  return <li className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--line)] p-3">{children}</li>
}
