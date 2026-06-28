/**
 * Real-time collaboration template — workspaces, boards, live presence.
 * Pattern extracted from: kanban, meet, chess-academy
 *
 * Features: multi-tenant workspaces, boards with lists/cards,
 * WebSocket rooms for presence + patch fan-out.
 */
export function realtimeFiles(slug: string): Map<string, string> {
  const files = new Map<string, string>();

  files.set('src/lib/app.ts', `import { initPro } from '@proappstore/sdk'
export const app = initPro({ appId: '${slug}' })
`);

  files.set('src/types.ts', `export interface Workspace {
  id: string
  name: string
  slug: string
  owner_id: string
  created_at: number
}

export interface Member {
  workspace_id: string
  user_id: string
  role: 'owner' | 'member'
  display_name: string
  avatar_url: string
  joined_at: number
}

export interface Board {
  id: string
  workspace_id: string
  name: string
  created_at: number
}

export interface BoardList {
  id: string
  board_id: string
  title: string
  position: number
}

export interface Card {
  id: string
  list_id: string
  board_id: string
  title: string
  description: string
  position: number
  created_by: string
  created_at: number
}

export type BoardPatch =
  | { kind: 'card.created' | 'card.updated' | 'card.moved' | 'card.deleted' }
  | { kind: 'list.created' | 'list.renamed' | 'list.moved' | 'list.deleted' }
`);

  files.set('src/lib/db.ts', `import { app } from './app'
import type { Workspace, Member, Board, BoardList, Card } from '../types'

const MIGRATIONS = [
  {
    name: '0001_init',
    sql: \`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
        owner_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT DEFAULT 'member',
        display_name TEXT, avatar_url TEXT, joined_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_boards_ws ON boards(workspace_id);
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL,
        position REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id, position);
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, list_id TEXT NOT NULL, board_id TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT DEFAULT '', position REAL NOT NULL,
        created_by TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_list ON cards(list_id, position);
    \`
  }
]

export async function migrate() { await app.db.migrate(MIGRATIONS) }

function makeSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    + '-' + crypto.randomUUID().slice(0, 6)
}

export async function createWorkspace(userId: string, name: string, displayName: string, avatarUrl: string) {
  const id = crypto.randomUUID()
  const slug = makeSlug(name)
  const now = Date.now()
  await app.db.batch([
    { sql: 'INSERT INTO workspaces (id,name,slug,owner_id,created_at) VALUES (?,?,?,?,?)', params: [id, name, slug, userId, now] },
    { sql: 'INSERT INTO members (workspace_id,user_id,role,display_name,avatar_url,joined_at) VALUES (?,?,?,?,?,?)', params: [id, userId, 'owner', displayName, avatarUrl, now] },
  ])
  return { id, slug }
}

export async function getMyWorkspaces(userId: string) {
  return (await app.db.query<Workspace>(
    'SELECT w.* FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at DESC', [userId]
  )).rows
}

export async function getBoards(workspaceId: string) {
  return (await app.db.query<Board>('SELECT * FROM boards WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId])).rows
}

export async function createBoard(workspaceId: string, name: string) {
  const id = crypto.randomUUID()
  await app.db.execute('INSERT INTO boards (id,workspace_id,name,created_at) VALUES (?,?,?,?)', [id, workspaceId, name, Date.now()])
  return id
}

export async function getLists(boardId: string) {
  return (await app.db.query<BoardList>('SELECT * FROM lists WHERE board_id = ? ORDER BY position', [boardId])).rows
}

export async function getCards(boardId: string) {
  return (await app.db.query<Card>('SELECT * FROM cards WHERE board_id = ? ORDER BY position', [boardId])).rows
}

export async function createList(boardId: string, title: string, position: number) {
  const id = crypto.randomUUID()
  await app.db.execute('INSERT INTO lists (id,board_id,title,position) VALUES (?,?,?,?)', [id, boardId, title, position])
  return id
}

export async function createCard(boardId: string, listId: string, title: string, position: number, userId: string) {
  const id = crypto.randomUUID()
  await app.db.execute(
    'INSERT INTO cards (id,list_id,board_id,title,description,position,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, listId, boardId, title, '', position, userId, Date.now()]
  )
  return id
}

export async function moveCard(cardId: string, toListId: string, position: number, userId: string, workspaceId: string) {
  const isMember = (await app.db.query<{ c: number }>(
    'SELECT COUNT(*) as c FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]
  )).rows[0]?.c ?? 0
  if (!isMember) throw new Error('Not a workspace member')
  await app.db.execute('UPDATE cards SET list_id = ?, position = ? WHERE id = ?', [toListId, position, cardId])
}

export async function getMembers(workspaceId: string) {
  return (await app.db.query<Member>('SELECT * FROM members WHERE workspace_id = ?', [workspaceId])).rows
}
`);

  files.set('src/lib/realtime.ts', `import { useEffect, useRef, useState } from 'react'
import { app } from './app'
import type { BoardPatch } from '../types'

export function useBoardRoom(boardId: string | null, userId: string, onPatch: (patch: BoardPatch) => void) {
  const [peers, setPeers] = useState<Array<{ uid: string; login: string }>>([])
  const onPatchRef = useRef(onPatch)
  onPatchRef.current = onPatch
  const roomRef = useRef<ReturnType<typeof app.rooms.join> | null>(null)

  useEffect(() => {
    if (!boardId) return
    const room = app.rooms.join('board:' + boardId)
    roomRef.current = room

    const unsub1 = room.onMessage<BoardPatch>((msg) => {
      if (msg.from.uid === userId) return
      onPatchRef.current(msg.data)
    })

    const unsub2 = room.onPeers((p) => setPeers(p))

    return () => { unsub1(); unsub2(); room.close(); roomRef.current = null }
  }, [boardId, userId])

  const broadcast = (patch: BoardPatch) => {
    roomRef.current?.send(patch)
  }

  return { peers, broadcast }
}
`);

  files.set('src/App.tsx', `import { useState, useEffect } from 'react'
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
import { Avatar, ThemeToggle } from '@proappstore/sdk/ui'
import { app } from './lib/app'
import { migrate, getMyWorkspaces, createWorkspace } from './lib/db'
import { BoardView } from './pages/BoardView'
import type { Workspace } from './types'

type Route = { page: 'workspaces' } | { page: 'board'; wsId: string; boardId: string }

function parseHash(): Route {
  const m = location.hash.match(/^#\\/w\\/([^/]+)\\/board\\/(.+)/)
  if (m) return { page: 'board', wsId: m[1], boardId: m[2] }
  return { page: 'workspaces' }
}

export default function App() {
  const { user, loading } = useProAuth(app)
  const { theme } = useTheme()
  const [route, setRoute] = useState<Route>(parseHash)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [ready, setReady] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => { const h = () => setRoute(parseHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  useEffect(() => {
    if (!user) return
    migrate().then(() => getMyWorkspaces(user.id)).then((ws) => { setWorkspaces(ws); setReady(true) })
  }, [user])

  if (loading) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Loading...</div>
  if (!user) return (
    <div className="min-h-[100dvh] flex items-center justify-center">
      <div className="card text-center space-y-4 max-w-sm">
        <h1 className="text-xl font-bold text-[var(--ink-strong)] display-font">${slug}</h1>
        <p className="text-muted">Real-time collaboration</p>
        <button onClick={() => app.auth.signIn('github')} className="btn btn-primary w-full">Sign in with GitHub</button>
        <button onClick={() => app.auth.signIn('google')} className="btn btn-secondary w-full">Sign in with Google</button>
      </div>
    </div>
  )
  if (!ready) return <div className="min-h-[100dvh] flex items-center justify-center text-muted">Setting up...</div>

  const handleCreate = async () => {
    if (!newName.trim()) return
    const ws = await createWorkspace(user.id, newName.trim(), user.login, user.avatarUrl)
    setNewName('')
    const updated = await getMyWorkspaces(user.id)
    setWorkspaces(updated)
  }

  if (route.page === 'board') {
    return <BoardView wsId={route.wsId} boardId={route.boardId} user={user} theme={theme} />
  }

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 h-12 flex items-center justify-between">
          <span className="font-bold text-[var(--ink)] display-font">${slug}</span>
          <div className="flex items-center gap-2"><ThemeToggle /><Avatar user={user} size={28} /></div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 space-y-6">
        <h2 className="text-lg font-bold text-[var(--ink-strong)]">Workspaces</h2>
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="New workspace name..." value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
          <button onClick={handleCreate} className="btn btn-primary">Create</button>
        </div>
        {workspaces.length === 0 ? (
          <div className="empty-state"><h3>No workspaces yet</h3><p>Create one to get started.</p></div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {workspaces.map((ws) => (
              <a key={ws.id} href={'#/w/' + ws.slug + '/board/new'} className="card hover:border-[var(--accent)] transition-colors block">
                <h3 className="font-semibold text-[var(--ink-strong)]">{ws.name}</h3>
                <p className="text-xs text-muted mt-1">Created {new Date(ws.created_at).toLocaleDateString()}</p>
              </a>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
`);

  files.set('src/pages/BoardView.tsx', `import { useState, useEffect, useCallback } from 'react'
import type { User } from '@proappstore/sdk'
import { ThemeToggle, Avatar } from '@proappstore/sdk/ui'
import { getBoards, getLists, getCards, createBoard, createList, createCard } from '../lib/db'
import { useBoardRoom } from '../lib/realtime'
import type { Board, BoardList, Card } from '../types'

export function BoardView({ wsId, boardId, user, theme }: { wsId: string; boardId: string; user: User; theme: string }) {
  const [boards, setBoards] = useState<Board[]>([])
  const [lists, setLists] = useState<BoardList[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null)
  const [newListTitle, setNewListTitle] = useState('')
  const [addingToList, setAddingToList] = useState<string | null>(null)
  const [newCardTitle, setNewCardTitle] = useState('')

  const reload = useCallback(async () => {
    if (!activeBoardId) return
    const [ls, cs] = await Promise.all([getLists(activeBoardId), getCards(activeBoardId)])
    setLists(ls); setCards(cs)
  }, [activeBoardId])

  const { peers, broadcast } = useBoardRoom(activeBoardId, user.id, () => { reload() })

  useEffect(() => {
    getBoards(wsId).then((bs) => {
      setBoards(bs)
      if (bs.length > 0) setActiveBoardId(bs[0].id)
    })
  }, [wsId])

  useEffect(() => { reload() }, [reload])

  const handleNewBoard = async () => {
    const id = await createBoard(wsId, 'New Board')
    setBoards(await getBoards(wsId))
    setActiveBoardId(id)
  }

  const handleAddList = async () => {
    if (!newListTitle.trim() || !activeBoardId) return
    await createList(activeBoardId, newListTitle.trim(), lists.length)
    setNewListTitle('')
    broadcast({ kind: 'list.created' })
    reload()
  }

  const handleAddCard = async (listId: string) => {
    if (!newCardTitle.trim() || !activeBoardId) return
    const listCards = cards.filter((c) => c.list_id === listId)
    await createCard(activeBoardId, listId, newCardTitle.trim(), listCards.length, user.id)
    setNewCardTitle(''); setAddingToList(null)
    broadcast({ kind: 'card.created' })
    reload()
  }

  return (
    <div className="min-h-[100dvh] flex flex-col" data-theme={theme}>
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--paper)]/90 backdrop-blur">
        <div className="max-w-full mx-auto px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="#/" className="text-sm text-[var(--accent)]">&larr;</a>
            <span className="font-bold text-[var(--ink)] display-font">{boards.find((b) => b.id === activeBoardId)?.name || 'Board'}</span>
          </div>
          <div className="flex items-center gap-2">
            {peers.map((p) => <span key={p.uid} className="w-6 h-6 rounded-full bg-[var(--accent-soft)] flex items-center justify-center text-xs">{p.login?.[0]}</span>)}
            <ThemeToggle />
            <Avatar user={user} size={28} />
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-x-auto p-4">
        <div className="flex gap-4 items-start min-w-max">
          {lists.map((list) => (
            <div key={list.id} className="w-72 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3 space-y-2 flex-shrink-0">
              <h3 className="font-semibold text-sm text-[var(--ink-strong)]">{list.title}</h3>
              {cards.filter((c) => c.list_id === list.id).sort((a, b) => a.position - b.position).map((card) => (
                <div key={card.id} className="card text-sm p-2">{card.title}</div>
              ))}
              {addingToList === list.id ? (
                <div className="space-y-1">
                  <input className="input text-sm" placeholder="Card title..." value={newCardTitle}
                    onChange={(e) => setNewCardTitle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCard(list.id)} autoFocus />
                  <div className="flex gap-1">
                    <button onClick={() => handleAddCard(list.id)} className="btn btn-primary text-xs">Add</button>
                    <button onClick={() => setAddingToList(null)} className="btn btn-ghost text-xs">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setAddingToList(list.id); setNewCardTitle('') }}
                  className="text-xs text-[var(--muted)] hover:text-[var(--ink)] w-full text-left py-1">+ Add card</button>
              )}
            </div>
          ))}
          <div className="w-72 flex-shrink-0 space-y-2">
            <input className="input text-sm" placeholder="New list..." value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddList()} />
          </div>
        </div>
      </main>
    </div>
  )
}
`);

  return files;
}
