import { useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, batch } from '../api'
import { Field, Section } from '../components'
import { useWorkspace } from '../workspace'

/** First run: create a workspace (you become its admin) or join one with an invitation code. */
export function Onboarding({ join }: { join: boolean }) {
  const { select, workspaces } = useWorkspace()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const me = app.auth.user

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!me || !name.trim()) return
    setBusy(true)
    try {
      const id = crypto.randomUUID()
      const [created] = await batch('create_workspace', { workspace_id: id, name: name.trim(), display_name: me.name })
      if (!created) throw new Error('Nothing was created.')
      await select(id)
      location.hash = '#/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workspace')
    } finally {
      setBusy(false)
    }
  }

  async function accept(e: FormEvent) {
    e.preventDefault()
    if (!me || !code.trim()) return
    setBusy(true)
    try {
      const [joined] = await batch('accept_invitation', { code: code.trim(), display_name: me.name })
      if (!joined) throw new Error('That code is unknown, already used, or you are already a member.')
      // the invitation decided which workspace: reload the list and pick the newest membership
      await select('')
      location.hash = '#/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={workspaces.length ? 'Join another workspace' : 'Welcome'}>
      <div className="grid max-w-3xl grid-cols-1 gap-6 sm:grid-cols-2">
        {!join ? (
          <form onSubmit={create} className="space-y-3 rounded-[var(--radius)] border border-[var(--line)] p-4">
            <h2 className="font-semibold text-[var(--ink)]">Create a workspace</h2>
            <p className="text-sm text-[var(--muted)]">You become its admin and can invite your team.</p>
            <Field label="Name"><Input aria-label="Workspace name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Button type="submit" loading={busy}>Create</Button>
          </form>
        ) : null}
        <form onSubmit={accept} className="space-y-3 rounded-[var(--radius)] border border-[var(--line)] p-4">
          <h2 className="font-semibold text-[var(--ink)]">Join with an invitation code</h2>
          <p className="text-sm text-[var(--muted)]">Codes are single-use; your role was set by whoever invited you.</p>
          <Field label="Code"><Input aria-label="Invitation code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={busy}>Join</Button>
        </form>
      </div>
      {error ? <p role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</p> : null}
    </Section>
  )
}
