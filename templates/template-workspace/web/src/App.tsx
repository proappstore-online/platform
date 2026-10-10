import { useEffect, useState, type ReactNode } from 'react'
import { NavBar, ProShell, type NavItem } from '@proappstore/sdk'
import { app } from './api'
import { WorkspaceProvider, useWorkspace } from './workspace'
import { Onboarding } from './pages/Onboarding'
import { Dashboard } from './pages/Dashboard'
import { Records, RecordPage, RecordForm } from './pages/Records'
import { Approvals } from './pages/Approvals'
import { Reports } from './pages/Reports'
import { Team } from './pages/Team'
import { Activity } from './pages/Activity'
import { Settings } from './pages/Settings'

export type Route =
  | { name: 'dashboard' }
  | { name: 'records' }
  | { name: 'record'; id: string }
  | { name: 'new' }
  | { name: 'edit'; id: string }
  | { name: 'approvals' }
  | { name: 'reports' }
  | { name: 'team' }
  | { name: 'activity' }
  | { name: 'settings' }
  | { name: 'join' }

function parseHash(): Route {
  const h = location.hash
  let m = h.match(/^#\/records\/([\w:-]+)\/edit$/)
  if (m) return { name: 'edit', id: m[1]! }
  m = h.match(/^#\/records\/([\w:-]+)$/)
  if (m) return { name: 'record', id: m[1]! }
  switch (h) {
    case '#/records': return { name: 'records' }
    case '#/records/new': return { name: 'new' }
    case '#/approvals': return { name: 'approvals' }
    case '#/reports': return { name: 'reports' }
    case '#/team': return { name: 'team' }
    case '#/activity': return { name: 'activity' }
    case '#/settings': return { name: 'settings' }
    case '#/join': return { name: 'join' }
    default: return { name: 'dashboard' }
  }
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    const titles: Record<Route['name'], string> = {
      dashboard: 'Dashboard', records: 'Records', record: 'Record', new: 'New record', edit: 'Edit record',
      approvals: 'Approvals', reports: 'Reports', team: 'Team', activity: 'Activity', settings: 'Settings', join: 'Join a workspace',
    }
    document.title = `${titles[route.name]} — APPNAME`
    window.scrollTo(0, 0)
  }, [route])
  return route
}

/** The app's screens. ProShell renders them as its main navigation (<nav aria-label="Main">). */
const NAV: NavItem[] = [
  { label: 'Dashboard', href: '#/' }, { label: 'Records', href: '#/records' }, { label: 'Approvals', href: '#/approvals' },
  { label: 'Reports', href: '#/reports' }, { label: 'Team', href: '#/team' }, { label: 'Activity', href: '#/activity' },
  { label: 'Settings', href: '#/settings' },
]

export default function App() {
  return (
    <ProShell
      app={app}
      appName="APPNAME"
      branding="app"
      nav={NAV}
      renderNav={({ items }) => <HashNav items={items} />}
      renderTopbar={({ nav, profileMenu, textSizeToggle, proBadge }) => <Header nav={nav} right={<>{proBadge}{textSizeToggle}{profileMenu}</>} />}
    >
      <WorkspaceProvider>
        <div className="flex-1"><Routed /></div>
      </WorkspaceProvider>
    </ProShell>
  )
}

function Routed() {
  const route = useRoute()
  const { active, loading } = useWorkspace()
  if (loading) return <p className="p-8 text-sm text-[var(--muted)]">Loading your workspaces…</p>
  if (!active || route.name === 'join') return <Onboarding join={route.name === 'join'} />
  switch (route.name) {
    case 'dashboard': return <Dashboard />
    case 'records': return <Records />
    case 'record': return <RecordPage id={route.id} />
    case 'new': return <RecordForm />
    case 'edit': return <RecordForm id={route.id} />
    case 'approvals': return <Approvals />
    case 'reports': return <Reports />
    case 'team': return <Team />
    case 'activity': return <Activity />
    case 'settings': return <Settings />
  }
}

/** A custom topbar only to add the workspace switcher; the navigation is ProShell's (`nav`), placed here. */
function Header({ nav, right }: { nav: ReactNode; right: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--panel-strong)] backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 sm:px-6">
        <a href="#/" className="display-font text-lg font-bold text-[var(--ink)]">APPNAME</a>
        {nav}
        <WorkspaceSwitcher />
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  )
}

function WorkspaceSwitcher() {
  // Rendered inside ProShell's topbar, which sits outside WorkspaceProvider — so it carries its own tiny state.
  const [ws, setWs] = useState<{ id: string; name: string }[]>([])
  const [current, setCurrent] = useState('')
  useEffect(() => {
    import('./api').then(({ q, ACTIVE_WORKSPACE_KEY }) =>
      Promise.all([q<{ id: string; name: string }>('list_my_workspaces'), app.kv.get<string>(ACTIVE_WORKSPACE_KEY).catch(() => null)]).then(([list, id]) => {
        setWs(list)
        setCurrent(id && list.some((w) => w.id === id) ? id : list[0]?.id ?? '')
      }),
    )
  }, [])
  if (ws.length < 2) return null
  return (
    <select
      aria-label="Workspace"
      value={current}
      onChange={async (e) => {
        const { ACTIVE_WORKSPACE_KEY } = await import('./api')
        await app.kv.set(ACTIVE_WORKSPACE_KEY, e.target.value)
        location.reload()
      }}
      className="rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--panel-strong)] px-2 py-1 text-xs text-[var(--ink)]"
    >
      {ws.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select>
  )
}

/** ProShell's NavBar, marking the current screen: this app routes by hash, the NavBar by default by path. */
function HashNav({ items }: { items: NavItem[] }) {
  const [hash, setHash] = useState(currentHash)
  useEffect(() => {
    const onHash = () => setHash(currentHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  return <NavBar items={items} currentPath={hash} />
}

function currentHash(): string {
  return (location.hash || '#/').split('?')[0]!
}
