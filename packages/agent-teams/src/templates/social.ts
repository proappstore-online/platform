/**
 * Social / matching template — profiles, discovery, matching, chat.
 * Pattern extracted from: dating, bandmates, meetup
 *
 * Features: profile creation, discovery feed, mutual matching,
 * real-time chat via rooms, bottom tab navigation.
 *
 * Data access: every user-facing read/write goes through registered actions
 * (mcp.json → app.actions.call). Raw app.db SQL is restricted to the app's
 * team by the platform, so seeding raw SQL would ship an app that 403s for
 * every regular user. Identity comes from :__user_id server-side; the
 * connection-pair ordering (a_id < b_id) is computed in the SQL itself.
 */
export function socialFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();

  files.set('src/lib/app.ts', `import { initPro } from '@proappstore/sdk'
export const app = initPro({ appId: '${slug}' })
`);

  files.set('src/types.ts', `export interface Profile {
  user_id: string
  display_name: string
  bio: string
  avatar_url: string
  interests: string
  location: string
  updated_at: number
}

export interface Connection {
  a_id: string
  b_id: string
  created_at: number
}

export interface ConnectionWithProfile extends Connection {
  display_name: string
  avatar_url: string
  bio: string
}

export interface Message {
  id: string
  connection_a: string
  connection_b: string
  sender_id: string
  body: string
  created_at: number
}

export type View =
  | 'discover'
  | 'connections'
  | 'chat'
  | 'profile'
`);

  files.set('mcp.json', `{
  "tools": [
    {
      "name": "get_my_profile",
      "description": "The caller's own profile",
      "operation": "query",
      "sql": "SELECT * FROM profiles WHERE user_id = :__user_id",
      "params": {},
      "requires_auth": true
    },
    {
      "name": "save_profile",
      "description": "Create or update the caller's profile",
      "operation": "execute",
      "sql": "INSERT INTO profiles (user_id, display_name, bio, avatar_url, interests, location, updated_at) VALUES (:__user_id, :display_name, :bio, :avatar_url, :interests, :location, :__now) ON CONFLICT(user_id) DO UPDATE SET display_name = :display_name, bio = :bio, avatar_url = :avatar_url, interests = :interests, location = :location, updated_at = :__now",
      "params": {
        "display_name": { "type": "string" },
        "bio": { "type": "string", "optional": true },
        "avatar_url": { "type": "string", "optional": true },
        "interests": { "type": "string", "optional": true },
        "location": { "type": "string", "optional": true }
      },
      "requires_auth": true
    },
    {
      "name": "list_discover_profiles",
      "description": "Profiles the caller hasn't swiped on yet, newest first",
      "operation": "query",
      "sql": "SELECT p.* FROM profiles p WHERE p.user_id != :__user_id AND p.user_id NOT IN (SELECT to_id FROM likes WHERE from_id = :__user_id) ORDER BY p.updated_at DESC LIMIT :limit",
      "params": { "limit": { "type": "integer" } },
      "requires_auth": true
    },
    {
      "name": "like_user",
      "description": "Record a swipe (like or pass) from the caller to another user",
      "operation": "execute",
      "sql": "INSERT OR IGNORE INTO likes (from_id, to_id, created_at) VALUES (:__user_id, :to_id, :__now)",
      "params": { "to_id": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "check_mutual_like",
      "description": "Whether the target user has liked the caller back",
      "operation": "query",
      "sql": "SELECT from_id FROM likes WHERE from_id = :to_id AND to_id = :__user_id",
      "params": { "to_id": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "create_connection",
      "description": "Connect the caller with another user (requires mutual likes)",
      "operation": "execute",
      "sql": "INSERT OR IGNORE INTO connections (a_id, b_id, created_at) SELECT CASE WHEN :__user_id < :other_id THEN :__user_id ELSE :other_id END, CASE WHEN :__user_id < :other_id THEN :other_id ELSE :__user_id END, :__now WHERE EXISTS (SELECT 1 FROM likes WHERE from_id = :__user_id AND to_id = :other_id) AND EXISTS (SELECT 1 FROM likes WHERE from_id = :other_id AND to_id = :__user_id)",
      "params": { "other_id": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "list_my_connections",
      "description": "The caller's connections with the other party's profile, newest first",
      "operation": "query",
      "sql": "SELECT c.*, p.display_name, p.avatar_url, p.bio FROM connections c JOIN profiles p ON p.user_id = CASE WHEN c.a_id = :__user_id THEN c.b_id ELSE c.a_id END WHERE c.a_id = :__user_id OR c.b_id = :__user_id ORDER BY c.created_at DESC",
      "params": {},
      "requires_auth": true
    },
    {
      "name": "list_messages",
      "description": "Messages between the caller and another user, oldest first",
      "operation": "query",
      "sql": "SELECT * FROM messages WHERE connection_a = CASE WHEN :__user_id < :other_id THEN :__user_id ELSE :other_id END AND connection_b = CASE WHEN :__user_id < :other_id THEN :other_id ELSE :__user_id END ORDER BY created_at ASC LIMIT :limit",
      "params": { "other_id": { "type": "string" }, "limit": { "type": "integer" } },
      "requires_auth": true
    },
    {
      "name": "send_message",
      "description": "Send a message from the caller to another user",
      "operation": "execute",
      "sql": "INSERT INTO messages (id, connection_a, connection_b, sender_id, body, created_at) VALUES (:id, CASE WHEN :__user_id < :other_id THEN :__user_id ELSE :other_id END, CASE WHEN :__user_id < :other_id THEN :other_id ELSE :__user_id END, :__user_id, :body, :__now)",
      "params": {
        "id": { "type": "string" },
        "other_id": { "type": "string" },
        "body": { "type": "string" }
      },
      "requires_auth": true
    }
  ]
}
`);

  files.set('src/lib/db.ts', `import { app } from './app'
import type { Profile, ConnectionWithProfile, Message } from '../types'

const MIGRATIONS = [
  {
    name: '0001_init',
    sql: \`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, bio TEXT DEFAULT '',
        avatar_url TEXT DEFAULT '', interests TEXT DEFAULT '', location TEXT DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS likes (
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (from_id, to_id)
      );
      CREATE INDEX IF NOT EXISTS idx_likes_to ON likes(to_id);
      CREATE TABLE IF NOT EXISTS connections (
        a_id TEXT NOT NULL, b_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (a_id, b_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conn_a ON connections(a_id);
      CREATE INDEX IF NOT EXISTS idx_conn_b ON connections(b_id);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, connection_a TEXT NOT NULL, connection_b TEXT NOT NULL,
        sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conn ON messages(connection_a, connection_b, created_at);
    \`
  }
]

// Raw SQL (including migrate) is team-only on PAS. Regular users get a 403
// here — that's fine: the schema is already applied, so swallow it and
// continue. Every user-facing read/write below goes through registered
// actions (mcp.json), never raw SQL.
export async function migrate() {
  try {
    await app.db.migrate(MIGRATIONS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes('403')) throw err
  }
}

async function q<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await app.actions.call<{ rows: T[] }>(name, params)
  return res.rows
}

async function x(name: string, params: Record<string, unknown> = {}): Promise<void> {
  await app.actions.call(name, params)
}

export async function getMyProfile() {
  return (await q<Profile>('get_my_profile'))[0] ?? null
}

export async function saveProfile(p: Omit<Profile, 'user_id'>) {
  await x('save_profile', {
    display_name: p.display_name, bio: p.bio, avatar_url: p.avatar_url,
    interests: p.interests, location: p.location
  })
}

export async function getDiscoverProfiles(limit = 20) {
  return q<Profile>('list_discover_profiles', { limit })
}

export async function likeUser(toId: string): Promise<boolean> {
  await x('like_user', { to_id: toId })
  const mutual = await q<{ from_id: string }>('check_mutual_like', { to_id: toId })
  if (mutual.length > 0) {
    await x('create_connection', { other_id: toId })
    return true
  }
  return false
}

export async function passUser(toId: string) {
  await x('like_user', { to_id: toId })
}

export async function getConnections() {
  return q<ConnectionWithProfile>('list_my_connections')
}

export async function getMessages(otherId: string, limit = 100) {
  return q<Message>('list_messages', { other_id: otherId, limit })
}

export async function sendMessage(otherId: string, body: string) {
  const id = crypto.randomUUID()
  await x('send_message', { id, other_id: otherId, body })
  return id
}
`);

  files.set('src/App.tsx', `import { useState, useEffect } from 'react'
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
import { ThemeToggle } from '@proappstore/sdk/ui'
import { app } from './lib/app'
import { migrate, getMyProfile, saveProfile } from './lib/db'
import { Discover } from './pages/Discover'
import { Connections } from './pages/Connections'
import { Chat } from './pages/Chat'
import { ProfileEdit } from './pages/ProfileEdit'
import type { View, Profile } from './types'

export default function App() {
  const { user, loading } = useProAuth(app)
  const { theme } = useTheme()
  const [view, setView] = useState<View>('discover')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [chatWith, setChatWith] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!user) return
    migrate().then(() => getMyProfile()).then((p) => {
      if (p) { setProfile(p); setReady(true) }
      else {
        const newP = { display_name: user.login, bio: '', avatar_url: user.avatarUrl, interests: '', location: '', updated_at: Date.now() }
        return saveProfile(newP).then(() => { setProfile({ user_id: user.id, ...newP }); setReady(true) })
      }
    }).catch(() => setReady(true))
  }, [user])

  if (loading) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Loading...</div>
  if (!user) return (
    <div className="min-h-[100dvh] flex items-center justify-center">
      <div className="card text-center space-y-4 max-w-sm">
        <h1 className="text-xl font-bold text-[var(--ink-strong)] display-font">${slug}</h1>
        <p className="text-muted">Connect with people</p>
        <button onClick={() => app.auth.signIn('github')} className="btn btn-primary w-full">Sign in with GitHub</button>
        <button onClick={() => app.auth.signIn('google')} className="btn btn-secondary w-full">Sign in with Google</button>
      </div>
    </div>
  )
  if (!ready) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Setting up...</div>

  const openChat = (otherId: string) => { setChatWith(otherId); setView('chat') }

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-lg mx-auto px-4 h-12 flex items-center justify-between">
          <span className="font-bold text-[var(--ink)] display-font">${slug}</span>
          <ThemeToggle />
        </div>
      </header>
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4">
        {view === 'discover' && <Discover userId={user.id} />}
        {view === 'connections' && <Connections userId={user.id} onOpenChat={openChat} />}
        {view === 'chat' && chatWith && <Chat userId={user.id} otherId={chatWith} onBack={() => setView('connections')} />}
        {view === 'profile' && profile && <ProfileEdit profile={profile} onSave={(p) => { saveProfile(p); setProfile({ user_id: user.id, ...p }) }} />}
      </main>
      <nav className="sticky bottom-0 border-t border-[var(--line)] bg-[var(--paper)]">
        <div className="max-w-lg mx-auto flex">
          {(['discover', 'connections', 'profile'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={'flex-1 py-3 text-center text-xs font-semibold ' + (view === v ? 'text-[var(--accent)]' : 'text-[var(--muted)]')}>
              {v === 'discover' ? 'Discover' : v === 'connections' ? 'Connections' : 'Profile'}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
`);

  files.set('src/pages/Discover.tsx', `import { useState, useEffect } from 'react'
import type { Profile } from '../types'
import { getDiscoverProfiles, likeUser, passUser } from '../lib/db'

export function Discover({ userId }: { userId: string }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [idx, setIdx] = useState(0)
  const [matched, setMatched] = useState(false)

  useEffect(() => { getDiscoverProfiles().then(setProfiles) }, [userId])

  const current = profiles[idx]
  if (!current) return <div className="empty-state"><h3>No more profiles</h3><p>Check back later for new people.</p></div>

  const handleLike = async () => {
    const isMatch = await likeUser(current.user_id)
    if (isMatch) { setMatched(true); setTimeout(() => setMatched(false), 2000) }
    setIdx(idx + 1)
  }

  const handlePass = async () => {
    await passUser(current.user_id)
    setIdx(idx + 1)
  }

  return (
    <div className="space-y-4">
      {matched && <div className="text-center py-4 text-[var(--accent)] font-bold text-lg">It's a match!</div>}
      <div className="card text-center space-y-3 py-6">
        <div className="w-20 h-20 rounded-full bg-[var(--accent-soft)] mx-auto flex items-center justify-center text-2xl">
          {current.avatar_url ? <img src={current.avatar_url} className="w-full h-full rounded-full object-cover" /> : current.display_name[0]}
        </div>
        <h3 className="text-lg font-bold text-[var(--ink-strong)]">{current.display_name}</h3>
        {current.location && <p className="text-sm text-muted">{current.location}</p>}
        {current.bio && <p className="text-sm text-[var(--ink)]">{current.bio}</p>}
        {current.interests && <p className="text-xs text-muted">{current.interests}</p>}
      </div>
      <div className="flex gap-3 justify-center">
        <button onClick={handlePass} className="btn btn-secondary px-8">Pass</button>
        <button onClick={handleLike} className="btn btn-primary px-8">Like</button>
      </div>
    </div>
  )
}
`);

  files.set('src/pages/Connections.tsx', `import { useState, useEffect } from 'react'
import { getConnections } from '../lib/db'
import type { ConnectionWithProfile } from '../types'

export function Connections({ userId, onOpenChat }: { userId: string; onOpenChat: (id: string) => void }) {
  const [conns, setConns] = useState<ConnectionWithProfile[]>([])

  useEffect(() => { getConnections().then(setConns) }, [userId])

  if (conns.length === 0) return <div className="empty-state"><h3>No connections yet</h3><p>Like profiles to make connections.</p></div>

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-bold text-[var(--ink-strong)]">Connections</h2>
      {conns.map((c) => {
        const otherId = c.a_id === userId ? c.b_id : c.a_id
        return (
          <button key={otherId} onClick={() => onOpenChat(otherId)}
            className="card w-full text-left flex items-center gap-3 hover:border-[var(--accent)] transition-colors">
            <div className="w-10 h-10 rounded-full bg-[var(--accent-soft)] flex items-center justify-center text-sm flex-shrink-0">
              {c.avatar_url ? <img src={c.avatar_url} className="w-full h-full rounded-full object-cover" /> : (c.display_name || '?')[0]}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-[var(--ink-strong)]">{c.display_name}</div>
              <div className="text-xs text-muted truncate">{c.bio || 'Say hi!'}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
`);

  files.set('src/pages/Chat.tsx', `import { useState, useEffect, useRef } from 'react'
import { getMessages, sendMessage } from '../lib/db'
import { app } from '../lib/app'
import type { Message } from '../types'

export function Chat({ userId, otherId, onBack }: { userId: string; otherId: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const roomRef = useRef<ReturnType<typeof app.rooms.join> | null>(null)

  const load = () => getMessages(otherId).then(setMessages)
  useEffect(() => { load() }, [userId, otherId])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    const a = userId < otherId ? userId : otherId
    const b = userId < otherId ? otherId : userId
    const room = app.rooms.join('chat:' + a + ':' + b)
    roomRef.current = room
    const unsub = room.onMessage(() => load())
    return () => { unsub(); room.close(); roomRef.current = null }
  }, [userId, otherId])

  const send = async () => {
    if (!text.trim()) return
    const body = text.trim()
    setText('')
    await sendMessage(otherId, body)
    roomRef.current?.send({ kind: 'message' })
    load()
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-7rem)]">
      <div className="flex items-center gap-2 pb-3 border-b border-[var(--line)]">
        <button onClick={onBack} className="text-[var(--accent)] text-sm">&larr; Back</button>
      </div>
      <div className="flex-1 overflow-y-auto py-3 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={m.sender_id === userId ? 'text-right' : 'text-left'}>
            <span className={'inline-block px-3 py-1.5 rounded-2xl text-sm max-w-[80%] ' +
              (m.sender_id === userId ? 'bg-[var(--accent)] text-white' : 'bg-[var(--panel)] border border-[var(--line)] text-[var(--ink)]')}>
              {m.body}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 pt-3 border-t border-[var(--line)]">
        <input className="input flex-1" placeholder="Message..." value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button onClick={send} className="btn btn-primary">Send</button>
      </div>
    </div>
  )
}
`);

  files.set('src/pages/ProfileEdit.tsx', `import { useState } from 'react'
import type { Profile } from '../types'

export function ProfileEdit({ profile, onSave }: { profile: Profile; onSave: (p: Omit<Profile, 'user_id'>) => void }) {
  const [name, setName] = useState(profile.display_name)
  const [bio, setBio] = useState(profile.bio)
  const [interests, setInterests] = useState(profile.interests)
  const [loc, setLoc] = useState(profile.location)

  const handleSave = () => {
    onSave({ display_name: name, bio, avatar_url: profile.avatar_url, interests, location: loc, updated_at: Date.now() })
  }

  return (
    <div className="space-y-4 max-w-md">
      <h2 className="text-lg font-bold text-[var(--ink-strong)]">Edit Profile</h2>
      <div>
        <label className="text-sm font-medium text-[var(--ink)]">Display Name</label>
        <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="text-sm font-medium text-[var(--ink)]">Bio</label>
        <textarea className="input mt-1 min-h-[80px]" value={bio} onChange={(e) => setBio(e.target.value)} />
      </div>
      <div>
        <label className="text-sm font-medium text-[var(--ink)]">Interests</label>
        <input className="input mt-1" value={interests} onChange={(e) => setInterests(e.target.value)} placeholder="e.g. music, hiking, code" />
      </div>
      <div>
        <label className="text-sm font-medium text-[var(--ink)]">Location</label>
        <input className="input mt-1" value={loc} onChange={(e) => setLoc(e.target.value)} />
      </div>
      <button onClick={handleSave} className="btn btn-primary w-full">Save Profile</button>
    </div>
  )
}
`);

  return files;
}
