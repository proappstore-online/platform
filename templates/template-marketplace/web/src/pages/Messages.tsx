import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input } from '@proappstore/sdk/ui'
import { app, pub, q, x, when, type Conversation, type Listing, type Message } from '../api'
import { Empty, Section } from '../components'

export function Conversations() {
  const [rows, setRows] = useState<Conversation[] | null>(null)
  useEffect(() => { q<Conversation>('list_conversations').then(setRows) }, [])
  return (
    <Section title="Messages">
      {rows && rows.length === 0 ? <Empty title="No conversations" description="Message an owner from a listing, or reply to a request from your inbox." /> : null}
      <ul className="space-y-2">
        {(rows ?? []).map((c) => (
          <li key={`${c.listing_id}:${c.other_id}`}>
            <a href={`#/messages/${c.listing_id}/${c.other_id}`} className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--line)] p-3 hover:bg-[var(--panel)]">
              <span><span className="font-semibold text-[var(--ink)]">{c.other_name || 'User'}</span> <span className="text-sm text-[var(--muted)]">· {c.listing_title}</span></span>
              <span className="text-xs text-[var(--muted)]">{when(c.last_at)}</span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  )
}

export function Thread({ listingId, otherId }: { listingId: string; otherId: string }) {
  const [rows, setRows] = useState<Message[]>([])
  const [listing, setListing] = useState<Listing | null>(null)
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const me = app.auth.user

  const load = () => q<Message>('list_messages', { listing_id: listingId, other_id: otherId }).then(setRows)
  useEffect(() => {
    load()
    pub<Listing>('get_listing', { id: listingId }).then(([l]) => setListing(l ?? null))
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [listingId, otherId])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [rows.length])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!me || !body.trim()) return
    const changes = await x('send_message', { listing_id: listingId, recipient_id: otherId, sender_name: me.name, body: body.trim() })
    if (!changes) { setError('Message not delivered: this thread is closed (blocked, or not your listing).'); return }
    setError('')
    setBody('')
    await load()
  }

  const otherName = rows.find((m) => m.sender_id === otherId)?.sender_name ?? (listing?.owner_id === otherId ? listing.owner_name : 'User')
  return (
    <Section title={otherName || 'Conversation'} action={<a href={`#/l/${listingId}`} className="text-sm text-[var(--accent)] underline-offset-4 hover:underline">{listing?.title ?? 'View listing'}</a>}>
      <div className="max-h-[60dvh] space-y-2 overflow-y-auto rounded-[var(--radius)] border border-[var(--line)] p-3">
        {rows.length === 0 ? <p className="text-sm text-[var(--muted)]">Say hello.</p> : null}
        {rows.map((m) => (
          <div key={m.id} className={`max-w-[80%] rounded-[var(--radius-sm)] px-3 py-2 text-sm ${m.sender_id === me?.id ? 'ml-auto bg-[var(--accent-soft)] text-[var(--accent-deep)]' : 'bg-[var(--paper-deep)] text-[var(--ink)]'}`}>
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className="mt-1 text-[10px] opacity-70">{when(m.created_at)}</p>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="mt-3 flex gap-2">
        <div className="flex-1"><Input aria-label="Message" placeholder="Write a message" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} /></div>
        <Button type="submit">Send</Button>
      </form>
      {error ? <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
      <p className="mt-3 text-xs text-[var(--muted)]"><a href="#/settings" className="underline-offset-4 hover:underline">Block or report</a> this person from Settings.</p>
    </Section>
  )
}
