import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Modal } from '@proappstore/sdk/ui'
import { app, batch, isMod, q, when, toLocalInput, type Event, type Group, type Rsvp } from '../api'
import { Badge, Empty, Field, GroupNav, Row, Section, TextArea } from '../components'

type Draft = { title: string; description: string; location: string; starts_at: string; ends_at: string; capacity: string }
const EMPTY: Draft = { title: '', description: '', location: '', starts_at: '', ends_at: '', capacity: '' }

function EventForm({ group, initial, eventId, onDone }: { group: Group; initial: Draft; eventId?: string; onDone: () => void }) {
  const [d, setD] = useState<Draft>(initial)
  const [error, setError] = useState('')
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }))
  async function submit(e: FormEvent) {
    e.preventDefault()
    const params = {
      group_id: group.id, title: d.title.trim(), description: d.description, location: d.location.trim(),
      starts_at: new Date(d.starts_at).getTime(), ends_at: d.ends_at ? new Date(d.ends_at).getTime() : null, capacity: d.capacity === '' ? null : Number(d.capacity),
    }
    if (!params.title || Number.isNaN(params.starts_at)) { setError('A title and a start time are needed.'); return }
    const [changed] = eventId ? await batch('update_event', { id: eventId, ...params }) : await batch('create_event', { id: crypto.randomUUID(), ...params })
    if (!changed) { setError('Not allowed: events are created by admins and moderators, edited by their creator or a moderator.'); return }
    onDone()
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Title"><Input aria-label="Title" required maxLength={120} value={d.title} onChange={(e) => set({ title: e.target.value })} /></Field>
      <Field label="Description"><TextArea aria-label="Description" rows={3} value={d.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <Field label="Location"><Input aria-label="Location" value={d.location} onChange={(e) => set({ location: e.target.value })} /></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Starts"><Input aria-label="Starts" type="datetime-local" required value={d.starts_at} onChange={(e) => set({ starts_at: e.target.value })} /></Field>
        <Field label="Ends"><Input aria-label="Ends" type="datetime-local" value={d.ends_at} onChange={(e) => set({ ends_at: e.target.value })} /></Field>
        <Field label="Capacity"><Input aria-label="Capacity" type="number" min={1} value={d.capacity} onChange={(e) => set({ capacity: e.target.value })} placeholder="unlimited" /></Field>
      </div>
      {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
      <Button type="submit">{eventId ? 'Save' : 'Create event'}</Button>
    </form>
  )
}

export function Events({ group }: { group: Group }) {
  const [rows, setRows] = useState<Event[]>([])
  const [past, setPast] = useState(false)
  const [creating, setCreating] = useState(false)
  const load = useCallback(async () => setRows(await q<Event>('list_events', { group_id: group.id, past: past ? 1 : 0 })), [group.id, past])
  useEffect(() => { load() }, [load])

  return (
    <Section title="Events" action={isMod(group) ? <Button onClick={() => setCreating(true)}>New event</Button> : undefined}>
      <GroupNav group={group} current="events" />
      <div className="mb-3 flex gap-2 text-sm">
        <button type="button" onClick={() => setPast(false)} className={`font-medium ${!past ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Upcoming</button>
        <button type="button" onClick={() => setPast(true)} className={`font-medium ${past ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Past</button>
      </div>
      {rows.length === 0 ? <Empty title={past ? 'No past events' : 'Nothing scheduled'} description={isMod(group) ? 'Create the first one.' : 'Admins and moderators create events.'} /> : null}
      <ul className="space-y-2">
        {rows.map((e) => (
          <Row key={e.id}>
            <div>
              <a href={`#/group/${group.id}/events/${e.id}`} className="font-semibold text-[var(--ink)] hover:underline">{e.title}</a>
              <p className="text-xs text-[var(--muted)]">{when(e.starts_at)}{e.location ? ` · ${e.location}` : ''} · {e.going_count} going{e.capacity ? ` of ${e.capacity}` : ''}{e.waitlist_count ? ` · ${e.waitlist_count} waitlisted` : ''}</p>
            </div>
            {e.my_status ? <Badge value={e.my_status} /> : null}
          </Row>
        ))}
      </ul>
      <Modal open={creating} onClose={() => setCreating(false)} title="New event" width={560}>
        <EventForm group={group} initial={EMPTY} onDone={() => { setCreating(false); load() }} />
      </Modal>
    </Section>
  )
}

export function EventDetail({ group, eventId }: { group: Group; eventId: string }) {
  const [event, setEvent] = useState<Event | null | undefined>(undefined)
  const [rsvps, setRsvps] = useState<Rsvp[]>([])
  const [editing, setEditing] = useState(false)
  const [msg, setMsg] = useState('')
  const me = app.auth.user?.id
  const load = useCallback(async () => {
    const [e] = await q<Event>('get_event', { id: eventId, group_id: group.id })
    setEvent(e ?? null)
    setRsvps(await q<Rsvp>('list_rsvps', { event_id: eventId }))
  }, [group.id, eventId])
  useEffect(() => { load() }, [load])

  if (event === undefined) return <Section title="Event"><p className="text-sm text-[var(--muted)]">Loading…</p></Section>
  if (event === null) return <Section title="Event"><Empty title="Not found" /></Section>
  const mayEdit = isMod(group) || event.created_by === me

  async function rsvp(status: 'going' | 'not_going') {
    const changes = await batch('rsvp_event', { id: crypto.randomUUID(), event_id: eventId, status })
    setMsg(changes[0] || changes[1] ? '' : 'RSVP not recorded.')
    await load()
  }
  async function remove() {
    if (!confirm('Delete this event and its RSVPs?')) return
    const changes = await batch('delete_event', { id: eventId, group_id: group.id })
    if (changes[1]) location.hash = `#/group/${group.id}/events`
    else setMsg('Not allowed.')
  }

  return (
    <Section title={event.title} action={event.my_status ? <Badge value={event.my_status} /> : undefined}>
      <p className="text-sm text-[var(--muted)]">{when(event.starts_at)}{event.ends_at ? ` → ${when(event.ends_at)}` : ''}{event.location ? ` · ${event.location}` : ''}</p>
      {event.description ? <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--ink)]">{event.description}</p> : null}
      <p className="mt-3 text-sm text-[var(--ink)]">{event.going_count} going{event.capacity ? ` of ${event.capacity}` : ''}{event.waitlist_count ? ` · ${event.waitlist_count} on the waitlist` : ''}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {event.my_status !== 'going' && event.my_status !== 'waitlist' ? <Button onClick={() => rsvp('going')}>{event.capacity && event.going_count >= event.capacity ? 'Join the waitlist' : "I'm going"}</Button> : <Button variant="secondary" onClick={() => rsvp('not_going')}>Can't make it</Button>}
        {mayEdit ? <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button> : null}
        {mayEdit ? <Button variant="danger" onClick={remove}>Delete</Button> : null}
        <a href={`#/group/${group.id}/events`} className="self-center text-sm text-[var(--muted)] hover:underline">All events</a>
      </div>
      {msg ? <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{msg}</p> : null}

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Who's coming</h2>
      {rsvps.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">Nobody yet.</p> : (
        <ul className="mt-2 space-y-1 text-sm">
          {rsvps.map((r) => <li key={r.user_id} className="flex items-center gap-2"><Badge value={r.status} /><span className="text-[var(--ink)]">{r.display_name ?? r.user_id}</span>{r.waitlist_position ? <span className="text-xs text-[var(--muted)]">#{r.waitlist_position}</span> : null}</li>)}
        </ul>
      )}
      <Modal open={editing} onClose={() => setEditing(false)} title="Edit event" width={560}>
        <EventForm group={group} eventId={eventId} initial={{ title: event.title, description: event.description, location: event.location, starts_at: toLocalInput(event.starts_at), ends_at: toLocalInput(event.ends_at), capacity: event.capacity === null ? '' : String(event.capacity) }} onDone={() => { setEditing(false); load() }} />
      </Modal>
    </Section>
  )
}
