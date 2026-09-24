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
const first = (r) => Array.isArray(r) ? r[0] : r

const ADMIN = 'gh:admin', MANAGER = 'gh:manager', MEMBER = 'gh:member', OUTSIDER = 'gh:outsider', W = 'ws-1'

ok(Object.values(TOOLS).every((t) => t.requires_auth === true), 'no public tools in a workspace app')
ok(Object.values(TOOLS).filter((t) => t.operation === 'batch').every((t) => t.statements.some((s) => s.includes('INSERT INTO activity_log'))), 'every batch write carries its audit row')

// --- Workspace and membership -----------------------------------------------------------------
ok(first(call('create_workspace', ADMIN, { workspace_id: W, name: 'Acme', display_name: 'Ada' })) === 1, 'admin creates a workspace')
ok(first(call('create_workspace', ADMIN, { workspace_id: W, name: 'Acme again', display_name: 'Ada' })) === 0, 'create_workspace is idempotent by client id')
ok(call('get_workspace', OUTSIDER, { workspace_id: W }).length === 0, 'an outsider cannot see the workspace')
ok(call('list_members', OUTSIDER, { workspace_id: W }).length === 0, 'an outsider cannot list members')
ok(call('list_activity', OUTSIDER, { workspace_id: W }).length === 0, 'an outsider cannot read the audit trail')

// --- Invitations ------------------------------------------------------------------------------
ok(call('create_invitation', ADMIN, { id: 'inv-mgr', workspace_id: W, role: 'manager' }) === 1, 'admin invites a manager')
ok(call('create_invitation', ADMIN, { id: 'inv-adm', workspace_id: W, role: 'admin' }) === 0, 'invitations cannot grant admin')
ok(first(call('accept_invitation', MANAGER, { code: 'inv-mgr', display_name: 'Max' })) === 1, 'manager joins with the code')
ok(first(call('accept_invitation', OUTSIDER, { code: 'inv-mgr', display_name: 'Eve' })) === 0, 'a used code is dead')
ok(first(call('accept_invitation', OUTSIDER, { code: 'nope', display_name: 'Eve' })) === 0, 'an unknown code changes nothing')
ok(call('create_invitation', MANAGER, { id: 'inv-mem', workspace_id: W }) === 0, 'a manager without manage_members cannot invite')
ok(first(call('grant_permission', MANAGER, { workspace_id: W, user_id: MANAGER, key: 'manage_members' })) === 0, 'nobody grants themselves permissions')
ok(first(call('grant_permission', ADMIN, { workspace_id: W, user_id: MANAGER, key: 'manage_members' })) === 1, 'admin grants manage_members')
ok(call('create_invitation', MANAGER, { id: 'inv-mem', workspace_id: W }) === 1, 'with it, the manager invites a member')
ok(first(call('accept_invitation', MEMBER, { code: 'inv-mem', display_name: 'Mia' })) === 1, 'member joins')
ok(call('list_members', ADMIN, { workspace_id: W }).find((m) => m.user_id === MEMBER).role === 'member', 'the role came from the invitation')
ok(call('revoke_invitation', MEMBER, { id: 'inv-x', workspace_id: W }) === 0, 'a member cannot revoke invitations')

// --- Roles and permissions --------------------------------------------------------------------
ok(first(call('set_member_role', MANAGER, { workspace_id: W, user_id: MEMBER, role: 'admin' })) === 0, 'a manager cannot change roles')
ok(first(call('set_member_role', ADMIN, { workspace_id: W, user_id: ADMIN, role: 'member' })) === 0, 'an admin cannot change their own role')
ok(first(call('set_member_role', ADMIN, { workspace_id: W, user_id: MEMBER, role: 'owner' })) === 0, 'unknown roles are refused')
ok(first(call('grant_permission', ADMIN, { workspace_id: W, user_id: OUTSIDER, key: 'approve' })) === 0, 'permissions only go to members')
ok(first(call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'delete_all' })) === 0, 'unknown permission keys are refused')
ok(first(call('remove_member', ADMIN, { workspace_id: W, user_id: ADMIN })) === 0 && call('leave_workspace', ADMIN, { workspace_id: W }) === 0, 'the last admin can neither remove themselves nor leave')
ok(first(call('rename_workspace', MEMBER, { workspace_id: W, name: 'X' })) === 0, 'a member cannot rename the workspace')
ok(first(call('rename_workspace', ADMIN, { workspace_id: W, name: 'Acme Ltd' })) === 1, 'admin renames, audited')

