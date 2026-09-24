/**
 * Negative tests per scoped action (PAS-DATA-022) against a real SQLite built from
 * migrations.json, bound the way the platform binds. Covers the three properties the
 * template promises: unauthorized writes fail closed, other users' hidden records
 * never leak, and the map (viewport) and the list read the same rows.
 *
 *   node --no-warnings qa/actions.mjs          (part of `pnpm test`)
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'))
const TOOLS = Object.fromEntries(read('../mcp.json').tools.map((t) => [t.name, t]))
const DEMO = read('./demo-data.json')

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
      db.exec('COMMIT'); return changes
    } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const [sql, values] = bind(tool.sql, resolved, user, now)
  const stmt = db.prepare(sql)
  return tool.operation === 'query' ? stmt.all(...values) : stmt.run(...values).changes
}

let failures = 0
const ok = (pass, what) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`); if (!pass) failures++ }
const ids = (rows) => rows.map((r) => r.id).sort()
const ALICE = 'gh:demo-alice', BOB = 'gh:demo-bob', EVE = 'gh:eve', EDITOR = 'gh:editor'

ok(Object.values(TOOLS).every((t) => t.requires_auth === true), 'no public tools')
ok(Object.values(TOOLS).filter((t) => t.name.startsWith('admin_')).every((t) => JSON.stringify(t.auth?.app_roles) === '["admin","editor"]'), 'every admin_* tool is gated by the admin / editor app roles')

// --- Seed from the demo data: categories by an editor, places by their owners ---------------------
for (const c of DEMO.categories) ok(call('admin_create_category', EDITOR, c) === 1, `demo category ${c.name}`)
for (const p of DEMO.places) ok(call('create_place', p.owner_id, { id: p.id, owner_name: p.owner_name, category_id: p.category_id, name: p.name, description: p.description, address: p.address, lat: p.lat, lng: p.lng }) === 1, `demo place ${p.name}`)
ok(call('create_place', ALICE, { id: 'demo-p1', owner_name: 'x', name: 'dup', lat: 0, lng: 0 }) === 0, 'create_place is idempotent by client id')

// --- Unauthorized writes ------------------------------------------------------------------------------
ok(call('update_place', BOB, { id: 'demo-p1', name: 'Hijack', lat: -37.81, lng: 144.96 }) === 0, 'a non-owner cannot edit a place')
ok(call('set_place_status', BOB, { id: 'demo-p1', status: 'hidden' }) === 0, 'a non-owner cannot hide a place')
ok(call('delete_place', BOB, { id: 'demo-p1' }) === 0, 'a non-owner cannot delete a place')
ok(call('create_place', EVE, { id: 'bad-1', owner_name: 'Eve', name: 'Off the globe', lat: 91, lng: 0 }) === 0, 'coordinates off the globe are refused')
ok(call('create_place', EVE, { id: 'bad-2', owner_name: 'Eve', category_id: 'ghost', name: 'No category', lat: 0, lng: 0 }) === 0, 'an unknown category is refused')
ok(call('set_place_status', ALICE, { id: 'demo-p1', status: 'deleted' }) === 0, 'unknown statuses are refused')
ok(call('admin_update_place', EDITOR, { id: 'demo-p1', category_id: 'ghost', name: 'x' }) === 0, 'even an editor cannot assign an unknown category')

// --- Cross-user reads ---------------------------------------------------------------------------------
ok(call('set_place_status', ALICE, { id: 'demo-p2', status: 'hidden' }) === 1, 'owner hides a place')
ok(JSON.stringify(ids(call('list_places', BOB))) === JSON.stringify(['demo-p1', 'demo-p3', 'demo-p4']), 'a hidden place is not listed for others')
ok(JSON.stringify(ids(call('list_places', ALICE))) === JSON.stringify(['demo-p1', 'demo-p2', 'demo-p3', 'demo-p4']), 'the owner still sees it')
ok(call('get_place', BOB, { id: 'demo-p2' }).length === 0 && call('get_place', ALICE, { id: 'demo-p2' }).length === 1, 'get_place fails closed for others')
ok(call('list_places', BOB, { q: 'river' }).length === 0 && call('list_places', ALICE, { q: 'river' }).length === 1, 'search cannot find another user’s hidden record')
ok(JSON.stringify(ids(call('list_my_places', BOB))) === JSON.stringify(['demo-p3', 'demo-p4']), 'list_my_places is mine only')

// --- Map / list parity ------------------------------------------------------------------------------
const filters = { category_id: 'demo-cafe', q: null }
const listed = ids(call('list_places', BOB, filters))
ok(call('count_places', BOB, filters)[0].count === listed.length, 'count_places agrees with list_places for the same filters')
const box = { south: -37.83, north: -37.80, west: 144.95, east: 144.97 }
ok(JSON.stringify(ids(call('list_places', BOB, { ...filters, ...box }))) === JSON.stringify(['demo-p1']), 'a viewport narrows the same predicate')
ok(call('count_places', BOB, { ...filters, ...box })[0].count === 1, 'the count follows the viewport too')
ok(call('list_places', BOB, { south: -90, north: 90, west: 170, east: -170 }).length === 0, 'an antimeridian-crossing viewport is handled')
ok(call('list_places', BOB, { south: -37.9, north: -37.7, west: 144.9, east: 145.0 }).length === 3, 'the whole demo area is visible')

// --- Management ---------------------------------------------------------------------------------------
ok(ids(call('admin_list_places', EDITOR)).length === 4 && ids(call('admin_list_places', EDITOR, { status: 'hidden' })).length === 1, 'the admin table sees every status')
ok(call('admin_set_place_status', EDITOR, { id: 'demo-p4', status: 'hidden' }) === 1, 'an editor hides any record')
ok(call('category_stats', BOB).find((s) => s.id === 'demo-cafe').active_count === 1, 'category stats count active records only')
ok(JSON.stringify(call('admin_delete_category', EDITOR, { id: 'demo-cafe' })) === '[2,1]', 'deleting a category detaches its places')
ok(call('get_place', ALICE, { id: 'demo-p1' })[0].category_id === null, 'a detached place keeps its record')
ok(call('admin_delete_place', EDITOR, { id: 'demo-p3' }) === 1 && call('get_place', BOB, { id: 'demo-p3' }).length === 0, 'an editor deletes any record')

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
