import { useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, batch, x } from '../api'
import { Field, Section } from '../components'
import { useWorkspace } from '../workspace'

export function Settings() {
  const { active, refresh, workspaces } = useWorkspace()
  const [name, setName] = useState(active?.name ?? '')
  const [display, setDisplay] = useState(app.auth.user?.name ?? '')
  const [msg, setMsg] = useState('')

  async function rename(e: FormEvent) {
    e.preventDefault()
    if (!active) return
    const [changed] = await batch('rename_workspace', { workspace_id: active.id, name: name.trim() })
    setMsg(changed ? 'Renamed.' : 'Only admins rename the workspace.')
    await refresh()
  }

  async function profile(e: FormEvent) {
    e.preventDefault()
    if (!active) return
    const changed = await x('update_my_profile', { workspace_id: active.id, display_name: display.trim() })
    setMsg(changed ? 'Saved.' : 'Nothing changed.')
  }

  async function leave() {
    if (!active || !confirm(`Leave ${active.name}?`)) return
    const changed = await x('leave_workspace', { workspace_id: active.id })
    if (!changed) { setMsg('The last admin cannot leave — hand the admin role to someone first.'); return }
    location.reload()
  }

  return (
    <Section title="Settings">
      <form onSubmit={rename} className="max-w-md space-y-3">
        <h2 className="font-semibold text-[var(--ink)]">Workspace</h2>
        <Field label="Name"><Input aria-label="Workspace name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Button type="submit" variant="secondary">Rename</Button>
      </form>

      <form onSubmit={profile} className="mt-8 max-w-md space-y-3">
        <h2 className="font-semibold text-[var(--ink)]">Your profile here</h2>
        <p className="text-sm text-[var(--muted)]">Signed in as <strong className="text-[var(--ink)]">{app.auth.user?.name}</strong>. This name is what teammates see in this workspace; nothing else about you is stored.</p>
        <Field label="Display name"><Input aria-label="Display name" required value={display} onChange={(e) => setDisplay(e.target.value)} /></Field>
        <Button type="submit" variant="secondary">Save</Button>
      </form>

      <div className="mt-8 max-w-md space-y-3">
        <h2 className="font-semibold text-[var(--ink)]">Membership</h2>
        <p className="text-sm text-[var(--muted)]">You belong to {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}. <a href="#/join" className="text-[var(--accent)] hover:underline">Create or join another</a>.</p>
        <Button variant="danger" onClick={leave}>Leave this workspace</Button>
      </div>
      {msg ? <p role="status" className="mt-4 text-sm text-[var(--muted)]">{msg}</p> : null}
    </Section>
  )
}
