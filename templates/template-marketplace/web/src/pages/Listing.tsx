import { useEffect, useState } from 'react'
import { Button, Modal } from '@proappstore/sdk/ui'
import { app, pub, q, x, images, imageUrl, money, when, MAPS_ENABLED, REQUEST, type Listing, type Review } from '../api'
import { Empty, Field, Section, Stars, TextArea } from '../components'
import { useSaved } from './Browse'

export function ListingPage({ id }: { id: string }) {
  const [listing, setListing] = useState<Listing | null | undefined>(undefined)
  const [reviews, setReviews] = useState<Review[]>([])
  const [stats, setStats] = useState<{ review_count: number; avg_rating: number | null }>({ review_count: 0, avg_rating: null })
  const [reviewable, setReviewable] = useState<string[]>([])
  const [asking, setAsking] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState('')
  const [rating, setRating] = useState(5)
  const [comment, setComment] = useState('')
  const [flash, setFlash] = useState('')
  const { saved, toggle, signedIn } = useSaved()
  const user = app.auth.user

  async function refresh() {
    const [rows, rv, st] = await Promise.all([
      pub<Listing>('get_listing', { id }),
      pub<Review>('list_reviews', { listing_id: id }),
      pub<{ review_count: number; avg_rating: number | null }>('listing_stats', { listing_id: id }),
    ])
    setListing(rows[0] ?? null)
    setReviews(rv)
    setStats(st[0] ?? { review_count: 0, avg_rating: null })
    if (user) setReviewable((await q<{ request_id: string }>('can_review', { listing_id: id })).map((r) => r.request_id))
  }
  useEffect(() => { refresh() }, [id])

  if (listing === undefined) return <Section title="Listing"><p className="text-sm text-[var(--muted)]">Loading…</p></Section>
  if (listing === null) return <Section title="Listing"><Empty title="This listing is not available" description="It may have been paused or archived by its owner." /></Section>

  const mine = user?.id === listing.owner_id
  const photos = images(listing)

  async function sendRequest() {
    if (!user) return
    const changes = await x('create_request', { id: crypto.randomUUID(), listing_id: id, requester_name: user.name, note })
    setAsking(false)
    setNote('')
    setFlash(changes ? `${REQUEST.verb} sent. The owner will see it in their inbox.` : `Could not send: you may already have an open ${REQUEST.noun} here.`)
  }

  async function submitReview() {
    if (!user || !reviewable[0]) return
    await x('create_review', { request_id: reviewable[0], author_name: user.name, rating, comment })
    setReviewing(false)
    setComment('')
    await refresh()
  }

  return (
    <Section title={listing.title} action={signedIn && !mine ? (
      <button type="button" aria-pressed={saved.has(id)} onClick={() => toggle(id)} className="text-2xl leading-none" style={{ color: saved.has(id) ? 'var(--accent)' : 'var(--muted)' }} aria-label={saved.has(id) ? 'Remove from saved' : 'Save'}>
        {saved.has(id) ? '♥' : '♡'}
      </button>
    ) : null}>
      {photos.length ? (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((k) => <img key={k} src={imageUrl(k)} alt="" className="aspect-[4/3] w-full rounded-[var(--radius-sm)] object-cover" />)}
        </div>
      ) : null}
      <p className="text-sm text-[var(--muted)]">{[listing.category, listing.location].filter(Boolean).join(' · ')} · by {listing.owner_name || 'the owner'} · listed {when(listing.created_at)}</p>
      <p className="mt-1 text-lg font-semibold text-[var(--ink)]">{money(listing)}</p>
      {stats.review_count ? <p className="mt-1 text-sm"><Stars rating={stats.avg_rating ?? 0} /> <span className="text-[var(--muted)]">{stats.review_count} review{stats.review_count === 1 ? '' : 's'}</span></p> : null}
      <p className="mt-4 whitespace-pre-wrap text-sm text-[var(--ink)]">{listing.description}</p>
      {MAPS_ENABLED && listing.lat !== null && listing.lng !== null ? (
        <iframe title="Map" src={app.maps.embedUrl(listing.lat, listing.lng)} className="mt-4 h-64 w-full rounded-[var(--radius)] border border-[var(--line)]" loading="lazy" />
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {mine ? <Button variant="secondary" onClick={() => { location.hash = `#/mine/${id}/edit` }}>Edit listing</Button> : null}
        {!mine && signedIn ? <Button onClick={() => setAsking(true)}>{REQUEST.verb}</Button> : null}
        {!mine && signedIn ? <Button variant="secondary" onClick={() => { location.hash = `#/messages/${id}/${listing.owner_id}` }}>Message owner</Button> : null}
        {!mine && !signedIn ? <Button onClick={() => app.auth.signIn()}>Sign in to {REQUEST.noun}</Button> : null}
        {reviewable.length ? <Button variant="secondary" onClick={() => setReviewing(true)}>Leave a review</Button> : null}
        {!mine && signedIn ? <a href="#/settings" className="self-center text-xs text-[var(--muted)] underline-offset-4 hover:underline">Block or report this owner</a> : null}
      </div>
      {flash ? <p role="status" className="mt-3 text-sm text-[var(--success)]">{flash}</p> : null}

      <h2 className="display-font mt-8 text-xl font-semibold text-[var(--ink)]">Reviews</h2>
      {reviews.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No reviews yet. Reviews open after a completed {REQUEST.noun}.</p> : null}
      <ul className="mt-2 space-y-3">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-[var(--radius-sm)] border border-[var(--line)] p-3">
            <p className="text-sm"><Stars rating={r.rating} /> <span className="font-semibold text-[var(--ink)]">{r.author_name}</span> <span className="text-[var(--muted)]">· {when(r.created_at)}</span></p>
            {r.comment ? <p className="mt-1 text-sm text-[var(--ink)]">{r.comment}</p> : null}
          </li>
        ))}
      </ul>

      <Modal open={asking} onClose={() => setAsking(false)} title={`${REQUEST.verb}: ${listing.title}`}>
        <Field label="Note to the owner"><TextArea aria-label="Note to the owner" rows={4} placeholder="Dates, questions, anything they should know" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button><Button onClick={sendRequest}>Send</Button></div>
      </Modal>
      <Modal open={reviewing} onClose={() => setReviewing(false)} title="Your review">
        <Field label="Rating">
          <select aria-label="Rating" value={rating} onChange={(e) => setRating(Number(e.target.value))} className="rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-3 py-2 text-sm text-[var(--ink)]">
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} ★</option>)}
          </select>
        </Field>
        <div className="mt-3"><Field label="Comment"><TextArea aria-label="Comment" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} /></Field></div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setReviewing(false)}>Cancel</Button><Button onClick={submitReview}>Publish review</Button></div>
      </Modal>
    </Section>
  )
}
