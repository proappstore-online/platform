import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { batch, q, money, when, RECORD_TYPES, type Approval, type Member, type RecordDetail, type RecordRow } from '../api'
import { Empty, Field, Row, Section, Status, TextArea, selectClass } from '../components'
import { useWorkspace } from '../workspace'

export function Records() {
  const { active } = useWorkspace()
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<RecordRow[]>([])
  const [done, setDone] = useState(false)

  const load = useCallback(async (before?: number) => {
    if (!active) return
    const page = await q<RecordRow>('list_records', { workspace_id: active.id, type: type || null, status: status || null, q: text.trim() || null, before: before ?? null })
    setRows((prev) => (before ? [...prev, ...page] : page))
    setDone(page.length < 50)
  }, [active?.id, type, status, text])
  useEffect(() => { load() }, [load])

  return (
    <Section title="Records" action={<Button onClick={() => { location.hash = '#/records/new' }}>New record</Button>}>
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); load() }} role="search">
        <div className="min-w-48 flex-1"><Input aria-label="Search" placeholder="Search title or notes" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className={selectClass + ' w-auto'}>
          <option value="">All types</option>
          {RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass + ' w-auto'}>
          <option value="">All statuses</option>
          {['draft', 'submitted', 'approved', 'rejected', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      {rows.length === 0 ? <Empty title="No records" description="Create one; it starts as a draft you can submit for approval." /> : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <Row key={r.id}>
            <div>
              <a href={`#/records/${r.id}`} className="font-semibold text-[var(--ink)] hover:underline">{r.title}</a>
              <p className="text-xs text-[var(--muted)]">{r.type} · {money(r.amount)} · {when(r.created_at)}</p>
            </div>
            <Status value={r.status} />
          </Row>
        ))}
      </ul>
      {!done ? <div className="mt-4 text-center"><Button variant="ghost" onClick={() => load(rows[rows.length - 1]?.created_at)}>Load more</Button></div> : null}
    </Section>
  )
}

