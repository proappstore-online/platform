import { app, RECORD } from '../api'
import { Section } from '../components'
import { useRoles } from '../hooks'

/** Account, roles and the data this app keeps — the platform account is the profile. */
export function SettingsPage() {
  const { roles } = useRoles()
  const me = app.auth.user
  return (
    <Section title="Settings">
      <div className="max-w-xl space-y-4 text-sm">
        <p className="text-[var(--muted)]">Signed in as <strong className="text-[var(--ink)]">{me?.name}</strong>{roles.length ? <> with app roles <strong className="text-[var(--ink)]">{roles.join(', ')}</strong></> : null}.</p>
        <p className="text-[var(--muted)]">This app stores the {RECORD.plural} you add — name, description, address, coordinates and an optional photo — under your account. Hide or delete them from <a href="#/mine" className="text-[var(--accent)] hover:underline">My {RECORD.plural}</a>. Your location, when you press “Near me”, is used on this device only and never stored.</p>
        <p className="text-[var(--muted)]">Map data © OpenStreetMap contributors, via the platform's maps service. Account settings and sign-out are in the profile menu.</p>
      </div>
    </Section>
  )
}
