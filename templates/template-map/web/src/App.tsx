import { useEffect, useState, type ReactNode } from 'react'
import { ProShell } from '@proappstore/sdk'
import { app, RECORD } from './api'
import { useOnline, useRoles } from './hooks'
import { MapPage } from './pages/MapPage'
import { ListPage } from './pages/ListPage'
import { PlacePage } from './pages/PlacePage'
import { PlaceForm } from './pages/PlaceForm'
import { MinePage } from './pages/MinePage'
import { AdminPage } from './pages/AdminPage'
import { SettingsPage } from './pages/SettingsPage'

export type Route =
  | { name: 'map'; selected: string | null }
  | { name: 'list' }
  | { name: 'place'; id: string }
  | { name: 'edit'; id: string }
  | { name: 'new' }
  | { name: 'mine' }
  | { name: 'admin' }
  | { name: 'settings' }

function parseHash(): Route {
  const h = location.hash
  let m = h.match(/^#\/p\/([\w:-]+)\/edit$/)
  if (m) return { name: 'edit', id: m[1]! }
  m = h.match(/^#\/p\/([\w:-]+)$/)
  if (m) return { name: 'place', id: m[1]! }
  m = h.match(/^#\/(?:\?sel=([\w:-]+))?$/)
  if (m) return { name: 'map', selected: m[1] ?? null }
  switch (h) {
    case '#/list': return { name: 'list' }
    case '#/new': return { name: 'new' }
    case '#/mine': return { name: 'mine' }
    case '#/admin': return { name: 'admin' }
    case '#/settings': return { name: 'settings' }
    default: return { name: 'map', selected: null }
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
    const titles: Record<Route['name'], string> = { map: 'Map', list: 'List', place: RECORD.noun[0]!.toUpperCase() + RECORD.noun.slice(1), edit: 'Edit', new: 'New', mine: 'Mine', admin: 'Admin', settings: 'Settings' }
    document.title = `${titles[route.name]} — APPNAME`
    if (route.name !== 'map') window.scrollTo(0, 0)
  }, [route])
  return route
}

export default function App() {
  return (
    <ProShell
      app={app}
      appName="APPNAME"
      renderTopbar={({ profileMenu, textSizeToggle, proBadge }) => <Header right={<>{proBadge}{textSizeToggle}{profileMenu}</>} />}
      renderFooter={() => (
        <footer className="border-t border-[var(--line)] px-6 py-3 text-center text-xs text-[var(--muted)]">
          <a href="https://proappstore.online" className="font-semibold text-[var(--accent)] underline-offset-4 hover:underline">Built for ProAppStore</a>
        </footer>
      )}
    >
      <main id="main" className="flex flex-1 flex-col"><Routed /></main>
    </ProShell>
  )
}

function Routed() {
  const route = useRoute()
  switch (route.name) {
    case 'map': return <MapPage selected={route.selected} />
    case 'list': return <ListPage />
    case 'place': return <PlacePage id={route.id} />
    case 'edit': return <PlaceForm id={route.id} />
    case 'new': return <PlaceForm />
    case 'mine': return <MinePage />
    case 'admin': return <AdminPage />
    case 'settings': return <SettingsPage />
  }
}

function Header({ right }: { right: ReactNode }) {
  const online = useOnline()
  const { manager } = useRoles()
  const links: [string, string][] = [['#/', 'Map'], ['#/list', 'List'], ['#/mine', `My ${RECORD.plural}`], ['#/settings', 'Settings']]
  if (manager) links.splice(3, 0, ['#/admin', 'Admin'])
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[var(--panel-strong)] backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-[var(--paper)] focus:px-2 focus:py-1">Skip to content</a>
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
        <a href="#/" className="display-font text-lg font-bold text-[var(--ink)]">APPNAME</a>
        <nav aria-label="Main" className="flex flex-1 gap-3 overflow-x-auto text-sm">
          {links.map(([href, label]) => <a key={href} href={href} className="whitespace-nowrap font-medium text-[var(--muted)] hover:text-[var(--ink)]">{label}</a>)}
        </nav>
        {!online ? <span role="status" className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--warning)]">Offline</span> : null}
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  )
}
