import { useEffect, useState, type ReactNode } from 'react'
import { ProShell } from '@proappstore/sdk'
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
import { Empty, Section } from './components'

type GroupPage = 'home' | 'members' | 'events' | 'messages' | 'activity' | 'admin'

export type Route =
  | { name: 'landing' }
  | { name: 'onboarding' }
  | { name: 'profile' }
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
      renderTopbar={({ profileMenu, textSizeToggle, proBadge }) => <Header right={<>{proBadge}{textSizeToggle}{profileMenu}</>} />}
      renderFooter={() => (
        <footer className="border-t border-[var(--line)] px-6 py-4 text-center text-xs text-[var(--muted)]">
          <a href="https://proappstore.online" className="font-semibold text-[var(--accent)] underline-offset-4 hover:underline">Built for ProAppStore</a>
        </footer>
      )}
    >
      <main id="main" className="flex-1"><Routed /></main>
    </ProShell>
  )
}

function Routed() {
  const route = useRoute()
  switch (route.name) {
    case 'landing': return <Landing />
    case 'onboarding': return <Onboarding />
    case 'profile': return <Profile />
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

function Header({ right }: { right: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--panel-strong)] backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-[var(--paper)] focus:px-2 focus:py-1">Skip to content</a>
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 sm:px-6">
        <a href="#/" className="display-font text-lg font-bold text-[var(--ink)]">APPNAME</a>
        <nav aria-label="Main" className="flex flex-1 gap-3 overflow-x-auto text-sm">
          <a href="#/" className="whitespace-nowrap font-medium text-[var(--muted)] hover:text-[var(--ink)]">My groups</a>
          <a href="#/onboarding" className="whitespace-nowrap font-medium text-[var(--muted)] hover:text-[var(--ink)]">Create or join</a>
          <a href="#/profile" className="whitespace-nowrap font-medium text-[var(--muted)] hover:text-[var(--ink)]">Profile</a>
        </nav>
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  )
}
