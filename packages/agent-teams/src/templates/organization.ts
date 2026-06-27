/**
 * Organization / workspace template — multi-tenant orgs, roles, memberships.
 * Pattern extracted from: interns, studio, chess-academy
 *
 * Features: org creation, member invites, role-based views (admin/member),
 * org settings, membership management.
 */
export function organizationFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();

  files.set('src/lib/app.ts', `import { initPro } from '@proappstore/sdk'
export const app = initPro({ appId: '${slug}' })
`);

  files.set('src/types.ts', `export interface Org {
  id: string
  name: string
  owner_id: string
  description: string
  logo_url: string
  website: string
  created_at: number
}

export interface Membership {
  org_id: string
  user_id: string
  role: 'admin' | 'member'
  display_name: string
  avatar_url: string
  joined_at: number
}

export interface RoleTrack {
  id: string
  org_id: string
  title: string
  description: string
  position: number
}
`);

  files.set('src/lib/db.ts', `import { app } from './app'
import type { Org, Membership, RoleTrack } from '../types'

const MIGRATIONS = [
  {
    name: '0001_init',
    sql: \`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL,
        description TEXT DEFAULT '', logo_url TEXT DEFAULT '', website TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        org_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member' CHECK(role IN ('admin','member')),
        display_name TEXT, avatar_url TEXT, joined_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
      CREATE TABLE IF NOT EXISTS role_tracks (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT DEFAULT '', position INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_org ON role_tracks(org_id, position);
    \`
  }
]

export async function migrate() { await app.db.migrate(MIGRATIONS) }

export async function createOrg(userId: string, name: string, displayName: string, avatarUrl: string) {
  const id = crypto.randomUUID()
  const now = Date.now()
  await app.db.batch([
    { sql: 'INSERT INTO orgs (id,name,owner_id,description,logo_url,website,created_at) VALUES (?,?,?,?,?,?,?)', params: [id, name, userId, '', '', '', now] },
    { sql: 'INSERT INTO memberships (org_id,user_id,role,display_name,avatar_url,joined_at) VALUES (?,?,?,?,?,?)', params: [id, userId, 'admin', displayName, avatarUrl, now] },
  ])
  return id
}

export async function getMyOrgs(userId: string) {
  return (await app.db.query<Org>(
    'SELECT o.* FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at DESC', [userId]
  )).rows
}

export async function getOrg(orgId: string) {
  return (await app.db.query<Org>('SELECT * FROM orgs WHERE id = ?', [orgId])).rows[0] ?? null
}

export async function updateOrg(orgId: string, data: Pick<Org, 'name' | 'description' | 'website'>) {
  await app.db.execute('UPDATE orgs SET name=?, description=?, website=? WHERE id=?', [data.name, data.description, data.website, orgId])
}

export async function getMembers(orgId: string) {
  return (await app.db.query<Membership>('SELECT * FROM memberships WHERE org_id = ? ORDER BY joined_at', [orgId])).rows
}

export async function getMembership(orgId: string, userId: string) {
  return (await app.db.query<Membership>('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?', [orgId, userId])).rows[0] ?? null
}

export async function joinOrg(orgId: string, userId: string, displayName: string, avatarUrl: string) {
  await app.db.execute(
    'INSERT OR IGNORE INTO memberships (org_id,user_id,role,display_name,avatar_url,joined_at) VALUES (?,?,?,?,?,?)',
    [orgId, userId, 'member', displayName, avatarUrl, Date.now()]
  )
}

export async function removeMember(orgId: string, userId: string) {
  await app.db.execute('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', [orgId, userId])
}

export async function getRoleTracks(orgId: string) {
  return (await app.db.query<RoleTrack>('SELECT * FROM role_tracks WHERE org_id = ? ORDER BY position', [orgId])).rows
}

export async function createRoleTrack(orgId: string, title: string, description: string) {
  const id = crypto.randomUUID()
  const count = (await app.db.query<{ c: number }>('SELECT COUNT(*) as c FROM role_tracks WHERE org_id = ?', [orgId])).rows[0]?.c ?? 0
  await app.db.execute('INSERT INTO role_tracks (id,org_id,title,description,position) VALUES (?,?,?,?,?)', [id, orgId, title, description, count])
  return id
}

export async function getPublicOrgs() {
  return (await app.db.query<Org>('SELECT * FROM orgs ORDER BY created_at DESC LIMIT 50')).rows
}
`);

  files.set('src/App.tsx', `import { useState, useEffect } from 'react'
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
import { Avatar, ThemeToggle } from '@proappstore/sdk/ui'
import { app } from './lib/app'
import { migrate, getMyOrgs, createOrg, getPublicOrgs } from './lib/db'
import { OrgView } from './pages/OrgView'
import type { Org } from './types'

type Route = { page: 'home' } | { page: 'org'; orgId: string }

function parseHash(): Route {
  const m = location.hash.match(/^#\\/org\\/(.+)/)
  if (m) return { page: 'org', orgId: m[1] }
  return { page: 'home' }
}

export default function App() {
  const { user, loading } = useProAuth(app)
  const { theme } = useTheme()
  const [route, setRoute] = useState<Route>(parseHash)
  const [myOrgs, setMyOrgs] = useState<Org[]>([])
  const [publicOrgs, setPublicOrgs] = useState<Org[]>([])
  const [ready, setReady] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => { const h = () => setRoute(parseHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  useEffect(() => {
    if (!user) return
    migrate().then(() => Promise.all([getMyOrgs(user.id), getPublicOrgs()])).then(([my, pub]) => {
      setMyOrgs(my); setPublicOrgs(pub); setReady(true)
    })
  }, [user])

  if (loading) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Loading...</div>
  if (!user) return (
    <div className="min-h-[100dvh] flex items-center justify-center">
      <div className="card text-center space-y-4 max-w-sm">
        <h1 className="text-xl font-bold text-[var(--ink-strong)] display-font">${slug}</h1>
        <p className="text-muted">Manage organizations and teams</p>
        <button onClick={() => app.auth.signIn('github')} className="btn btn-primary w-full">Sign in with GitHub</button>
        <button onClick={() => app.auth.signIn('google')} className="btn btn-secondary w-full">Sign in with Google</button>
      </div>
    </div>
  )
  if (!ready) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Setting up...</div>

  if (route.page === 'org') return <OrgView orgId={route.orgId} user={user} theme={theme} />

  const handleCreate = async () => {
    if (!newName.trim()) return
    await createOrg(user.id, newName.trim(), user.login, user.avatarUrl)
    setNewName('')
    setMyOrgs(await getMyOrgs(user.id))
  }

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <span className="font-bold text-[var(--ink)] display-font">${slug}</span>
          <div className="flex items-center gap-2"><ThemeToggle /><Avatar user={user} size={28} /></div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-8">
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-[var(--ink-strong)]">My Organizations</h2>
          <div className="flex gap-2">
            <input className="input flex-1" placeholder="New organization name..." value={newName}
              onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
            <button onClick={handleCreate} className="btn btn-primary">Create</button>
          </div>
          {myOrgs.length === 0 ? (
            <div className="empty-state"><h3>No organizations yet</h3><p>Create or join one to get started.</p></div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {myOrgs.map((org) => (
                <a key={org.id} href={'#/org/' + org.id} className="card hover:border-[var(--accent)] transition-colors block">
                  <h3 className="font-semibold text-[var(--ink-strong)]">{org.name}</h3>
                  {org.description && <p className="text-sm text-muted mt-1 line-clamp-2">{org.description}</p>}
                </a>
              ))}
            </div>
          )}
        </section>
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-[var(--ink-strong)]">Discover Organizations</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {publicOrgs.filter((o) => !myOrgs.some((m) => m.id === o.id)).map((org) => (
              <a key={org.id} href={'#/org/' + org.id} className="card hover:border-[var(--accent)] transition-colors block">
                <h3 className="font-semibold text-[var(--ink-strong)]">{org.name}</h3>
                {org.description && <p className="text-sm text-muted mt-1 line-clamp-2">{org.description}</p>}
              </a>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
`);

  files.set('src/pages/OrgView.tsx', `import { useState, useEffect } from 'react'
import type { User } from '@proappstore/sdk'
import { ThemeToggle, Avatar } from '@proappstore/sdk/ui'
import { getOrg, getMembers, getMembership, joinOrg, getRoleTracks, updateOrg, createRoleTrack } from '../lib/db'
import type { Org, Membership, RoleTrack } from '../types'

export function OrgView({ orgId, user, theme }: { orgId: string; user: User; theme: string }) {
  const [org, setOrg] = useState<Org | null>(null)
  const [members, setMembers] = useState<Membership[]>([])
  const [membership, setMembership] = useState<Membership | null>(null)
  const [tracks, setTracks] = useState<RoleTrack[]>([])
  const [tab, setTab] = useState<'members' | 'roles' | 'settings'>('members')
  const [newTrackTitle, setNewTrackTitle] = useState('')

  const reload = async () => {
    const [o, ms, me, ts] = await Promise.all([
      getOrg(orgId), getMembers(orgId), getMembership(orgId, user.id), getRoleTracks(orgId)
    ])
    setOrg(o); setMembers(ms); setMembership(me); setTracks(ts)
  }

  useEffect(() => { reload() }, [orgId])

  if (!org) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Loading...</div>
  const isAdmin = membership?.role === 'admin'

  const handleJoin = async () => {
    await joinOrg(orgId, user.id, user.login, user.avatarUrl)
    reload()
  }

  const handleAddTrack = async () => {
    if (!newTrackTitle.trim()) return
    await createRoleTrack(orgId, newTrackTitle.trim(), '')
    setNewTrackTitle('')
    setTracks(await getRoleTracks(orgId))
  }

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="#/" className="text-sm text-[var(--accent)]">&larr;</a>
            <span className="font-bold text-[var(--ink)]">{org.name}</span>
            {isAdmin && <span className="badge badge-accent">Admin</span>}
          </div>
          <div className="flex items-center gap-2"><ThemeToggle /><Avatar user={user} size={28} /></div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-4">
        {!membership && (
          <div className="card text-center space-y-3">
            <p className="text-muted">You're not a member of this organization yet.</p>
            <button onClick={handleJoin} className="btn btn-primary">Join Organization</button>
          </div>
        )}
        {membership && (
          <>
            <div className="flex gap-2 border-b border-[var(--line)]">
              {(['members', 'roles', ...(isAdmin ? ['settings'] as const : [])] as const).map((t) => (
                <button key={t} onClick={() => setTab(t as typeof tab)}
                  className={'pb-2 px-1 text-sm font-semibold border-b-2 ' +
                    (tab === t ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--muted)]')}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            {tab === 'members' && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-[var(--ink-strong)]">{members.length} members</h3>
                {members.map((m) => (
                  <div key={m.user_id} className="flex items-center gap-3 py-2">
                    <div className="w-8 h-8 rounded-full bg-[var(--accent-soft)] flex items-center justify-center text-xs flex-shrink-0">
                      {m.avatar_url ? <img src={m.avatar_url} className="w-full h-full rounded-full object-cover" /> : (m.display_name || '?')[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--ink)]">{m.display_name}</div>
                    </div>
                    <span className="badge badge-accent text-xs">{m.role}</span>
                  </div>
                ))}
              </div>
            )}
            {tab === 'roles' && (
              <div className="space-y-3">
                {tracks.map((t) => (
                  <div key={t.id} className="card">
                    <h4 className="font-semibold text-[var(--ink-strong)]">{t.title}</h4>
                    {t.description && <p className="text-sm text-muted mt-1">{t.description}</p>}
                  </div>
                ))}
                {isAdmin && (
                  <div className="flex gap-2">
                    <input className="input flex-1" placeholder="New role..." value={newTrackTitle}
                      onChange={(e) => setNewTrackTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAddTrack()} />
                    <button onClick={handleAddTrack} className="btn btn-primary text-sm">Add</button>
                  </div>
                )}
              </div>
            )}
            {tab === 'settings' && isAdmin && (
              <OrgSettings org={org} onSave={(data) => updateOrg(orgId, data).then(reload)} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

function OrgSettings({ org, onSave }: { org: Org; onSave: (data: Pick<Org, 'name' | 'description' | 'website'>) => void }) {
  const [name, setName] = useState(org.name)
  const [desc, setDesc] = useState(org.description)
  const [web, setWeb] = useState(org.website)

  return (
    <div className="space-y-4 max-w-md">
      <div><label className="text-sm font-medium text-[var(--ink)]">Name</label>
        <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><label className="text-sm font-medium text-[var(--ink)]">Description</label>
        <textarea className="input mt-1 min-h-[80px]" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      <div><label className="text-sm font-medium text-[var(--ink)]">Website</label>
        <input className="input mt-1" value={web} onChange={(e) => setWeb(e.target.value)} /></div>
      <button onClick={() => onSave({ name, description: desc, website: web })} className="btn btn-primary">Save Settings</button>
    </div>
  )
}
`);

  return files;
}
