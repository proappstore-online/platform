import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, q, x, type Group } from '../api'
import { Field, Row, Section } from '../components'

/** No profile table: the platform account is the identity; each group stores only the display name you set there. */
export function Profile() {
  const [groups, setGroups] = useState<Group[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const me = app.auth.user
  useEffect(() => {
    q<Group>('list_my_groups').then(async (list) => {
      setGroups(list)
      const entries = await Promise.all(list.map(async (g) => {
        const members = await q<{ user_id: string; display_name: string }>('list_members', { group_id: g.id })
        return [g.id, members.find((m) => m.user_id === me?.id)?.display_name ?? ''] as const
      }))
      setNames(Object.fromEntries(entries))
    })
  }, [me?.id])

  async function save(e: FormEvent, g: Group) {
    e.preventDefault()
    const changed = await x('update_my_profile', { group_id: g.id, display_name: (names[g.id] ?? '').trim() })
    setMsg(changed ? `Saved for ${g.name}.` : 'Nothing changed.')
  }

  return (
    <Section title="Profile">
      <p className="text-sm text-[var(--muted)]">Signed in as <strong className="text-[var(--ink)]">{me?.name}</strong>. Your display name can differ per group; nothing else about you is stored by this app.</p>
      <ul className="mt-4 max-w-xl space-y-2">
        {groups.map((g) => (
          <Row key={g.id}>
            <form onSubmit={(e) => save(e, g)} className="flex w-full flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1"><Field label={g.name}><Input aria-label={`Display name in ${g.name}`} value={names[g.id] ?? ''} onChange={(e) => setNames({ ...names, [g.id]: e.target.value })} /></Field></div>
              <Button type="submit" variant="secondary" size="sm">Save</Button>
            </form>
          </Row>
        ))}
      </ul>
      {msg ? <p role="status" className="mt-3 text-sm text-[var(--muted)]">{msg}</p> : null}
    </Section>
  )
}
