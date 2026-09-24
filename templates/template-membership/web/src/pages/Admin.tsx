import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, batch, q, x, when, ROLES, type Group, type JoinCode, type Member } from '../api'
import { Badge, Field, GroupNav, Row, Section, TextArea, selectClass } from '../components'

/** Group administration: roles (admins), join codes and settings (admins and moderators). App-wide moderation lives with the app's admin role, not here. */
export function Admin({ group }: { group: Group }) {
  const [members, setMembers] = useState<Member[]>([])
  const [codes, setCodes] = useState<JoinCode[]>([])
  const [role, setRole] = useState('member')
  const [maxUses, setMaxUses] = useState('1')
  const [days, setDays] = useState('7')
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const [msg, setMsg] = useState('')
  const me = app.auth.user?.id
  const admin = group.role === 'admin'

  const load = useCallback(async () => {
    setMembers(await q<Member>('list_members', { group_id: group.id }))
    setCodes(await q<JoinCode>('list_join_codes', { group_id: group.id }))
  }, [group.id])
  useEffect(() => { load() }, [load])

  async function setMemberRole(m: Member, r: string) {
    const [changed] = await batch('set_member_role', { group_id: group.id, user_id: m.user_id, role: r })
    setMsg(changed ? '' : 'Only admins change roles, never their own.')
    await load()
  }

  async function makeCode(e: FormEvent) {
    e.preventDefault()
    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
    const changed = await x('create_join_code', { id: crypto.randomUUID(), group_id: group.id, code, role, max_uses: Number(maxUses) || 1, expires_at: days ? Date.now() + Number(days) * 86_400_000 : null })
    setMsg(changed ? `New code: ${code}` : 'Codes grant member or moderator only.')
    await load()
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const [changed] = await batch('update_group', { group_id: group.id, name: name.trim(), description, avatar_url: group.avatar_url })
    setMsg(changed ? 'Saved.' : 'Only admins edit the group.')
  }

  return (
    <Section title="Admin">
      <GroupNav group={group} current="admin" />
      <h2 className="display-font text-lg font-semibold text-[var(--ink)]">Roles</h2>
      <ul className="mt-2 space-y-2">
        {members.map((m) => (
          <Row key={m.user_id}>
            <span className="text-sm text-[var(--ink)]">{m.display_name || m.user_id}{m.user_id === me ? ' (you)' : ''}</span>
            {admin && m.user_id !== me ? (
              <select aria-label={`Role for ${m.display_name || m.user_id}`} value={m.role} onChange={(e) => setMemberRole(m, e.target.value)} className={selectClass + ' w-auto'}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            ) : <Badge value={m.role} />}
          </Row>
        ))}
      </ul>

      <h2 className="display-font mt-8 text-lg font-semibold text-[var(--ink)]">Join codes</h2>
      <form onSubmit={makeCode} className="mt-2 flex flex-wrap items-end gap-2">
        <Field label="Grants"><select aria-label="Role granted" value={role} onChange={(e) => setRole(e.target.value)} className={selectClass + ' w-auto'}><option value="member">member</option><option value="moderator">moderator</option></select></Field>
        <Field label="Uses"><Input aria-label="Maximum uses" type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} /></Field>
        <Field label="Expires in days"><Input aria-label="Expires in days" type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} placeholder="never" /></Field>
        <Button type="submit">New code</Button>
      </form>
      {codes.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No live codes.</p> : (
        <ul className="mt-2 space-y-2">
          {codes.map((c) => (
            <Row key={c.id}>
              <div className="text-sm"><code className="text-[var(--ink)]">{c.code}</code> <span className="text-[var(--muted)]">· grants {c.role} · {c.use_count}/{c.max_uses} used{c.expires_at ? ` · until ${when(c.expires_at)}` : ''}</span></div>
              <Button size="sm" variant="ghost" onClick={async () => { await x('revoke_join_code', { id: c.id, group_id: group.id }); await load() }}>Revoke</Button>
            </Row>
          ))}
        </ul>
      )}

      <h2 className="display-font mt-8 text-lg font-semibold text-[var(--ink)]">Settings</h2>
      <form onSubmit={save} className="mt-2 max-w-md space-y-3">
        <Field label="Name"><Input aria-label="Group name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><TextArea aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Button type="submit" variant="secondary">Save</Button>
      </form>
      {msg ? <p role="status" className="mt-3 text-sm text-[var(--ink)]">{msg}</p> : null}
    </Section>
  )
}
