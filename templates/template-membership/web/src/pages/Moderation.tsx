import { useEffect, useState } from 'react'
import { AdminConsole, useAction, useAdminContext, type ActionError } from '@proappstore/sdk'
import { Button } from '@proappstore/sdk/ui'
import { app } from '../api'
import { Empty, Row, Section } from '../components'

interface ModeratedGroup { id: string; slug: string; name: string; created_by: string; created_at: number; member_count: number }

/**
 * App-wide moderation, a custom admin panel (platform#299). It reaches data only
 * through admin_list_groups / admin_delete_group, which the platform runs for
 * holders of the app role `admin` and refuses for everyone else; the role check
 * here only decides what to render.
 */
export function Moderation() {
  return <AdminConsole app={app}><Dashboard /></AdminConsole>
}

function Dashboard() {
  const { roles, session } = useAdminContext()
  const listGroups = useAction<Record<string, never>, { rows: ModeratedGroup[] }>('admin_list_groups')
  const deleteGroup = useAction<{ group_id: string }, { results: unknown[] }>('admin_delete_group')
  const [groups, setGroups] = useState<ModeratedGroup[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const isAdmin = roles.includes('admin')

  // A failed list is an error, not "no groups" (#344); a successful reload clears a stale delete error.
  const load = () => listGroups()
    .then((r) => { setGroups(r.rows); setLoadFailed(false); deleteGroup.reset() })
    .catch(() => setLoadFailed(true))
  // Load once the role is known. An invoker changes identity with its own state, so it is not a dependency.
  useEffect(() => { if (isAdmin) void load() }, [isAdmin])

  async function remove(g: ModeratedGroup) {
    if (!confirm(`Delete ${g.name} and everything in it? This cannot be undone.`)) return
    await deleteGroup({ group_id: g.id }).then(load).catch(() => {})
  }

  if (session.status === 'pending' || (session.status === 'signed-in' && !session.rolesLoaded)) {
    return <Section title="Moderation"><p className="text-sm text-[var(--muted)]">One moment.</p></Section>
  }
  if (!isAdmin) {
    return <Section title="Moderation"><Empty title="Admins only" description="App-wide moderation needs the app role admin, granted by the app's owner." /></Section>
  }
  const error = deleteGroup.error ?? listGroups.error
  return (
    <Section title="Moderation">
      {error ? <p role="alert" className="mb-3 text-sm text-[var(--danger)]">{explain(error)}</p> : null}
      {loadFailed ? <Button size="sm" variant="ghost" disabled={listGroups.pending} onClick={() => void load()}>Retry</Button> : null}
      {groups === null ? (loadFailed ? null : <p className="text-sm text-[var(--muted)]">Loading groups…</p>) : groups.length === 0 ? <Empty title="No groups yet" /> : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <Row key={g.id}>
              <div className="text-sm"><span className="font-semibold text-[var(--ink)]">{g.name}</span> <span className="text-[var(--muted)]">· {g.member_count} members · /{g.slug}</span></div>
              <Button size="sm" variant="ghost" disabled={deleteGroup.pending} onClick={() => remove(g)}>Delete</Button>
            </Row>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** The server is the authority: a refusal names why. */
function explain(e: Error): string {
  const err = e as ActionError
  if (err.forbidden) return "The platform refused: you don't hold the app role admin any more."
  // A step_up action needs a passkey check on this site (#337): signing in again would be refused again.
  if (err.needsPasskey) return 'This needs a passkey check on this site. Confirm with your passkey, then retry.'
  if (err.stepUpRequired) return 'This needs a recent sign-in. Sign in again, then retry.'
  return 'Something went wrong. Try again.'
}
