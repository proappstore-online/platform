/**
 * Negative tests per scoped action (PAS-DATA-022), run against a real SQLite built from
 * migrations.json with parameters bound the way the platform binds them. No browser, no
 * dependencies beyond Node 22's built-in sqlite.
 *
 *   node --no-warnings qa/actions.mjs          (part of `pnpm test`)
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'))
const TOOLS = Object.fromEntries(read('../mcp.json').tools.map((t) => [t.name, t]))

const db = new DatabaseSync(':memory:')
for (const m of read('../migrations.json').migrations) db.exec(m.sql)

/** Defaults, optionals and types, as the backend resolves them before binding. */
function resolve(tool, params) {
  const out = {}
  for (const [name, schema] of Object.entries(tool.params ?? {})) {
    let value = params[name]
    if (value === undefined || value === null) {
      if (schema.default !== undefined) value = schema.default
      else if (schema.optional) value = null
      else throw new Error(`${tool.name}: missing required parameter ${name}`)
    }
    if (value !== null && schema.type === 'integer') value = Number(value)
    out[name] = value
  }
  for (const name of Object.keys(params)) {
    if (!(name in (tool.params ?? {}))) throw new Error(`${tool.name}: unknown parameter ${name}`)
  }
  return out
}

/** Every `:name` becomes one positional `?`, magic values included — exactly like the platform. */
function bind(sql, resolved, user) {
  const values = []
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (name === '__user_id') { if (user === null) throw new Error('a public tool must not bind :__user_id'); values.push(user) }
    else if (name === '__now') values.push(Date.now())
    else if (name === '__uuid') values.push(randomUUID())
    else if (name in resolved) values.push(resolved[name])
    else throw new Error(`unresolved parameter: ${name}`)
    return '?'
  })
  return [bound, values]
}

/** `user === null` calls the tool the way the public path does (no session). */
export function call(name, user, params = {}) {
  const tool = TOOLS[name]
  if (!tool) throw new Error(`no such action: ${name}`)
  if (user === null && tool.requires_auth !== false) throw new Error(`${name} requires auth`)
  const [sql, values] = bind(tool.sql, resolve(tool, params), user)
  const stmt = db.prepare(sql)
  return tool.operation === 'query' ? stmt.all(...values) : stmt.run(...values).changes
}

