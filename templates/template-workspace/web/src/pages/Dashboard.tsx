import { useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { q, money, when, type Activity, type PendingApproval, type Stat } from '../api'
import { Empty, Section, Status } from '../components'
import { useWorkspace } from '../workspace'

export function Dashboard() {
  const { active } = useWorkspace()
  const [stats, setStats] = useState<Stat[]>([])
  const [queue, setQueue] = useState<PendingApproval[]>([])
  const [recent, setRecent] = useState<Activity[]>([])
  useEffect(() => {
    if (!active) return
    const p = { workspace_id: active.id }
    q<Stat>('record_stats', p).then(setStats)
    q<PendingApproval>('list_pending_approvals', p).then(setQueue)
    q<Activity>('list_activity', p).then((rows) => setRecent(rows.slice(0, 8)))
  }, [active?.id])

  return (
    <Section title={active?.name ?? 'Dashboard'} action={<Button onClick={() => { location.hash = '#/records/new' }}>New record</Button>}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(['draft', 'submitted', 'approved', 'rejected', 'closed'] as const).map((s) => {
          const row = stats.find((r) => r.status === s)
          return (
            <div key={s} className="rounded-[var(--radius)] border border-[var(--line)] p-3">
              <Status value={s} />
              <p className="mt-2 text-2xl font-semibold text-[var(--ink)]">{row?.count ?? 0}</p>
              <p className="text-xs text-[var(--muted)]">{money(row?.total ?? 0)}</p>
            </div>
          )
        })}
      </div>

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Awaiting approval</h2>
      {queue.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">Nothing waiting.</p> : (
        <ul className="mt-2 space-y-2">
          {queue.slice(0, 5).map((a) => (
            <li key={a.id} className="text-sm"><a href={`#/records/${a.record_id}`} className="font-semibold text-[var(--ink)] hover:underline">{a.title}</a> <span className="text-[var(--muted)]">· {a.type} · {money(a.amount)} · by {a.requested_by_name ?? a.requested_by}</span></li>
          ))}
          {queue.length > 5 ? <li><a href="#/approvals" className="text-sm text-[var(--accent)] hover:underline">See all {queue.length}</a></li> : null}
        </ul>
      )}

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Recent activity</h2>
      {recent.length === 0 ? <Empty title="No activity yet" description="Every change in this workspace is recorded here." /> : (
        <ul className="mt-2 space-y-1 text-sm">
          {recent.map((a) => <li key={a.id}><span className="text-[var(--muted)]">{when(a.created_at)}</span> · <strong className="text-[var(--ink)]">{a.user_name ?? a.user_id}</strong> · {a.action} <span className="text-[var(--muted)]">{a.entity_type} {a.entity_id.slice(0, 8)}</span></li>)}
        </ul>
      )}
    </Section>
  )
}
