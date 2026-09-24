import { useCallback, useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { q, when, type Activity as Row, type Group } from '../api'
import { Empty, GroupNav, Section } from '../components'

export function Activity({ group }: { group: Group }) {
  const [rows, setRows] = useState<Row[]>([])
  const [done, setDone] = useState(false)
  const load = useCallback(async (before?: number) => {
    const page = await q<Row>('list_activity', { group_id: group.id, before: before ?? null })
    setRows((prev) => (before ? [...prev, ...page] : page))
    setDone(page.length < 100)
  }, [group.id])
  useEffect(() => { load() }, [load])

  return (
    <Section title="Activity">
      <GroupNav group={group} current="activity" />
      {rows.length === 0 ? <Empty title="Nothing yet" description="Joins, role changes, events and RSVPs land here in the same transaction as the change." /> : null}
      <ul className="space-y-1 text-sm">
        {rows.map((a) => (
          <li key={a.id} className="border-b border-[var(--line)] py-2">
            <span className="text-[var(--muted)]">{when(a.created_at)}</span> · <strong className="text-[var(--ink)]">{a.display_name ?? a.user_id}</strong> · {a.action}
            {a.metadata && a.metadata !== '{}' ? <code className="ml-2 text-xs text-[var(--muted)]">{a.metadata}</code> : null}
          </li>
        ))}
      </ul>
      {!done ? <div className="mt-4 text-center"><Button variant="ghost" onClick={() => load(rows[rows.length - 1]?.created_at)}>Load more</Button></div> : null}
    </Section>
  )
}
