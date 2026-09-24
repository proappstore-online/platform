import { useCallback, useEffect, useState } from 'react'
import { app, can, q, money, when, type PendingApproval } from '../api'
import { Empty, Row, Section } from '../components'
import { useWorkspace } from '../workspace'
import { DecideButtons } from './Records'

export function Approvals() {
  const { active } = useWorkspace()
  const [rows, setRows] = useState<PendingApproval[]>([])
  const load = useCallback(async () => { if (active) setRows(await q<PendingApproval>('list_pending_approvals', { workspace_id: active.id })) }, [active?.id])
  useEffect(() => { load() }, [load])
  const me = app.auth.user?.id
  const approver = can(active, 'approve')

  return (
    <Section title="Approvals">
      {!approver ? <p className="mb-4 text-sm text-[var(--muted)]">You can see the queue; deciding needs the <code>approve</code> permission (ask an admin).</p> : null}
      {rows.length === 0 ? <Empty title="Queue is empty" /> : null}
      <ul className="space-y-2">
        {rows.map((a) => (
          <Row key={a.id}>
            <div>
              <a href={`#/records/${a.record_id}`} className="font-semibold text-[var(--ink)] hover:underline">{a.title}</a>
              <p className="text-xs text-[var(--muted)]">{a.type} · {money(a.amount)} · by {a.requested_by_name ?? a.requested_by} · {when(a.created_at)}{a.note ? ` · “${a.note}”` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              {approver && a.requested_by !== me ? <DecideButtons approvalId={a.id} onDone={load} /> : <span className="text-xs text-[var(--muted)]">{a.requested_by === me ? 'your submission' : ''}</span>}
            </div>
          </Row>
        ))}
      </ul>
    </Section>
  )
}
