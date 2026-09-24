import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, isMod, q, x, when, ROOMS_THREAD, THREAD_POLL_MS, type Group, type Message } from '../api'
import { Empty, GroupNav, Section } from '../components'

export function Messages({ group }: { group: Group }) {
  const [rows, setRows] = useState<Message[]>([])
  const [done, setDone] = useState(false)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const me = app.auth.user?.id
  const load = useCallback(async (before?: number) => {
    const page = await q<Message>('list_messages', { group_id: group.id, before: before ?? null })
    setRows((prev) => (before ? [...prev, ...page] : page))
    setDone(page.length < 50)
  }, [group.id])
  useEffect(() => {
    load()
    // ROOMS_THREAD: swap this poll for an app.rooms subscription that calls load() on each message.
    if (ROOMS_THREAD) return
    const t = setInterval(() => load(), THREAD_POLL_MS)
    return () => clearInterval(t)
  }, [load])

  async function post(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    const changed = await x('post_message', { id: crypto.randomUUID(), group_id: group.id, content: text.trim() })
    if (!changed) { setMsg('Not posted.'); return }
    setText('')
    setMsg('')
    await load()
  }
  async function remove(m: Message) {
    const changed = await x('delete_message', { id: m.id, group_id: group.id })
    setMsg(changed ? '' : 'Only the author, admins and moderators delete messages.')
    await load()
  }

  return (
    <Section title="Thread">
      <GroupNav group={group} current="messages" />
      <form onSubmit={post} className="mb-4 flex gap-2">
        <div className="flex-1"><Input aria-label="Message" placeholder={`Say something to ${group.name}`} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <Button type="submit">Post</Button>
      </form>
      {msg ? <p role="alert" className="mb-2 text-sm text-[var(--danger)]">{msg}</p> : null}
      {rows.length === 0 ? <Empty title="No messages yet" /> : null}
      <ul className="space-y-2">
        {rows.map((m) => (
          <li key={m.id} className="rounded-[var(--radius-sm)] border border-[var(--line)] p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
              <span><strong className="text-[var(--ink)]">{m.display_name ?? m.user_id}</strong> · {when(m.created_at)}</span>
              {m.user_id === me || isMod(group) ? <button type="button" onClick={() => remove(m)} className="text-[var(--danger)] hover:underline">Delete</button> : null}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--ink)]">{m.content}</p>
          </li>
        ))}
      </ul>
      {!done ? <div className="mt-4 text-center"><Button variant="ghost" onClick={() => load(rows[rows.length - 1]?.created_at)}>Older</Button></div> : null}
    </Section>
  )
}
