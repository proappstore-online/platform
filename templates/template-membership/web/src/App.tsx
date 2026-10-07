import { useEffect, useState, type ReactNode } from 'react'
import { NavBar, ProShell, type NavItem } from '@proappstore/sdk'
import { app, q, type Group } from './api'
import { Landing } from './pages/Landing'
import { Onboarding } from './pages/Onboarding'
import { GroupHome } from './pages/GroupHome'
import { Members } from './pages/Members'
import { Events, EventDetail } from './pages/Events'
import { Messages } from './pages/Messages'
import { Activity } from './pages/Activity'
import { Profile } from './pages/Profile'
import { Admin } from './pages/Admin'
import { Moderation } from './pages/Moderation'
import { Empty, Section } from './components'

type GroupPage = 'home' | 'members' | 'events' | 'messages' | 'activity' | 'admin'

export type Route =
  | { name: 'landing' }
  | { name: 'onboarding' }
  | { name: 'profile' }
  | { name: 'moderation' }
  | { name: 'group'; id: string; page: GroupPage }
  | { name: 'event'; id: string; eventId: string }

function parseHash(): Route {
  const h = location.hash
  let m = h.match(/^#\/group\/([\w:-]+)\/events\/([\w:-]+)$/)
  if (m) return { name: 'event', id: m[1]!, eventId: m[2]! }
  m = h.match(/^#\/group\/([\w:-]+)(?:\/(members|events|messages|activity|admin))?$/)
  if (m) return { name: 'group', id: m[1]!, page: (m[2] as GroupPage | undefined) ?? 'home' }
  if (h === '#/onboarding') return { name: 'onboarding' }
  if (h === '#/profile') return { name: 'profile' }
  if (h === '#/moderation') return { name: 'moderation' }
  return { name: 'landing' }
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    const title = route.name === 'group' ? route.page : route.name
    document.title = `${title[0]!.toUpperCase() + title.slice(1)} — APPNAME`
    window.scrollTo(0, 0)
  }, [route])
  return route
}

export default function App() {
  return (
    <ProShell
      app={app}
      appName="APPNAME"
      nav={NAV}
      renderNav={({ items }) => <HashNav items={items} />}
      renderFooter={() => (
        <footer className="border-t border-[var(--line)] px-6 py-4 text-center text-xs text-[var(--muted)]">
          <a href="https://proappstore.online" className="font-semibold text-[var(--accent)] underline-offset-4 hover:underline">Built for ProAppStore</a>
        </footer>
      )}
    >
      <div className="flex-1"><Routed /></div>
    </ProShell>
  )
}

function Routed() {
  const route = useRoute()
  switch (route.name) {
    case 'landing': return <Landing />
    case 'onboarding': return <Onboarding />
    case 'profile': return <Profile />
    case 'moderation': return <Moderation />
    case 'event': return <WithGroup id={route.id}>{(g) => <EventDetail group={g} eventId={route.eventId} />}</WithGroup>
    case 'group': return (
      <WithGroup id={route.id}>
        {(g) => {
          switch (route.page) {
            case 'home': return <GroupHome group={g} />
            case 'members': return <Members group={g} />
            case 'events': return <Events group={g} />
            case 'messages': return <Messages group={g} />
            case 'activity': return <Activity group={g} />
            case 'admin': return <Admin group={g} />
          }
        }}
      </WithGroup>
    )
  }
}

/** Loads the group the route names; a non-member gets an empty state, never a page. */
function WithGroup({ id, children }: { id: string; children: (g: Group) => ReactNode }) {
  const [group, setGroup] = useState<Group | null | undefined>(undefined)
  useEffect(() => { q<Group>('get_group', { group_id: id }).then(([g]) => setGroup(g ?? null)) }, [id])
  if (group === undefined) return <Section title="Loading…"><p className="text-sm text-[var(--muted)]">One moment.</p></Section>
  if (group === null) return <Section title="Not a member"><Empty title="You are not in this group" description="Ask for a join code, or go back to your groups." /></Section>
  return <>{children(group)}</>
}

/** The app's screens. ProShell renders them as its main navigation (<nav aria-label="Main">). */
const NAV: NavItem[] = [
  { label: 'My groups', href: '#/' },
  { label: 'Create or join', href: '#/onboarding' },
  { label: 'Profile', href: '#/profile' },
]

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
