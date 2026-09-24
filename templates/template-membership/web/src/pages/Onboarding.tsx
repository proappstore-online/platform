import { useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, batch, slugify, GROUP } from '../api'
import { Field, Section, TextArea } from '../components'

export function Onboarding() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
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
      const [created] = await batch('create_group', { group_id: id, slug: `${slugify(name)}-${id.slice(0, 6)}`, name: name.trim(), description, display_name: me.name })
      if (!created) throw new Error('Nothing was created.')
      location.hash = `#/group/${id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create')
    } finally {
      setBusy(false)
    }
  }

  async function join(e: FormEvent) {
    e.preventDefault()
    if (!me || !code.trim()) return
    setBusy(true)
    try {
      const [joined] = await batch('join_group_by_code', { code: code.trim(), display_name: me.name })
      if (!joined) throw new Error('That code is unknown, expired, used up — or you are already a member.')
      location.hash = '#/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={`Create or join a ${GROUP.noun}`}>
      <div className="grid max-w-3xl grid-cols-1 gap-6 sm:grid-cols-2">
        <form onSubmit={create} className="space-y-3 rounded-[var(--radius)] border border-[var(--line)] p-4">
          <h2 className="font-semibold text-[var(--ink)]">Create</h2>
          <p className="text-sm text-[var(--muted)]">You become its admin and can hand out join codes.</p>
          <Field label="Name"><Input aria-label="Group name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description"><TextArea aria-label="Description" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Button type="submit" loading={busy}>Create</Button>
        </form>
        <form onSubmit={join} className="space-y-3 rounded-[var(--radius)] border border-[var(--line)] p-4">
          <h2 className="font-semibold text-[var(--ink)]">Join with a code</h2>
          <p className="text-sm text-[var(--muted)]">Codes are limited-use and may expire; your role was chosen by whoever made the code.</p>
          <Field label="Join code"><Input aria-label="Join code" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit" variant="secondary" loading={busy}>Join</Button>
        </form>
      </div>
      {error ? <p role="alert" className="mt-4 text-sm text-[var(--danger)]">{error}</p> : null}
    </Section>
  )
}
