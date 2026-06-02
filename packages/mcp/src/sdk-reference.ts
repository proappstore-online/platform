/**
 * Browser-snippet/reference builder for the `sdk_reference` MCP tool.
 *
 * Returns the per-feature documentation sections for @proappstore/sdk as a
 * record keyed by feature name. The tool joins/selects from this map.
 */
export function buildSdkReferenceSections(): Record<string, string> {
  return {
    auth: `## Auth
\`\`\`tsx
import { initPro } from '@proappstore/sdk'
const app = initPro({ appId: 'my-app' })
await app.auth.init()
app.auth.signIn()        // GitHub OAuth
app.auth.signOut()
app.auth.user            // { id, login, avatarUrl } | null
app.auth.token           // session token
app.auth.signIn('google') // Google OAuth
await app.auth.signInWithEmail('user@example.com') // magic link
\`\`\``,
    kv: `## Per-user KV Storage
\`\`\`tsx
await app.kv.set('key', { any: 'json' })
const val = await app.kv.get('key')
await app.kv.delete('key')
const keys = await app.kv.list({ prefix: 'draft:' })
const many = await app.kv.getMany(keys)
\`\`\`
Limits: 10MB/user on Pro (1MB on Free).`,
    counters: `## Shared Counters
\`\`\`tsx
await app.counters.increment('likes')       // +1, auth required
await app.counters.increment('score', 10)   // +10
await app.counters.get('likes')             // no auth needed
await app.counters.list()
\`\`\``,
    rooms: `## Real-time Rooms (WebSocket)
\`\`\`tsx
const room = app.rooms.join('lobby')
room.send({ type: 'move', x: 10 })
room.onMessage(msg => console.log(msg))
room.onPeers(peers => console.log(peers))
room.close()
\`\`\`
Uncapped on Pro (5 rooms, 50 user-hrs/day on Free).`,
    proxy: `## Secret-injecting API Proxy
\`\`\`tsx
const res = await app.proxy.fetch('api.example.com/v1/data')
\`\`\``,
    db: `## Per-app SQL Database (D1)
\`\`\`tsx
await app.db.execute('CREATE TABLE events (id TEXT PK, title TEXT)')
const { rows } = await app.db.query('SELECT * FROM events WHERE city = ?', ['SF'])
await app.db.execute('INSERT INTO events VALUES (?, ?)', [id, 'Meetup'])
const results = await app.db.batch([...])
await app.db.migrate([{ name: '001', sql: '...' }])
const tables = await app.db.tables()
\`\`\``,
    storage: `## File Storage (R2)
\`\`\`tsx
await app.storage.upload('photos/pic.jpg', file, 'image/jpeg')
await app.storage.uploadPublic('avatar.jpg', file, 'image/jpeg')
const url = app.storage.publicUrl('avatar.jpg')  // for <img src>
const res = await app.storage.download('photos/pic.jpg')
const files = await app.storage.list()
await app.storage.delete('photos/pic.jpg')
\`\`\``,
    maps: `## Maps + Geocoding + Routing
\`\`\`tsx
const results = await app.maps.geocode('Times Square, NYC')
const place = await app.maps.reverseGeocode(40.758, -73.985)
const route = await app.maps.route(from, to)
// route.geometry, route.distanceMeters, route.durationSeconds
const mapUrl = app.maps.embedUrl(lat, lng)   // for <iframe>
const tileUrl = app.maps.staticUrl(lat, lng) // for <img>
\`\`\`
OpenStreetMap powered, no Google keys needed.`,
    ai: `## Server-side AI (Workers AI)
\`\`\`tsx
const { text } = await app.ai.generate('Write a haiku')
const { text } = await app.ai.generate('Summarize...', { model: 'smart' })
const { text } = await app.ai.chat([
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hello' }
])
const { vectors } = await app.ai.embed(['hello', 'world'])
\`\`\`
Models: 'fast' (Llama 8B), 'smart' (Llama 70B). Included in subscription.`,
    notifications: `## Push Notifications (Web Push)
\`\`\`tsx
await app.notifications.subscribe()
await app.notifications.isSubscribed()
await app.notifications.send('user-id', { title: 'Hey!', body: 'Event soon.' })
await app.notifications.broadcast({ title: 'New!', body: 'Check it out.' })
\`\`\``,
    sms: `## SMS (Twilio-backed)
\`\`\`tsx
await app.sms.send('+15551234567', 'Confirmed!')
await app.sms.broadcast(['+1555...', '+1555...'], 'Reminder!')
\`\`\`
Creator-only. Numbers must be E.164.`,
    subscription: `## Subscription (Stripe)
\`\`\`tsx
const sub = await app.subscription.status()
// { status, tier, priceId, currentPeriodEnd, cancelAtPeriodEnd } | null
await app.subscription.openCheckout({ priceId, successUrl, cancelUrl })
await app.subscription.openPortal(returnUrl)
\`\`\``,
    tenant: `## Multi-tenant Helpers
\`\`\`tsx
const tx = app.db.tenant('studio-123')
await tx.insert('clients', { id: 'c-1', name: 'Alice' })
const alice = await tx.find('clients', { id: 'c-1' })
const all = await tx.findMany('clients')
await tx.update('clients', { id: 'c-1' }, { name: 'Alicia' })
await tx.delete('clients', { id: 'c-1' })
await tx.count('clients')
\`\`\`
Auto-scopes all queries by tenant_id. Tables need a \`tenant_id TEXT\` column.`,
    hooks: `## React Hooks
\`\`\`tsx
import { useProAuth, useProSubscription, useProGate, useProNotifications, useTheme } from '@proappstore/sdk/hooks'

const { user, loading, signIn, signOut, deleteAccount } = useProAuth(app)
const { isPro, upgrade, manageBilling } = useProSubscription(app)
const { gate, user, signIn, upgrade } = useProGate(app)
const { theme, preference, setPreference } = useTheme()
const { isSubscribed, subscribe, unsubscribe } = useProNotifications(app)
\`\`\``,
    ui: `## UI Components
\`\`\`tsx
import { Avatar, SignInButton, ThemeToggle, ProBadge, ProfileMenu, SubscriptionStatus, UpgradeCard, BillingButton, GateScreen, ProProfilePage } from '@proappstore/sdk/ui'
import { ProShell } from '@proappstore/sdk/shell'

// Zero-config shell:
<ProShell app={app} appName="My App">{children}</ProShell>

// Individual components:
<Avatar user={user} size={32} />
<ProBadge size="md" />
<ThemeToggle />
<ProfileMenu app={app} />
<SubscriptionStatus app={app} />
<UpgradeCard app={app} />
<BillingButton app={app} variant="secondary" />
<GateScreen gate={gate} app={app} appName="My App" />
<ProProfilePage app={app} />
\`\`\`
Full docs: https://proappstore.online/docs/ui`,
  };
}