let failures = 0
const ok = (pass, what) => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`)
  if (!pass) failures++
}

const OWNER = 'gh:owner', SEEKER = 'gh:seeker', STRANGER = 'gh:stranger', L = 'listing-1'

// --- Every public tool prepares without a session and names its columns ---------------------
for (const t of Object.values(TOOLS).filter((t) => t.requires_auth === false)) {
  ok(!/SELECT\s+\*/i.test(t.sql) && /\bLIMIT\s+\d+\b/i.test(t.sql), `${t.name}: public, column-explicit, literal LIMIT`)
}

// --- Listings -------------------------------------------------------------------------------
ok(call('create_listing', OWNER, { id: L, owner_name: 'Olive', title: 'Sunny room', category: 'room', price: 40, price_unit: 'night' }) === 1, 'owner publishes a listing')
ok(call('create_listing', OWNER, { id: L, owner_name: 'Olive', title: 'Sunny room again' }) === 0, 'create_listing is idempotent by client id')
ok(call('update_listing', STRANGER, { id: L, title: 'Hijacked' }) === 0, 'a stranger cannot edit it')
ok(call('set_listing_status', STRANGER, { id: L, status: 'archived' }) === 0, 'a stranger cannot archive it')
ok(call('get_my_listing', STRANGER, { id: L }).length === 0, 'a stranger cannot load it for editing')
ok(call('get_listing', null, { id: L }).length === 1, 'the public sees an active listing')
ok(call('set_listing_status', OWNER, { id: L, status: 'paused' }) === 1, 'owner pauses')
ok(call('get_listing', null, { id: L }).length === 0 && call('list_listings', null).length === 0, 'the public no longer sees a paused listing')
ok(call('set_listing_status', OWNER, { id: L, status: 'deleted' }) === 0, 'unknown status is refused')
call('set_listing_status', OWNER, { id: L, status: 'active' })
ok(call('search_listings', null, { q: 'SUNNY' }).length === 1, 'public search is case-insensitive')

// --- Requests -------------------------------------------------------------------------------
ok(call('create_request', OWNER, { id: 'r-own', listing_id: L, requester_name: 'Olive' }) === 0, 'owner cannot request their own listing')
ok(call('create_request', SEEKER, { id: 'r-1', listing_id: L, requester_name: 'Sam', note: 'Two nights?' }) === 1, 'seeker requests')
ok(call('create_request', SEEKER, { id: 'r-1', listing_id: L, requester_name: 'Sam' }) === 0, 'create_request is idempotent by client id')
ok(call('create_request', SEEKER, { id: 'r-2', listing_id: L, requester_name: 'Sam' }) === 0, 'one open request per listing per seeker')
ok(call('set_request_status', SEEKER, { id: 'r-1', from: 'pending', to: 'accepted' }) === 0, 'the requester cannot accept their own request')
ok(call('set_request_status', STRANGER, { id: 'r-1', from: 'pending', to: 'accepted' }) === 0, 'a stranger cannot transition it')
ok(call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'completed' }) === 0, 'pending cannot jump to completed')
ok(call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'accepted' }) === 1, 'owner accepts')
ok(call('set_request_status', OWNER, { id: 'r-1', from: 'pending', to: 'accepted' }) === 0, 'a stale client changes nothing')
ok(call('cancel_request', STRANGER, { id: 'r-1' }) === 0, 'a stranger cannot cancel it')
ok(call('list_incoming_requests', STRANGER).length === 0 && call('list_my_requests', STRANGER).length === 0, 'a stranger sees no requests')
ok(call('set_request_status', OWNER, { id: 'r-1', from: 'accepted', to: 'completed' }) === 1, 'owner completes')

// --- Reviews --------------------------------------------------------------------------------
ok(call('create_review', STRANGER, { request_id: 'r-1', author_name: 'Stan', rating: 1 }) === 0, 'a stranger cannot review someone else’s request')
ok(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 9 }) === 0, 'rating outside 1–5 is refused')
ok(call('can_review', SEEKER, { listing_id: L }).length === 1, 'the seeker may review after completion')
ok(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 5, comment: 'Lovely' }) === 1, 'seeker reviews')
ok(call('create_review', SEEKER, { request_id: 'r-1', author_name: 'Sam', rating: 1 }) === 0, 'one review per request')
ok(!('author_id' in (call('list_reviews', null, { listing_id: L })[0] ?? {})), 'public reviews never expose the author id')

// --- Messages and blocks --------------------------------------------------------------------
ok(call('send_message', SEEKER, { listing_id: L, recipient_id: OWNER, sender_name: 'Sam', body: 'Still free?' }) === 1, 'seeker messages the owner')
ok(call('send_message', STRANGER, { listing_id: L, recipient_id: SEEKER, sender_name: 'Stan', body: 'Hi' }) === 0, 'a third party cannot message a seeker about a listing they do not own')
ok(call('send_message', OWNER, { listing_id: L, recipient_id: OWNER, sender_name: 'Olive', body: 'Me' }) === 0, 'messaging yourself is refused')
ok(call('list_messages', STRANGER, { listing_id: L, other_id: OWNER }).length === 0, 'a stranger reads nothing from the thread')
ok(call('block_user', SEEKER, { blocked_id: OWNER }) === 1, 'seeker blocks the owner')
ok(call('send_message', OWNER, { listing_id: L, recipient_id: SEEKER, sender_name: 'Olive', body: 'Hello?' }) === 0, 'a blocked owner cannot message')
ok(call('create_request', SEEKER, { id: 'r-3', listing_id: L, requester_name: 'Sam' }) === 0, 'blocks also close requests')
ok(call('unblock_user', STRANGER, { blocked_id: OWNER }) === 0, 'only the blocker can unblock')
ok(call('block_user', SEEKER, { blocked_id: SEEKER }) === 0 && call('report_user', SEEKER, { reported_id: SEEKER, reason: 'spam' }) === 0, 'self-block and self-report are refused')

// --- Favourites -----------------------------------------------------------------------------
ok(call('add_favorite', SEEKER, { listing_id: L }) === 1 && call('add_favorite', SEEKER, { listing_id: L }) === 0, 'favourites are idempotent')
ok(call('add_favorite', SEEKER, { listing_id: 'nope' }) === 0, 'cannot favourite a listing that does not exist')
ok(call('remove_favorite', STRANGER, { listing_id: L }) === 0, 'a stranger cannot remove someone else’s favourite')

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
