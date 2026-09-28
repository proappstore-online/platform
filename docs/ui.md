# UI Component Library

> **App requirements** for UI, accessibility, browser security and PWA behaviour are clauses in the [Application Standard — UI chapter](./standard/ui.md), which also lists what each SDK component provides for accessibility. This page is the component reference those clauses cite.

Drop-in React components for ProAppStore apps: the `ProShell` app frame, composable primitives, and design tokens.

Every app starts the same way: wrap the whole app in [`ProShell`](#proshell) and list its screens in `nav`. The components and hooks on this page build the screens *inside* the shell, or a custom topbar for it. They do not replace it. New to the shell? Start with [Getting Started](./getting-started.md#build-your-app-inside-proshell).

## Choose your level

Every level runs inside ProShell. The level only decides how much of the chrome you customise:

#### Level 1: ProShell (every app)

The default. Auth gates, subscription checks, topbar, the app's main navigation from `nav`, and the resilience layer (error boundary, loading fallback, toasts, offline banner, skip link).

```tsx
<ProShell app={app} appName="My App" nav={[{ label: 'Home', href: '/' }, { label: 'Reports', href: '/reports' }]}>
  <Screens />
</ProShell>
```

#### Level 2: Composable chrome

Your own topbar, built from the SDK components, still inside ProShell. Use `renderTopbar` and place `ctx.nav`, `ctx.profileMenu` and `ctx.textSizeToggle` in it. For a completely different frame, use `hideTopbar` with the exported `NavBar`.

```tsx
<ProShell app={app} nav={NAV} renderTopbar={({ appName, proBadge, nav, textSizeToggle, profileMenu }) => (
  <header className="top-nav">{appName}{proBadge}{nav}{textSizeToggle}{profileMenu}</header>
)}>…</ProShell>
```

#### Level 3: Hooks in screens

Read identity, subscription and theme state inside a screen.

```tsx
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
```

#### Level 4: Profile page

A dedicated settings screen, listed in `nav` like any other.

```tsx
<ProShell app={app} nav={[{ label: 'Home', href: '/' }, { label: 'Profile', href: '/profile' }]}>
  {location.pathname === '/profile' ? <ProProfilePage app={app} /> : <Home />}
</ProShell>
```

## Design Tokens

SDK components reference the platform's canonical CSS custom properties (the
contract in `DESIGN-SYSTEM.md`). ProAppStore uses a purple accent palette. The
old aliases `--bg`, `--surface`, `--surface-2`, `--border` and `--border-strong`
are banned by the design-system lint — use the names below.

| Token | Light | Dark | Purpose |
| --- | --- | --- | --- |
| `--paper` | `#f8fafc` | `#0f172a` | Page background |
| `--panel` | `#ffffff` | `#1e293b` | Card / elevated surface |
| `--panel-alt` | `#f1f5f9` | `#0f172a` | Secondary surface |
| `--ink` | `#1e293b` | `#f1f5f9` | Primary text |
| `--ink-strong` | `#0f172a` | `#ffffff` | Headings, emphasis |
| `--muted` | `#64748b` | `#94a3b8` | Secondary text |
| `--line` | `#e2e8f0` | `#334155` | Borders |
| `--line-strong` | `#cbd5e1` | `#475569` | Emphasized borders (hover, focus) |
| `--accent` | `#7c3aed` | `#a78bfa` | Primary action (purple) |
| `--accent-hover` | `#6d28d9` | `#7c3aed` | Action hover |
| `--accent-soft` | `#f5f3ff` | `#2e1065` | Accent background |
| `--danger` / `--success` / `--warning` (+ `-soft`) | see `DESIGN-SYSTEM.md` | | Semantic status colours |
| `--radius` | `0.75rem` | | Default border radius |
| `--radius-sm` | `0.5rem` | | Small border radius |
| `--shadow` | `0 1px 3px rgba(15,23,42,0.08)` | | Card shadow |

## Avatar

GitHub avatar image with fallback to a colored initial circle.

```
import { Avatar } from '@proappstore/sdk/ui'

<Avatar user={user} size={32} />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `user` | `User | null` | - | User object |
| `size` | `number` | `32` | Width/height in px |

## SignInButton

Platform-branded sign-in button.

```
import { SignInButton } from '@proappstore/sdk/ui'

<SignInButton app={app} />
<SignInButton app={app} label="Get started" />
<SignInButton app={app} provider="google" label="Sign in with Google" />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `label` | `string` | `"Sign in with GitHub"` | Button text |
| `provider` | `'github' \| 'google'` | `'github'` | OAuth provider |

