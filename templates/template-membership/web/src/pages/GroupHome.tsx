import { useEffect, useState } from 'react'
import { q, when, type Activity, type Event, type Group, type Message } from '../api'
import { GroupNav, Section } from '../components'

export function GroupHome({ group }: { group: Group }) {
  const [events, setEvents] = useState<Event[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [activity, setActivity] = useState<Activity[]>([])
  useEffect(() => {
    const p = { group_id: group.id }
    q<Event>('list_events', p).then((rows) => setEvents(rows.slice(0, 3)))
    q<Message>('list_messages', p).then((rows) => setMessages(rows.slice(0, 3)))
    q<Activity>('list_activity', p).then((rows) => setActivity(rows.slice(0, 5)))
  }, [group.id])

  return (
    <Section title={group.name}>
      <GroupNav group={group} current="" />
      {group.description ? <p className="text-sm text-[var(--ink)]">{group.description}</p> : null}
      <p className="mt-1 text-xs text-[var(--muted)]">{group.member_count} member{group.member_count === 1 ? '' : 's'} · you are {group.role}</p>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
        <div>
          <h2 className="display-font text-lg font-semibold text-[var(--ink)]">Next up</h2>
          {events.length === 0 ? <p className="mt-1 text-sm text-[var(--muted)]">No upcoming events.</p> : (
            <ul className="mt-1 space-y-1 text-sm">{events.map((e) => <li key={e.id}><a href={`#/group/${group.id}/events/${e.id}`} className="font-medium text-[var(--ink)] hover:underline">{e.title}</a> <span className="text-[var(--muted)]">· {when(e.starts_at)}</span></li>)}</ul>
          )}
        </div>
        <div>
          <h2 className="display-font text-lg font-semibold text-[var(--ink)]">Thread</h2>
          {messages.length === 0 ? <p className="mt-1 text-sm text-[var(--muted)]">Quiet so far.</p> : (
            <ul className="mt-1 space-y-1 text-sm">{messages.map((m) => <li key={m.id}><strong className="text-[var(--ink)]">{m.display_name ?? m.user_id}</strong> <span className="text-[var(--muted)]">{m.content.slice(0, 80)}</span></li>)}</ul>
          )}
          <a href={`#/group/${group.id}/messages`} className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline">Open the thread</a>
        </div>
        <div>
          <h2 className="display-font text-lg font-semibold text-[var(--ink)]">Activity</h2>
          {activity.length === 0 ? <p className="mt-1 text-sm text-[var(--muted)]">Nothing yet.</p> : (
            <ul className="mt-1 space-y-1 text-sm">{activity.map((a) => <li key={a.id}><span className="text-[var(--muted)]">{when(a.created_at)}</span> · {a.display_name ?? a.user_id} · {a.action}</li>)}</ul>
          )}
        </div>
      </div>
    </Section>
  )
}
