/**
 * Negative tests per scoped action (PAS-DATA-022) against a real SQLite built from
 * migrations.json, bound the way the platform binds: one param pool and one clock reading per
 * call, :__uuid per occurrence, batch statements in one transaction.
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
  for (const name of Object.keys(params)) if (!(name in (tool.params ?? {}))) throw new Error(`${tool.name}: unknown parameter ${name}`)
  return out
}

function bind(sql, resolved, user, now) {
  const values = []
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (name === '__user_id') values.push(user)
    else if (name === '__now') values.push(now)
    else if (name === '__uuid') values.push(randomUUID())
    else if (name in resolved) values.push(resolved[name])
    else throw new Error(`unresolved parameter: ${name}`)
    return '?'
  })
  return [bound, values]
}

let clock = Date.now()
export function call(name, user, params = {}) {
  const tool = TOOLS[name]
  if (!tool) throw new Error(`no such action: ${name}`)
  const resolved = resolve(tool, params)
  const now = ++clock
  if (tool.operation === 'batch') {
    db.exec('BEGIN')
    try {
      const changes = tool.statements.map((s) => { const [sql, v] = bind(s, resolved, user, now); return db.prepare(sql).run(...v).changes })
      db.exec('COMMIT')
      return changes
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const [sql, values] = bind(tool.sql, resolved, user, now)
  const stmt = db.prepare(sql)
  return tool.operation === 'query' ? stmt.all(...values) : stmt.run(...values).changes
}

let failures = 0
const ok = (pass, what) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`); if (!pass) failures++ }
const first = (r) => (Array.isArray(r) ? r[0] : r)
const ADMIN = 'gh:admin', MOD = 'gh:mod', MEMBER = 'gh:member', OUTSIDER = 'gh:outsider', G = 'grp-1'

ok(Object.values(TOOLS).every((t) => t.requires_auth === true), 'no public tools in a membership app')
ok(Object.values(TOOLS).filter((t) => !t.auth?.caller_unscoped).every((t) => (t.statements ?? [t.sql]).every((s) => s.includes(':__user_id'))), 'every group statement carries :__user_id')
ok(['admin_list_groups', 'admin_delete_group'].every((n) => TOOLS[n].auth?.app_roles?.includes('admin')), 'app-wide admin tools are gated by auth.app_roles')

// --- Group, codes, membership -----------------------------------------------------------------
ok(first(call('create_group', ADMIN, { group_id: G, slug: 'chess-club', name: 'Chess Club', display_name: 'Ada' })) === 1, 'admin creates a group')
ok(first(call('create_group', ADMIN, { group_id: G, slug: 'chess-club', name: 'Again', display_name: 'Ada' })) === 0, 'create_group is idempotent by client id')
ok(call('get_group', OUTSIDER, { group_id: G }).length === 0, 'an outsider cannot see the group')
ok(call('create_join_code', ADMIN, { id: 'jc-adm', group_id: G, code: 'ADM', role: 'admin' }) === 0, 'codes cannot grant admin')
ok(call('create_join_code', ADMIN, { id: 'jc-mod', group_id: G, code: 'MOD-1', role: 'moderator' }) === 1, 'admin makes a moderator code')
ok(call('create_join_code', ADMIN, { id: 'jc-mem', group_id: G, code: 'MEM-1', max_uses: 1 }) === 1, 'admin makes a single-use member code')
ok(first(call('join_group_by_code', MOD, { code: 'MOD-1', display_name: 'Mo' })) === 1, 'moderator joins with the code')
ok(first(call('join_group_by_code', OUTSIDER, { code: 'MOD-1', display_name: 'Eve' })) === 0, 'a used-up code is dead')
ok(first(call('join_group_by_code', MEMBER, { code: 'MEM-1', display_name: 'Mia' })) === 1, 'member joins')
ok(first(call('join_group_by_code', OUTSIDER, { code: 'nope', display_name: 'Eve' })) === 0, 'an unknown code changes nothing')
ok(call('create_join_code', ADMIN, { id: 'jc-old', group_id: G, code: 'OLD', expires_at: clock - 1 }) === 1 && first(call('join_group_by_code', OUTSIDER, { code: 'OLD', display_name: 'Eve' })) === 0, 'an expired code changes nothing')
ok(call('create_join_code', MEMBER, { id: 'jc-x', group_id: G, code: 'X' }) === 0, 'a member cannot make codes')
ok(call('list_join_codes', MEMBER, { group_id: G }).length === 0, 'a member cannot list codes')
ok(call('list_members', ADMIN, { group_id: G }).find((m) => m.user_id === MOD).role === 'moderator', 'the role came from the code, not the client')

// --- Roles ------------------------------------------------------------------------------------
ok(first(call('set_member_role', MOD, { group_id: G, user_id: MEMBER, role: 'admin' })) === 0, 'a moderator cannot change roles')
ok(first(call('set_member_role', ADMIN, { group_id: G, user_id: ADMIN, role: 'member' })) === 0, 'an admin cannot change their own role')
ok(first(call('set_member_role', ADMIN, { group_id: G, user_id: MEMBER, role: 'owner' })) === 0, 'unknown roles are refused')
ok(first(call('add_member', MEMBER, { group_id: G, user_id: 'gh:new' })) === 0, 'a member cannot add members')
ok(first(call('add_member', MOD, { group_id: G, user_id: 'gh:new', display_name: 'New' })) === 1, 'a moderator adds a member directly')
ok(call('remove_member', MOD, { group_id: G, user_id: ADMIN })[1] === 0, 'a moderator cannot remove an admin')
ok(call('remove_member', MEMBER, { group_id: G, user_id: 'gh:new' })[1] === 0, 'a member cannot remove anyone')
ok(call('remove_member', MOD, { group_id: G, user_id: 'gh:new' })[1] === 1, 'a moderator removes a member')
ok(call('remove_member', ADMIN, { group_id: G, user_id: ADMIN })[1] === 0 && call('leave_group', ADMIN, { group_id: G }) === 0, 'the last admin can neither remove themselves nor leave')
ok(first(call('update_group', MOD, { group_id: G, name: 'X' })) === 0, 'a moderator cannot edit the group')

// --- Events and RSVPs -------------------------------------------------------------------------
const t = clock + 86_400_000
ok(first(call('create_event', MEMBER, { id: 'ev-1', group_id: G, title: 'Blitz', starts_at: t })) === 0, 'a member cannot create events')
ok(first(call('create_event', MOD, { id: 'ev-1', group_id: G, title: 'Blitz', starts_at: t, capacity: 1 })) === 1, 'a moderator creates an event with capacity 1')
ok(call('rsvp_event', OUTSIDER, { id: 'r-o', event_id: 'ev-1', status: 'going' }).every((c) => c === 0), 'an outsider cannot RSVP')
ok(call('rsvp_event', MEMBER, { id: 'r-m', event_id: 'ev-1', status: 'maybe' }).every((c) => c === 0), 'RSVP status is going | not_going')
ok(call('rsvp_event', MEMBER, { id: 'r-m', event_id: 'ev-1', status: 'going' })[1] === 1, 'member goes')
ok(call('rsvp_event', MOD, { id: 'r-x', event_id: 'ev-1', status: 'going' })[1] === 1 && call('list_rsvps', ADMIN, { event_id: 'ev-1' }).find((r) => r.user_id === MOD).status === 'waitlist', 'a full event waitlists the next RSVP')
ok(call('rsvp_event', MEMBER, { id: 'r-m2', event_id: 'ev-1', status: 'not_going' })[2] === 1 && call('list_rsvps', ADMIN, { event_id: 'ev-1' }).find((r) => r.user_id === MOD).status === 'going', 'a freed seat promotes the first waitlisted member')
ok(call('list_rsvps', OUTSIDER, { event_id: 'ev-1' }).length === 0, 'an outsider cannot see RSVPs')
ok(first(call('update_event', MEMBER, { id: 'ev-1', group_id: G, title: 'Hijack', starts_at: t })) === 0, 'a member cannot edit an event')
ok(call('delete_event', MEMBER, { id: 'ev-1', group_id: G })[1] === 0, 'a member cannot delete an event')
ok(call('delete_event', MOD, { id: 'ev-1', group_id: G })[1] === 1, 'its creator deletes it')

// --- Thread and activity ----------------------------------------------------------------------
ok(call('post_message', OUTSIDER, { id: 'm-o', group_id: G, content: 'hi' }) === 0, 'an outsider cannot post')
ok(call('post_message', MEMBER, { id: 'm-1', group_id: G, content: 'hello' }) === 1 && call('post_message', MEMBER, { id: 'm-1', group_id: G, content: 'dup' }) === 0, 'post_message is idempotent by client id')
ok(call('post_message', MOD, { id: 'm-2', group_id: G, content: 'hey' }) === 1 && call('delete_message', MEMBER, { id: 'm-2', group_id: G }) === 0, 'a member cannot delete someone else’s message')
ok(call('delete_message', MOD, { id: 'm-1', group_id: G }) === 1, 'a moderator deletes any message')
ok(call('list_messages', OUTSIDER, { group_id: G }).length === 0 && call('list_activity', OUTSIDER, { group_id: G }).length === 0, 'an outsider reads neither the thread nor the log')
const actions = call('list_activity', ADMIN, { group_id: G }).map((a) => a.action)
ok(['group.created', 'member.joined', 'member.added', 'member.removed', 'event.created', 'event.rsvp', 'event.deleted'].every((a) => actions.includes(a)), 'the activity log has every kind of change')
ok(call('update_my_profile', OUTSIDER, { group_id: G, display_name: 'Eve' }) === 0, 'an outsider has no profile here')

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