## ThemeToggle

Sun/moon icon button. Cycles: system, light, dark.

```
import { ThemeToggle } from '@proappstore/sdk/ui'

<ThemeToggle />
```

## ProBadge

Purple "PRO" subscription badge. Use anywhere to indicate premium status.

```
import { ProBadge } from '@proappstore/sdk/ui'

<ProBadge />
<ProBadge size="lg" />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `size` | `'sm' | 'md' | 'lg'` | `'sm'` | Badge size |

## ProfileMenu

Avatar button that opens dropdown with Pro features: PRO badge, billing link, theme toggle, sign out, delete account (with double-confirm).

```
import { ProfileMenu } from '@proappstore/sdk/ui'

<ProfileMenu app={app} />
<ProfileMenu app={app} showBilling={false}>
  <button style={menuStyle}>Settings</button>
</ProfileMenu>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `showThemeToggle` | `boolean` | `true` | Show theme toggle in dropdown |
| `showBilling` | `boolean` | `true` | Show "Manage billing" for Pro subscribers |
| `children` | `ReactNode` | - | Extra menu items |

Automatically shows PRO badge next to username for active subscribers.

## SubscriptionStatus

Inline subscription status indicator: PRO badge with renewal date, or "Free plan" with optional upgrade button.

```
import { SubscriptionStatus } from '@proappstore/sdk/ui'

<SubscriptionStatus app={app} />
<SubscriptionStatus app={app} showUpgrade={false} />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `showUpgrade` | `boolean` | `true` | Show upgrade button for free users |

## UpgradeCard

Styled call-to-action card prompting upgrade to Pro. Fully customizable text and features list.

```
import { UpgradeCard } from '@proappstore/sdk/ui'

<UpgradeCard app={app} />
<UpgradeCard
  app={app}
  title="Go Pro"
  description="Get unlimited storage and AI features."
  priceLabel="$5/month"
  features={['Cloud sync', 'AI assistant', 'Priority support']}
/>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `title` | `string` | `"Upgrade to Pro"` | Card heading |
| `description` | `string` | (default text) | Card description |
| `priceLabel` | `string` | `"$5/month"` | Price shown on button |
| `features` | `string[]` | (4 defaults) | Feature list |

## BillingButton

Button that opens the Stripe billing portal for subscription management.

```
import { BillingButton } from '@proappstore/sdk/ui'

<BillingButton app={app} />
<BillingButton app={app} label="Billing settings" variant="ghost" />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `label` | `string` | `"Manage billing"` | Button text |
| `variant` | `'primary' | 'secondary' | 'ghost'` | `'secondary'` | Button style |

## GateScreen

Renders the appropriate gate screen based on state: loading spinner, sign-in prompt, or upgrade card. ProShell renders it for the whole app, so you do not need it at the root. Use it for one Pro-only screen in an app whose shell allows free users:

```tsx
import { GateScreen } from '@proappstore/sdk/ui'
import { useProGate } from '@proappstore/sdk/hooks'

// A screen inside <ProShell app={app} nav={NAV}> (allowFree defaults to true)
function ReportsScreen() {
  const { gate } = useProGate(app, { allowFree: false })
  if (gate !== 'ready') return <GateScreen gate={gate} app={app} appName="Reports" />
  return <Reports />
}
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `gate` | `'loading' | 'signed-out' | 'no-subscription'` | - | Current gate state |
| `app` | `ProAppStore` | - | SDK instance |
| `appName` | `string?` | - | App name for the sign-in screen |

## ProProfilePage

Full-page profile with subscription info, billing management, theme selector, and danger zone. The Pro-enhanced version of ProfilePage.

```
import { ProProfilePage } from '@proappstore/sdk/ui'

<Route path="/profile" element={<ProProfilePage app={app} />} />
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `showThemeToggle` | `boolean` | `true` | Show theme selector |

Shows: avatar + username with PRO badge, subscription status (active/free with upgrade CTA), billing management button, theme preference (system/light/dark), sign out, danger zone with account deletion.

## ProShell

The app frame. It handles auth gates, subscription checks, provider context, the topbar, the **main navigation**, the profile menu, text size control, and the footer. Available at `@proappstore/sdk` and `@proappstore/sdk/shell`.

```tsx
import { ProShell } from '@proappstore/sdk'

<ProShell app={app} appName="My App" nav={[{ label: 'Home', href: '/' }, { label: 'Reports', href: '/reports' }]}>
  <MyAppContent />
