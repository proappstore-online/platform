import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { app, q, ACTIVE_WORKSPACE_KEY, type Workspace, type WorkspaceDetail } from './api'

interface WorkspaceState {
  workspaces: Workspace[]
  active: WorkspaceDetail | null
  loading: boolean
  select: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<WorkspaceState | null>(null)

/**
 * The caller's workspaces and the one they are working in. The choice is remembered in
 * per-user platform KV and re-validated against list_my_workspaces on every load; the id is
 * only ever a hint — every action re-checks membership in SQL.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [active, setActive] = useState<WorkspaceDetail | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (preferred?: string) => {
    const list = await q<Workspace>('list_my_workspaces')
    setWorkspaces(list)
    const remembered = preferred ?? (await app.kv.get<string>(ACTIVE_WORKSPACE_KEY).catch(() => null))
    const pick = list.find((w) => w.id === remembered) ?? list[0]
    if (!pick) { setActive(null); return }
    const [detail] = await q<WorkspaceDetail>('get_workspace', { workspace_id: pick.id })
    setActive(detail ?? null)
    if (detail && detail.id !== remembered) await app.kv.set(ACTIVE_WORKSPACE_KEY, detail.id).catch(() => {})
  }, [])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])

  const select = useCallback(async (id: string) => {
    await app.kv.set(ACTIVE_WORKSPACE_KEY, id).catch(() => {})
    await load(id)
  }, [load])

  return <Ctx.Provider value={{ workspaces, active, loading, select, refresh: () => load(active?.id) }}>{children}</Ctx.Provider>
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWorkspace outside WorkspaceProvider')
  return v
}
