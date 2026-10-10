import { useEffect, useState } from 'react'
import { NavBar, ProShell, type NavItem } from '@proappstore/sdk'
import { app, RECORD } from './api'
import { useRoles } from './hooks'
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

/** The app's screens. ProShell renders them as its main navigation (<nav aria-label="Main">). */
const NAV: NavItem[] = [
  { label: 'Map', href: '#/' },
  { label: 'List', href: '#/list' },
  { label: `My ${RECORD.plural}`, href: '#/mine' },
  { label: 'Settings', href: '#/settings' },
]

export default function App() {
  return (
    <ProShell
      app={app}
      appName="APPNAME"
      branding="app"
      nav={NAV}
      renderNav={({ items }) => <MainNav items={items} />}
    >
      <div className="flex flex-1 flex-col"><Routed /></div>
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

/** Managers also get Admin. Rendered inside ProShell, after sign-in, so the role lookup has a session. */
function MainNav({ items }: { items: NavItem[] }) {
  const { manager } = useRoles()
  return <HashNav items={manager ? [...items.slice(0, 3), { label: 'Admin', href: '#/admin' }, ...items.slice(3)] : items} />
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
