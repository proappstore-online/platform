import { useEffect, useState, type ReactNode } from 'react'
import { ProShell, useAuth } from '@proappstore/sdk'
import { SignInButton } from '@proappstore/sdk/ui'
import { app, REQUEST } from './api'
import { Browse, Saved } from './pages/Browse'
import { ListingPage } from './pages/Listing'
import { MyRequests, Inbox } from './pages/Requests'
import { OwnerDashboard, ListingForm } from './pages/Owner'
import { Conversations, Thread } from './pages/Messages'
import { Settings } from './pages/Settings'

/**
 * Hash routes. Public: browse and listing detail (rendered without a session through
 * the public catalogue tools). Everything else needs the platform session.
 */
export type Route =
  | { name: 'browse' }
  | { name: 'listing'; id: string }
  | { name: 'saved' }
  | { name: 'requests' }
  | { name: 'inbox' }
  | { name: 'mine' }
  | { name: 'new' }
  | { name: 'edit'; id: string }
  | { name: 'messages' }
  | { name: 'thread'; listingId: string; otherId: string }
  | { name: 'settings' }

const PUBLIC = new Set<Route['name']>(['browse', 'listing'])

function parseHash(): Route {
  const h = location.hash
  let m = h.match(/^#\/l\/([\w:-]+)$/)
  if (m) return { name: 'listing', id: m[1]! }
  m = h.match(/^#\/mine\/([\w:-]+)\/edit$/)
  if (m) return { name: 'edit', id: m[1]! }
  m = h.match(/^#\/messages\/([\w:-]+)\/([\w:.@-]+)$/)
  if (m) return { name: 'thread', listingId: m[1]!, otherId: m[2]! }
  switch (h) {
    case '#/saved': return { name: 'saved' }
    case '#/requests': return { name: 'requests' }
    case '#/inbox': return { name: 'inbox' }
    case '#/mine': return { name: 'mine' }
    case '#/mine/new': return { name: 'new' }
    case '#/messages': return { name: 'messages' }
    case '#/settings': return { name: 'settings' }
    default: return { name: 'browse' }
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    const titles: Record<Route['name'], string> = {
      browse: 'Browse', listing: 'Listing', saved: 'Saved', requests: `My ${REQUEST.plural}`, inbox: 'Inbox',
      mine: 'My listings', new: 'New listing', edit: 'Edit listing', messages: 'Messages', thread: 'Conversation', settings: 'Settings',
    }
    document.title = `${titles[route.name]} — APPNAME`
    window.scrollTo(0, 0)
  }, [route])
  return route
}

export default function App() {
  const { user, loading } = useAuth(app)
  const route = useRoute()

  if (loading) return <main id="main" className="p-8 text-sm text-[var(--muted)]">Loading…</main>

  if (!user) {
    return (
      <PublicShell>
        {PUBLIC.has(route.name) ? <Page route={route} /> : (
          <div className="mx-auto max-w-md px-6 py-16 text-center">
            <h1 className="display-font text-2xl font-semibold text-[var(--ink)]">Sign in to continue</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">Saving, {REQUEST.plural}, messages and your own listings need an account.</p>
            <div className="mt-6 flex justify-center"><SignInButton app={app} /></div>
          </div>
        )}
      </PublicShell>
    )
  }

  return (
    <ProShell
      app={app}
      appName="APPNAME"
      renderTopbar={({ profileMenu, textSizeToggle, proBadge }) => (
        <Header signedIn right={<>{proBadge}{textSizeToggle}{profileMenu}</>} />
      )}
    >
      <main id="main" className="flex-1"><Page route={route} /></main>
    </ProShell>
  )
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'browse': return <Browse />
    case 'listing': return <ListingPage id={route.id} />
    case 'saved': return <Saved />
    case 'requests': return <MyRequests />
    case 'inbox': return <Inbox />
    case 'mine': return <OwnerDashboard />
    case 'new': return <ListingForm />
    case 'edit': return <ListingForm id={route.id} />
    case 'messages': return <Conversations />
    case 'thread': return <Thread listingId={route.listingId} otherId={route.otherId} />
    case 'settings': return <Settings />
  }
}

function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header signedIn={false} right={<SignInButton app={app} label="Sign in" />} />
      <main id="main" className="flex-1">{children}</main>
      <footer className="border-t border-[var(--line)] px-6 py-4 text-center text-xs text-[var(--muted)]">
        <a href="https://proappstore.online" className="font-semibold text-[var(--accent)] underline-offset-4 hover:underline">Built for ProAppStore</a>
      </footer>
    </div>
  )
}

function Header({ signedIn, right }: { signedIn: boolean; right: ReactNode }) {
  const links: [string, string][] = signedIn
    ? [['#/', 'Browse'], ['#/saved', 'Saved'], ['#/requests', REQUEST.plural[0]!.toUpperCase() + REQUEST.plural.slice(1)], ['#/inbox', 'Inbox'], ['#/mine', 'My listings'], ['#/messages', 'Messages'], ['#/settings', 'Settings']]
    : [['#/', 'Browse']]
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--panel-strong)] backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-[var(--paper)] focus:px-2 focus:py-1">Skip to content</a>
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 sm:px-6">
        <a href="#/" className="display-font text-lg font-bold text-[var(--ink)]">APPNAME</a>
        <nav aria-label="Main" className="flex flex-1 gap-3 overflow-x-auto text-sm">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="whitespace-nowrap font-medium text-[var(--muted)] hover:text-[var(--ink)]">{label}</a>
          ))}
        </nav>
        <div className="flex items-center gap-2">{right}</div>
      </div>
    </header>
  )
}
