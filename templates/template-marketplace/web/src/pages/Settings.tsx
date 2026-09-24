import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, q, x, when } from '../api'
import { Field, Section, TextArea } from '../components'

/**
 * Safety controls. Ids are platform user ids as they appear in threads and requests
 * (paste from a conversation URL). No profile table: the platform account is the profile
 * and this app stores nothing about a person beyond what they publish (PAS-OPS-016).
 */
export function Settings() {
  const [blocks, setBlocks] = useState<{ blocked_id: string; created_at: number }[]>([])
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('spam')
  const [note, setNote] = useState('')
  const [flash, setFlash] = useState('')
  const load = () => q<{ blocked_id: string; created_at: number }>('list_blocks').then(setBlocks)
  useEffect(() => { load() }, [])

  async function block(e: FormEvent) {
    e.preventDefault()
    const changes = await x('block_user', { blocked_id: target.trim() })
    setFlash(changes ? 'Blocked. They can no longer message you or request your listings.' : 'Nothing changed.')
    setTarget('')
    await load()
  }

  async function report(e: FormEvent) {
    e.preventDefault()
    const changes = await x('report_user', { reported_id: target.trim(), reason, note })
    setFlash(changes ? 'Report sent to the app owner.' : 'Nothing changed.')
    setNote('')
  }

  return (
    <Section title="Settings">
      <p className="text-sm text-[var(--muted)]">Signed in as <strong className="text-[var(--ink)]">{app.auth.user?.name}</strong>. Your listings, requests and messages are the only data this app keeps about you; archive listings to take them off the catalogue.</p>

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Block or report</h2>
      <form className="mt-3 max-w-xl space-y-3" onSubmit={block}>
        <Field label="User id"><Input aria-label="User id" placeholder="From the conversation URL, e.g. gh:12345" required value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Reason">
            <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-3 py-2 text-sm text-[var(--ink)]">
              {['spam', 'scam', 'abuse', 'other'].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Details"><TextArea aria-label="Details" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="danger">Block</Button>
          <Button type="button" variant="secondary" onClick={(e) => report(e as unknown as FormEvent)}>Report</Button>
        </div>
      </form>
      {flash ? <p role="status" className="mt-3 text-sm text-[var(--muted)]">{flash}</p> : null}

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Blocked</h2>
      {blocks.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">Nobody.</p> : null}
      <ul className="mt-2 space-y-2">
        {blocks.map((b) => (
          <li key={b.blocked_id} className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--line)] p-3 text-sm">
            <span className="text-[var(--ink)]">{b.blocked_id} <span className="text-[var(--muted)]">· since {when(b.created_at)}</span></span>
            <Button variant="ghost" size="sm" onClick={async () => { await x('unblock_user', { blocked_id: b.blocked_id }); await load() }}>Unblock</Button>
          </li>
        ))}
      </ul>
    </Section>
  )
}
