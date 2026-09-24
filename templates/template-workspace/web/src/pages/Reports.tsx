import { useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { can, q, money, toCsv, RECORD_TYPES, type RecordRow, type Stat } from '../api'
import { Section, Status, selectClass } from '../components'
import { useWorkspace } from '../workspace'

export function Reports() {
  const { active } = useWorkspace()
  const [stats, setStats] = useState<Stat[]>([])
  const [type, setType] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => { if (active) q<Stat>('record_stats', { workspace_id: active.id }).then(setStats) }, [active?.id])

  async function exportCsv() {
    if (!active) return
    // Same predicate as the list, bounded, and only with the export permission (PAS-DATA-012).
    const rows = await q<RecordRow>('export_records', { workspace_id: active.id, type: type || null })
    if (rows.length === 0) { setMsg(can(active, 'export') ? 'Nothing to export.' : 'Export needs the export permission.'); return }
    const blob = new Blob([toCsv(rows as unknown as Record<string, unknown>[])], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${active.name.replace(/\W+/g, '-').toLowerCase()}-records${type ? `-${type}` : ''}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    setMsg(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length === 500 ? ' (page limit — narrow the filter for the rest)' : ''}.`)
  }

  return (
    <Section title="Reports">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]"><th className="py-2">Status</th><th>Records</th><th>Total</th></tr></thead>
        <tbody>
          {stats.map((s) => <tr key={s.status} className="border-t border-[var(--line)]"><td className="py-2"><Status value={s.status} /></td><td>{s.count}</td><td>{money(s.total)}</td></tr>)}
          {stats.length === 0 ? <tr><td colSpan={3} className="py-4 text-[var(--muted)]">No records yet.</td></tr> : null}
        </tbody>
      </table>

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Export</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select aria-label="Type to export" value={type} onChange={(e) => setType(e.target.value)} className={selectClass + ' w-auto'}>
          <option value="">All types</option>
          {RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Button variant="secondary" onClick={exportCsv}>Download CSV</Button>
      </div>
      {msg ? <p role="status" className="mt-2 text-sm text-[var(--muted)]">{msg}</p> : null}
    </Section>
  )
}
