import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, batch, can, q, x, parsePermissions, when, PERMISSION_KEYS, ROLES, type Invitation, type Member } from '../api'
import { Empty, Field, Row, Section, Status, selectClass } from '../components'
import { useWorkspace } from '../workspace'

export function Team() {
  const { active, refresh } = useWorkspace()
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invitation[]>([])
  const [login, setLogin] = useState('')
  const [role, setRole] = useState('member')
  const [lastCode, setLastCode] = useState('')
  const [msg, setMsg] = useState('')
  const me = app.auth.user?.id
  const admin = active?.role === 'admin'
  const manager = can(active, 'manage_members')

  const load = useCallback(async () => {
    if (!active) return
    const p = { workspace_id: active.id }
    setMembers(await q<Member>('list_members', p))
    setInvites(await q<Invitation>('list_invitations', p))
  }, [active?.id])
  useEffect(() => { load() }, [load])

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!active) return
    const id = crypto.randomUUID()
    const changed = await x('create_invitation', { id, workspace_id: active.id, login: login.trim(), role })
    setMsg(changed ? '' : 'Only admins or members with manage_members can invite.')
    if (changed) setLastCode(id)
    setLogin('')
    await load()
  }

  async function setRoleFor(userId: string, newRole: string) {
    if (!active) return
    const [changed] = await batch('set_member_role', { workspace_id: active.id, user_id: userId, role: newRole })
    setMsg(changed ? '' : 'Only admins change roles, and never their own.')
    await load()
    await refresh()
  }

  async function togglePermission(m: Member, key: string, has: boolean) {
    if (!active) return
    const [changed] = await batch(has ? 'revoke_permission' : 'grant_permission', { workspace_id: active.id, user_id: m.user_id, key })
    setMsg(changed ? '' : 'Only admins or members with manage_members change permissions.')
    await load()
  }

  async function remove(m: Member) {
    if (!active || !confirm(`Remove ${m.display_name || m.user_id} from ${active.name}?`)) return
    const changes = await batch('remove_member', { workspace_id: active.id, user_id: m.user_id })
    setMsg(changes[1] ? '' : 'Only admins remove members, and never themselves.')
    await load()
  }

  return (
    <Section title="Team">
      <ul className="space-y-2">
        {members.map((m) => {
          const perms = parsePermissions(m.permissions)
          return (
            <Row key={m.user_id}>
              <div>
                <p className="font-semibold text-[var(--ink)]">{m.display_name || m.user_id}{m.user_id === me ? ' (you)' : ''}</p>
                <p className="text-xs text-[var(--muted)]">{m.user_id} · joined {when(m.joined_at)}</p>
                {m.role !== 'admin' ? (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {PERMISSION_KEYS.map((k) => (
                      <label key={k} className="flex items-center gap-1 text-xs text-[var(--muted)]">
                        <input aria-label={`${k} for ${m.display_name || m.user_id}`} type="checkbox" checked={perms.includes(k)} disabled={!manager} onChange={() => togglePermission(m, k, perms.includes(k))} />
                        {k}
                      </label>
                    ))}
                  </div>
                ) : <p className="mt-1 text-xs text-[var(--muted)]">admins hold every permission</p>}
              </div>
              <div className="flex items-center gap-2">
                {admin && m.user_id !== me ? (
                  <select aria-label={`Role for ${m.display_name || m.user_id}`} value={m.role} onChange={(e) => setRoleFor(m.user_id, e.target.value)} className={selectClass + ' w-auto'}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : <Status value={m.role} />}
                {admin && m.user_id !== me ? <Button size="sm" variant="danger" onClick={() => remove(m)}>Remove</Button> : null}
              </div>
            </Row>
          )
        })}
      </ul>

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Invitations</h2>
      {manager ? (
        <form onSubmit={invite} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-48"><Field label="Login (for your records)"><Input aria-label="Login" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="alice" /></Field></div>
          <Field label="Role"><select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} className={selectClass + ' w-auto'}><option value="member">member</option><option value="manager">manager</option></select></Field>
          <Button type="submit">Create invitation</Button>
        </form>
      ) : <p className="mt-2 text-sm text-[var(--muted)]">Inviting needs the manage_members permission.</p>}
      {lastCode ? <p role="status" className="mt-2 text-sm text-[var(--ink)]">Send this single-use code: <code className="rounded bg-[var(--paper-deep)] px-1.5 py-0.5">{lastCode}</code></p> : null}
      {invites.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No open invitations.</p> : (
        <ul className="mt-2 space-y-2">
          {invites.map((i) => (
            <Row key={i.id}>
              <div className="text-sm"><code className="text-[var(--ink)]">{i.id}</code> <span className="text-[var(--muted)]">· {i.login || 'anyone'} · {i.role} · {when(i.created_at)}</span></div>
              {manager ? <Button size="sm" variant="ghost" onClick={async () => { await x('revoke_invitation', { id: i.id, workspace_id: active!.id }); await load() }}>Revoke</Button> : null}
            </Row>
          ))}
        </ul>
      )}
      {members.length === 0 ? <Empty title="No members" /> : null}
      {msg ? <p role="alert" className="mt-3 text-sm text-[var(--danger)]">{msg}</p> : null}
    </Section>
  )
}
