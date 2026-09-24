import { useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { q, GROUP, type Group } from '../api'
import { Badge, Empty, Row, Section } from '../components'

export function Landing() {
  const [groups, setGroups] = useState<Group[] | null>(null)
  useEffect(() => { q<Group>('list_my_groups').then(setGroups) }, [])
  return (
    <Section title={`My ${GROUP.plural}`} action={<Button onClick={() => { location.hash = '#/onboarding' }}>Create or join</Button>}>
      {groups && groups.length === 0 ? <Empty title={`You are not in any ${GROUP.noun} yet`} description="Create one, or redeem a join code someone sent you." /> : null}
      <ul className="space-y-2">
        {(groups ?? []).map((g) => (
          <Row key={g.id}>
            <div className="flex items-center gap-3">
              {g.avatar_url ? <img src={g.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" /> : <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-soft)] font-semibold text-[var(--accent-deep)]">{g.name[0]}</span>}
              <div>
                <a href={`#/group/${g.id}`} className="font-semibold text-[var(--ink)] hover:underline">{g.name}</a>
                <p className="text-xs text-[var(--muted)]">{g.member_count} member{g.member_count === 1 ? '' : 's'}{g.description ? ` · ${g.description}` : ''}</p>
              </div>
            </div>
            <Badge value={g.role} />
          </Row>
        ))}
      </ul>
    </Section>
  )
}
