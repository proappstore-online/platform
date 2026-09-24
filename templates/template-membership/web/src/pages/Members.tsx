import { useCallback, useEffect, useState } from 'react'
import { Button } from '@proappstore/sdk/ui'
import { app, batch, isMod, q, x, when, type Group, type Member } from '../api'
import { Badge, Empty, GroupNav, Row, Section } from '../components'

export function Members({ group }: { group: Group }) {
  const [members, setMembers] = useState<Member[]>([])
  const [msg, setMsg] = useState('')
  const me = app.auth.user?.id
  const load = useCallback(async () => setMembers(await q<Member>('list_members', { group_id: group.id })), [group.id])
  useEffect(() => { load() }, [load])

  async function remove(m: Member) {
    if (!confirm(`Remove ${m.display_name || m.user_id}?`)) return
    const changes = await batch('remove_member', { group_id: group.id, user_id: m.user_id })
    setMsg(changes[1] ? '' : 'Not allowed: moderators remove members only; admins remove anyone but themselves.')
    await load()
  }

  async function leave() {
    if (!confirm(`Leave ${group.name}?`)) return
    const changed = await x('leave_group', { group_id: group.id })
    if (!changed) { setMsg('The last admin cannot leave — promote someone first.'); return }
    location.hash = '#/'
  }

  return (
    <Section title="Members" action={<Button variant="ghost" onClick={leave}>Leave</Button>}>
      <GroupNav group={group} current="members" />
      {members.length === 0 ? <Empty title="Nobody here" /> : null}
      <ul className="space-y-2">
        {members.map((m) => (
          <Row key={m.user_id}>
            <div>
              <p className="font-semibold text-[var(--ink)]">{m.display_name || m.user_id}{m.user_id === me ? ' (you)' : ''}</p>
              <p className="text-xs text-[var(--muted)]">{m.user_id} · joined {when(m.joined_at)}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge value={m.role} />
              {isMod(group) && m.user_id !== me ? <Button size="sm" variant="danger" onClick={() => remove(m)}>Remove</Button> : null}
            </div>
          </Row>
        ))}
      </ul>
      {isMod(group) ? <p className="mt-3 text-xs text-[var(--muted)]">Roles and join codes are managed in <a href={`#/group/${group.id}/admin`} className="text-[var(--accent)] hover:underline">Admin</a>.</p> : null}
      {msg ? <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{msg}</p> : null}
    </Section>
  )
}