// --- Record lifecycle -------------------------------------------------------------------------
ok(first(call('create_record', OUTSIDER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'Intruder' })) === 0, 'an outsider cannot create records')
ok(first(call('create_record', MEMBER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'March', amount: 1200 })) === 1, 'member creates a draft')
ok(first(call('create_record', MEMBER, { id: 'r1', workspace_id: W, type: 'invoice', title: 'dup' })) === 0, 'create_record is idempotent by client id')
ok(first(call('update_record', OUTSIDER, { id: 'r1', workspace_id: W, title: 'Hijack' })) === 0, 'an outsider cannot edit it')
ok(first(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'approved' })) === 0, 'nothing to decide before submission')
ok(first(call('submit_record', OUTSIDER, { id: 'r1', workspace_id: W, approval_id: 'a0' })) === 0, 'an outsider cannot submit')
ok(JSON.stringify(call('submit_record', MEMBER, { id: 'r1', workspace_id: W, approval_id: 'a1' })) === '[1,1,1]', 'member submits: record, approval and audit row in one batch')
ok(first(call('submit_record', MEMBER, { id: 'r1', workspace_id: W, approval_id: 'a2' })) === 0, 'a submitted record cannot be submitted again')
ok(first(call('update_record', MEMBER, { id: 'r1', workspace_id: W, title: 'late' })) === 0, 'a submitted record is frozen')
call('grant_permission', ADMIN, { workspace_id: W, user_id: MEMBER, key: 'approve' })
ok(first(call('decide_approval', MEMBER, { id: 'a1', workspace_id: W, decision: 'approved' })) === 0, 'nobody approves their own submission')
ok(first(call('decide_approval', MANAGER, { id: 'a1', workspace_id: W, decision: 'approved' })) === 0, 'deciding needs the approve permission')
ok(first(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'maybe' })) === 0, 'decisions are approved | rejected')
ok(JSON.stringify(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'rejected', note: 'amount' })) === '[1,1,1]', 'admin rejects: approval, record and audit row')
ok(first(call('decide_approval', ADMIN, { id: 'a1', workspace_id: W, decision: 'approved' })) === 0, 'a decided approval is final')
ok(call('get_record', MEMBER, { id: 'r1', workspace_id: W })[0].status === 'rejected', 'the record followed the decision')
ok(first(call('update_record', MEMBER, { id: 'r1', workspace_id: W, title: 'March v2', amount: 1000 })) === 1, 'a rejected record can be fixed')
call('submit_record', MEMBER, { id: 'r1', workspace_id: W, approval_id: 'a2' })
ok(first(call('close_record', ADMIN, { id: 'r1', workspace_id: W })) === 0, 'only approved records close')
ok(first(call('decide_approval', ADMIN, { id: 'a2', workspace_id: W, decision: 'approved' })) === 1, 'admin approves')
ok(first(call('close_record', MEMBER, { id: 'r1', workspace_id: W })) === 0, 'a member cannot close')
ok(first(call('close_record', MANAGER, { id: 'r1', workspace_id: W })) === 1, 'a manager closes')
ok(first(call('archive_record', MEMBER, { id: 'r1', workspace_id: W })) === 0, 'a member cannot archive a closed record')
ok(first(call('archive_record', ADMIN, { id: 'r1', workspace_id: W })) === 1 && call('get_record', ADMIN, { id: 'r1', workspace_id: W }).length === 0, 'admin archives; it leaves the lists')

// --- Reports, export, audit -------------------------------------------------------------------
ok(call('record_stats', OUTSIDER, { workspace_id: W }).length === 0, 'stats are scoped')
ok(call('export_records', MEMBER, { workspace_id: W }).length === 0, 'export needs the export permission')
ok(call('export_records', ADMIN, { workspace_id: W }).length === 0 && call('list_records', ADMIN, { workspace_id: W }).length === 0, 'archived records are out of lists and exports alike')
const actions = call('list_activity', ADMIN, { workspace_id: W }).map((a) => a.action)
ok(['workspace.created', 'member.joined', 'permission.granted', 'workspace.renamed', 'record.created', 'record.submitted', 'record.decided', 'record.updated', 'record.closed', 'record.archived'].every((a) => actions.includes(a)), 'the audit trail has every kind of change')
ok(call('update_my_profile', OUTSIDER, { workspace_id: W, display_name: 'Eve' }) === 0, 'an outsider has no profile here')

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