export function RecordPage({ id }: { id: string }) {
  const { active } = useWorkspace()
  const [rec, setRec] = useState<RecordDetail | null | undefined>(undefined)
  const [note, setNote] = useState('')
  const [flash, setFlash] = useState('')
  const load = useCallback(async () => {
    if (!active) return
    const [row] = await q<RecordDetail>('get_record', { id, workspace_id: active.id })
    setRec(row ?? null)
  }, [active?.id, id])
  useEffect(() => { load() }, [load])

  if (!active || rec === undefined) return <Section title="Record"><p className="text-sm text-[var(--muted)]">Loading…</p></Section>
  if (rec === null) return <Section title="Record"><Empty title="Not found" description="It may be archived or belong to another workspace." /></Section>
  const approvals = JSON.parse(rec.approvals || '[]') as Approval[]
  const pending = approvals.find((a) => a.decision === 'pending')
  const canDecide = !!pending && pending.requested_by !== rec.created_by ? true : !!pending
  const elevated = active.role === 'admin' || active.role === 'manager'

  async function run(name: string, params: Record<string, unknown>, okMsg: string) {
    const changes = await batch(name, { workspace_id: active!.id, ...params })
    setFlash(changes[0] ? okMsg : 'Nothing changed — the record moved on, or this is not allowed for your role.')
    await load()
  }

  return (
    <Section title={rec.title} action={<Status value={rec.status} />}>
      <p className="text-sm text-[var(--muted)]">{rec.type} · {money(rec.amount)} · created {when(rec.created_at)} · updated {when(rec.updated_at)}{rec.assignee_id ? ` · assigned to ${rec.assignee_id}` : ''}</p>
      {rec.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--ink)]">{rec.notes}</p> : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {rec.status === 'draft' || rec.status === 'rejected' ? <>
          <Button variant="secondary" onClick={() => { location.hash = `#/records/${id}/edit` }}>Edit</Button>
          <Button onClick={() => run('submit_record', { id, approval_id: crypto.randomUUID(), note }, 'Submitted for approval.')}>Submit for approval</Button>
        </> : null}
        {rec.status === 'approved' && elevated ? <Button onClick={() => run('close_record', { id }, 'Closed.')}>Close</Button> : null}
        {rec.status !== 'closed' ? <Button variant="danger" onClick={() => { if (confirm('Archive this record? It leaves the lists but stays in the audit trail.')) run('archive_record', { id }, 'Archived.').then(() => { location.hash = '#/records' }) }}>Archive</Button> : null}
      </div>
      {rec.status === 'draft' || rec.status === 'rejected' ? <div className="mt-3 max-w-md"><Field label="Note for the approver"><TextArea aria-label="Note for the approver" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div> : null}
      {flash ? <p role="status" className="mt-3 text-sm text-[var(--muted)]">{flash}</p> : null}

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Approvals</h2>
      {approvals.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">Not submitted yet.</p> : (
        <ul className="mt-2 space-y-2">
          {approvals.map((a) => (
            <Row key={a.id}>
              <div className="text-sm">
                <p className="text-[var(--ink)]">Requested by {a.requested_by} · {when(a.created_at)}{a.note ? ` · “${a.note}”` : ''}</p>
                {a.decided_at ? <p className="text-xs text-[var(--muted)]">Decided by {a.decided_by} · {when(a.decided_at)}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                <Status value={a.decision} />
                {a.decision === 'pending' && canDecide ? <DecideButtons approvalId={a.id} onDone={load} /> : null}
              </div>
            </Row>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function DecideButtons({ approvalId, onDone }: { approvalId: string; onDone: () => Promise<void> }) {
  const { active } = useWorkspace()
  const [msg, setMsg] = useState('')
  async function decide(decision: 'approved' | 'rejected') {
    const note = decision === 'rejected' ? prompt('Reason (shown to the requester)') ?? '' : ''
    const [changed] = await batch('decide_approval', { workspace_id: active!.id, id: approvalId, decision, note })
    setMsg(changed ? '' : 'Not allowed: you need the approve permission and cannot decide your own submission.')
    await onDone()
  }
  return (
    <>
      <Button size="sm" onClick={() => decide('approved')}>Approve</Button>
      <Button size="sm" variant="danger" onClick={() => decide('rejected')}>Reject</Button>
      {msg ? <span role="alert" className="text-xs text-[var(--danger)]">{msg}</span> : null}
    </>
  )
}

export function RecordForm({ id }: { id?: string }) {
  const { active } = useWorkspace()
  const [members, setMembers] = useState<Member[]>([])
  const [d, setD] = useState({ type: RECORD_TYPES[0] as string, title: '', amount: '', assignee_id: '', notes: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof d>) => setD((prev) => ({ ...prev, ...patch }))

  useEffect(() => {
    if (!active) return
    q<Member>('list_members', { workspace_id: active.id }).then(setMembers)
    if (!id) return
    q<RecordDetail>('get_record', { id, workspace_id: active.id }).then(([r]) => {
      if (!r) { location.hash = '#/records'; return }
      setD({ type: r.type, title: r.title, amount: r.amount === null ? '' : String(r.amount), assignee_id: r.assignee_id ?? '', notes: r.notes })
    })
  }, [active?.id, id])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!active || !d.title.trim()) return
    setBusy(true)
    setError('')
    try {
      const params = { workspace_id: active.id, title: d.title.trim(), amount: d.amount === '' ? null : Number(d.amount), assignee_id: d.assignee_id || null, notes: d.notes }
      const [changed] = id
        ? await batch('update_record', { id, ...params })
        : await batch('create_record', { id: crypto.randomUUID(), type: d.type, ...params })
      if (!changed) throw new Error('Nothing was saved. Only drafts and rejected records can be edited, by their creator or a manager.')
      location.hash = '#/records'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={id ? 'Edit record' : 'New record'}>
      <form onSubmit={submit} className="max-w-xl space-y-4">
        {!id ? <Field label="Type"><select aria-label="Type" value={d.type} onChange={(e) => set({ type: e.target.value })} className={selectClass}>{RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field> : null}
        <Field label="Title"><Input aria-label="Title" required maxLength={200} value={d.title} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Amount"><Input aria-label="Amount" type="number" step="0.01" value={d.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
        <Field label="Assignee"><select aria-label="Assignee" value={d.assignee_id} onChange={(e) => set({ assignee_id: e.target.value })} className={selectClass}><option value="">Unassigned</option>{members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name || m.user_id}</option>)}</select></Field>
        <Field label="Notes"><TextArea aria-label="Notes" rows={5} maxLength={4000} value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>{id ? 'Save' : 'Create draft'}</Button>
          <Button type="button" variant="ghost" onClick={() => { location.hash = '#/records' }}>Cancel</Button>
        </div>
      </form>
    </Section>
  )
}
