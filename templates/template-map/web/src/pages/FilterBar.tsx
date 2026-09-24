import { Button, Input } from '@proappstore/sdk/ui'
import type { Category } from '../api'
import { selectClass } from '../components'

export interface FilterValues { q: string; category_id: string }

export function FilterBar({ value, onChange, categories, onLocate, locating, extra }: { value: FilterValues; onChange: (v: FilterValues) => void; categories: Category[]; onLocate?: () => void; locating?: boolean; extra?: React.ReactNode }) {
  return (
    <form role="search" onSubmit={(e) => e.preventDefault()} className="flex flex-wrap items-center gap-2">
      <div className="min-w-40 flex-1"><Input aria-label="Search" placeholder="Search name, description or address" value={value.q} onChange={(e) => onChange({ ...value, q: e.target.value })} /></div>
      <select aria-label="Category" value={value.category_id} onChange={(e) => onChange({ ...value, category_id: e.target.value })} className={selectClass + ' w-auto'}>
        <option value="">All categories</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
      </select>
      {onLocate ? <Button type="button" variant="secondary" size="sm" loading={locating} onClick={onLocate}>Near me</Button> : null}
      {extra}
    </form>
  )
}