</ProShell>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `children` | `ReactNode` | - | App content |
| `appName` | `string?` | - | Topbar name |
| `nav` | `{ label: string; href: string; icon?: ReactNode; title?: string }[]` | - | **The app's screens.** Rendered as the main navigation in the topbar |
| `onNavigate` | `(href: string) => void` | - | Client-side navigation for nav clicks (e.g. a router's `navigate`); without it, items are links |
| `renderNav` | `(ctx) => ReactNode` | - | Replace the built-in NavBar (`ctx`: `items`, `currentPath`, `onNavigate`) |
| `allowFree` | `boolean` | `true` | Skip subscription gate |
| `showThemeToggle` | `boolean` | `true` | Show theme toggle in profile menu |
| `menuItems` | `{ label: string; onClick: () => void }[]` | - | Extra profile dropdown items |
| `hideTopbar` | `boolean` | `false` | Omit the default topbar (and with it the navigation) |
| `hideFooter` | `boolean` | `false` | Omit the default footer |
| `renderTopbar` | `(ctx) => ReactNode` | - | Replace the default topbar; place `ctx.nav` in it |
| `renderFooter` | `(ctx) => ReactNode` | - | Replace the default footer |
| `renderError` | `({ error, reset }) => ReactNode` | - | Replace the error-boundary fallback (the error is already recorded via `app.logs`) |
| `renderLoading` | `() => ReactNode` | - | Replace the spinner shown while a lazy screen loads |

The shell also provides the following without configuration. See the [SDK overview](./sdk-overview.md#resilience-and-feedback-built-in):
- an error boundary and a Suspense fallback;
- `useToast()` for messages in one polite live region;
- an offline banner, plus `useOnline()` for data screens;
- per-route tab titles (a nav item's `title` or `useDocumentTitle`);
- `PageHeader` for the one `h1`;
- a skip link to `<main id="main">`;
- with `onNavigate`, scroll and focus handling on route changes.

### Navigation (`nav`)

Every app with more than one screen passes `nav`. The shell renders it as the built-in `NavBar`:

- A `<nav aria-label="Main">` landmark.
- `aria-current="page"` on the current screen. It follows `location.pathname` and back/forward, and nested routes mark their section.
- A menu button below 640 px (`aria-expanded`, `aria-controls`, Escape to close).
- 44 px targets, visible focus, and token-only styling in both themes.

The styles are injected when the navbar renders, so no setup is needed. They are also available as `@proappstore/sdk/shell.css`. Do not put navigation on a page, and do not add a second bar under the shell.

A custom topbar keeps the gates and places the rendered navigation from the context:

```tsx
<ProShell
  app={app}
  appName="Chess Academy"
  nav={[{ label: 'Students', href: '/students' }, { label: 'Tournaments', href: '/tournaments' }]}
  renderTopbar={({ appName, nav, profileMenu, proBadge, textSizeToggle }) => (
    <header className="top-nav">
      <a href="/" className="brand">{appName}</a>
      {proBadge}
      {nav}
      <div className="account-controls">
        {textSizeToggle}
        {profileMenu}
      </div>
    </header>
  )}
>
  <MyAppContent />
</ProShell>
```

For a fully custom shell, hide the platform chrome and compose the UI primitives directly. `NavBar` is exported for this. The app then provides its own `<nav aria-label="Main">`:

```tsx
<ProShell app={app} appName="My App" hideTopbar hideFooter>
  <MyCustomLayout />
</ProShell>
```

ProShell uses CSS custom properties for theming and uses the `./ui` components internally. Custom topbars should use the provided `nav`, `profileMenu`, `textSizeToggle`, and `proBadge` nodes so navigation and account controls stay consistent.

## Hooks

### useProAuth(app)

```
import { useProAuth } from '@proappstore/sdk/hooks'

const { user, loading, signIn, signOut, deleteAccount } = useProAuth(app)
```

### useTheme()

Zero-provider theme hook. Uses the vendored platform theme localStorage key.

```
import { useTheme } from '@proappstore/sdk/hooks'

const { theme, preference, setPreference } = useTheme()
```

| Return | Type | Description |
| --- | --- | --- |
| `theme` | `'light' | 'dark'` | Resolved theme |
| `preference` | `'light' | 'dark' | 'system'` | User's stored preference |
| `setPreference` | `(pref) => void` | Update preference |

### useProSubscription(app)

```
import { useProSubscription } from '@proappstore/sdk/hooks'

const { subscription, isPro, loading, upgrade, manageBilling } = useProSubscription(app)
```

### useProNotifications(app)

Web push notification state and actions.

```
import { useProNotifications } from '@proappstore/sdk/hooks'

const { permission, isSubscribed, subscribe, unsubscribe, loading } = useProNotifications(app)
```

### useProGate(app)

```
import { useProGate } from '@proappstore/sdk/hooks'

const { gate, user, signIn, upgrade } = useProGate(app)
```

## Patterns

#### Custom topbar with Pro badge

Replace the topbar through ProShell, not with a header of your own above or inside it. The shell keeps the gates and hands you the rendered navigation and account controls:

```tsx
import { ProShell } from '@proappstore/sdk'

<ProShell
  app={app}
  appName="My App"
  nav={NAV}
  renderTopbar={({ appName, nav, proBadge, profileMenu, textSizeToggle }) => (
    <header className="top-nav">
      <span className="brand">{appName} {proBadge}</span>
      {nav}
      {textSizeToggle}
      {profileMenu}
    </header>
  )}
>
  <Screens />
</ProShell>
```

#### Pro-only screen with GateScreen

```tsx
import { GateScreen } from '@proappstore/sdk/ui'
import { useProGate } from '@proappstore/sdk/hooks'

// Inside <ProShell app={app} nav={NAV}>, which lets free users in
function ReportsScreen() {
  const { gate } = useProGate(app, { allowFree: false })
  if (gate !== 'ready') return <GateScreen gate={gate} app={app} />
  return <Reports />
}
```

#### Inline upgrade prompt

```
import { SubscriptionStatus } from '@proappstore/sdk/ui'

// Shows PRO badge or "Free plan [Upgrade]" inline
<SubscriptionStatus app={app} />
```

#### Settings page with subscription

```
import { ProProfilePage } from '@proappstore/sdk/ui'

<Route path="/settings" element={<ProProfilePage app={app} />} />
```

Shows subscription status, billing management, theme preferences, and account deletion.

#### Dark mode in 2 lines

```
import { ThemeToggle } from '@proappstore/sdk/ui'

<ThemeToggle />
```

## Exports

| Import path | What you get |
| --- | --- |
| `@proappstore/sdk` | `initPro`, `ProAppStore`, types; `ProShell`, `NavBar`, `PageHeader`, `useDocumentTitle`, `useToast`, `useOnline`; the hooks; the account components (`Avatar` … `ProProfilePage`). The base components (`Button`, `Card`, `Input`, `Spinner`, `Modal`, `EmptyState`, `Tabs`, `Toast`) are exported only from `/ui`. |
| `@proappstore/sdk/shell` | `ProShell` |
| `@proappstore/sdk/shell.css` | The NavBar and shell styles as a stylesheet. Optional: ProShell injects them at render. |
| `@proappstore/sdk/hooks` | `useProAuth`, `useProSubscription`, `useProGate`, `useProNotifications`, `useTheme` |
| `@proappstore/sdk/ui` | `NavBar`, `PageHeader`, `useDocumentTitle`, `useToast`, `useOnline`, `Avatar`, `SignInButton`, `ThemeToggle`, `TextSizeToggle`, `ProBadge`, `ProfileMenu`, `SubscriptionStatus`, `UpgradeCard`, `BillingButton`, `GateScreen`, `ProProfilePage`, `Button`, `Card`, `Input`, `Spinner`, `Modal`, `EmptyState`, `Tabs`, `Toast` |

## CSS Classes (Design System)

The app scaffold includes a design system in `src/index.css` with CSS custom properties and utility classes. Use these instead of inline Tailwind for consistent styling.

### CSS Variables

| Variable | Purpose |
| --- | --- |
| `var(--accent)` | Brand accent color (configurable per app) |
| `var(--ink)` | Primary text color |
| `var(--muted)` | Secondary/subtle text |
| `var(--paper)` | Page background |
| `var(--line)` | Border color |
| `var(--panel-hover)` | Hover state for panels/rows |
| `var(--danger)` | Error/destructive state (`--danger-soft` for the background) |

### Layout

`.card` — Panel with border, shadow, padding, rounded corners. Used for content sections, list items, forms.

`.empty-state` — Centered message with icon + text + action button. Used for zero-data screens.

### Buttons

.btn .btn-primary
.btn .btn-secondary
.btn .btn-ghost

### Forms

### Badges

.badge .badge-accent
.badge-success
.badge-error

### Typography

| Class | Usage |
| --- | --- |
| `.display-font` | Display/heading font (Fraunces) |
| (body) | Body font (Manrope) — inherited, no class needed |
