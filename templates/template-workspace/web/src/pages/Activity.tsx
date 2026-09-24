import { useCallback, useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { q, when, type Activity as Row } from '../api'
import { Empty, Section } from '../components'
import { useWorkspace } from '../workspace'

export function Activity() {
  const { active } = useWorkspace()
  const [rows, setRows] = useState<Row[]>([])
  const [done, setDone] = useState(false)
  const load = useCallback(async (before?: number) => {
    if (!active) return
    const page = await q<Row>('list_activity', { workspace_id: active.id, before: before ?? null })
    setRows((prev) => (before ? [...prev, ...page] : page))
    setDone(page.length < 100)
  }, [active?.id])
  useEffect(() => { load() }, [load])

  return (
    <Section title="Activity">
      <p className="mb-4 text-sm text-[var(--muted)]">Every write in this workspace lands here in the same transaction as the change itself.</p>
      {rows.length === 0 ? <Empty title="Nothing yet" /> : null}
      <ul className="space-y-1 text-sm">
        {rows.map((a) => (
          <li key={a.id} className="border-b border-[var(--line)] py-2">
            <span className="text-[var(--muted)]">{when(a.created_at)}</span> · <strong className="text-[var(--ink)]">{a.user_name ?? a.user_id}</strong> · {a.action}
            {a.entity_type === 'record' ? <> · <a href={`#/records/${a.entity_id}`} className="text-[var(--accent)] hover:underline">record</a></> : <> · {a.entity_type} {a.entity_id}</>}
            {a.changes && a.changes !== '{}' ? <code className="ml-2 text-xs text-[var(--muted)]">{a.changes}</code> : null}
          </li>
        ))}
      </ul>
      {!done ? <div className="mt-4 text-center"><Button variant="ghost" onClick={() => load(rows[rows.length - 1]?.created_at)}>Load more</Button></div> : null}
    </Section>
  )
}
