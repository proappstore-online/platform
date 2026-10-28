---
description: "Use the ProAppStore UI component library with the Application Standard's accessibility, browser-security and PWA guidance."
---

# UI Component Library

> **App requirements** for UI, accessibility, browser security and PWA behaviour are clauses in the [Application Standard — UI chapter](./standard/ui.md), which also lists what each SDK component provides for accessibility. This page is the component reference those clauses cite.

Drop-in React components for ProAppStore apps: the `AppShell` app frame, composable primitives, and design tokens.

Every app starts the same way: wrap the whole app in [`AppShell`](#appshell) and list its screens in `nav`. The components and hooks on this page build the screens *inside* the shell, or a custom topbar for it. They do not replace it. New to the shell? Start with [Getting Started](./getting-started.md#build-your-app-inside-appshell).

## Choose your level

Every level runs inside AppShell. The level only decides how much of the chrome you customise:

#### Level 1: AppShell (every app)

The default. Auth gates, subscription checks, topbar, the app's main navigation from `nav`, and the resilience layer (error boundary, loading fallback, toasts, offline banner, skip link).

```tsx
<AppShell app={app} appName="My App" nav={[{ label: 'Home', href: '/' }, { label: 'Reports', href: '/reports' }]}>
  <Screens />
</AppShell>
```

#### Level 2: Composable chrome

Your own topbar, built from the SDK components, still inside AppShell. Use `renderTopbar` and place `ctx.nav`, `ctx.profileMenu` and `ctx.textSizeToggle` in it. For a completely different frame, use `hideTopbar` with the exported `NavBar`.

```tsx
<AppShell app={app} nav={NAV} renderTopbar={({ appName, proBadge, nav, textSizeToggle, profileMenu }) => (
  <header className="top-nav">{appName}{proBadge}{nav}{textSizeToggle}{profileMenu}</header>
)}>…</AppShell>
```

#### Level 3: Hooks in screens

Read identity, subscription and theme state inside a screen.

```tsx
import { useProAuth, useTheme } from '@proappstore/sdk/hooks'
```

#### Level 4: Profile page

A dedicated settings screen, listed in `nav` like any other.

```tsx
<AppShell app={app} nav={[{ label: 'Home', href: '/' }, { label: 'Profile', href: '/profile' }]}>
  {location.pathname === '/profile' ? <ProProfilePage app={app} /> : <Home />}
</AppShell>
```

## Design Tokens

SDK components reference the platform's canonical CSS custom properties (the
contract; see [Styling](#styling) for using them as Tailwind utilities). ProAppStore uses a purple accent palette. The
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
| `--danger` / `--success` / `--warning` (+ `-soft`) | light `#c74f43` / `#2f8f57` / `#c6862a`, dark `#ff7a72` / `#74d49a` / `#f0bd6e` | | Semantic status colours |
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

## SignInButtons

One sign-in button per provider: **Sign in with GitHub** and **Sign in with Google**, on by default for every app with no config. GitHub
and Google are separate accounts (no linking). `AppShell`, `GateScreen` and `ProProfilePage` use it for their signed-out screens; narrow
the list with `providers`:

```
import { SignInButtons } from '@proappstore/sdk/ui'

<SignInButtons app={app} />                          {/* GitHub + Google */}
<SignInButtons app={app} providers={['github']} />   {/* GitHub only */}
<AppShell app={app} providers={['github']}>…</AppShell>
```

`useAuth().signIn(provider?)` takes the same provider (`'github'` by default).

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

Avatar button that opens dropdown with Pro features: PRO badge, billing link, theme toggle, sign out, delete account (with double-confirm). Delete account removes the user's data in this app only and runs the app's `app.account.onDelete` handler first. See [Account deletion](./sdk-overview.md#account-deletion-per-app).

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

Renders the appropriate gate screen based on state: loading spinner, sign-in prompt, or upgrade card. AppShell renders it for the whole app, so you do not need it at the root. Use it for one Pro-only screen in an app whose shell allows free users:

```tsx
import { GateScreen } from '@proappstore/sdk/ui'
import { useProGate } from '@proappstore/sdk/hooks'

// A screen inside <AppShell app={app} nav={NAV}> (allowFree defaults to true)
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

<a id="proshell"></a>

## AppShell

The app frame. It handles auth gates, subscription checks, provider context, the topbar, the **main navigation**, the profile menu, text size control, and the footer. Available at `@proappstore/sdk` and `@proappstore/sdk/shell`.

Existing apps may keep importing `ProShell`; it is a deprecated alias for the
same component and remains available for at least one major version.

```tsx
import { AppShell } from '@proappstore/sdk'

<AppShell app={app} appName="My App" nav={[{ label: 'Home', href: '/' }, { label: 'Reports', href: '/reports' }]}>
  <MyAppContent />
</AppShell>
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
<AppShell
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
</AppShell>
```

For a fully custom shell, hide the platform chrome and compose the UI primitives directly. `NavBar` is exported for this. The app then provides its own `<nav aria-label="Main">`:

```tsx
<AppShell app={app} appName="My App" hideTopbar hideFooter>
  <MyCustomLayout />
</AppShell>
```

AppShell uses CSS custom properties for theming and uses the `./ui` components internally. Custom topbars should use the provided `nav`, `profileMenu`, `textSizeToggle`, and `proBadge` nodes so navigation and account controls stay consistent.

## Hooks

### useProAuth(app)

```
import { useProAuth } from '@proappstore/sdk/hooks'

const { user, loading, signIn, signOut, deleteAccount } = useProAuth(app)
```

`deleteAccount()` is `app.account.delete()`. It runs the app's `app.account.onDelete` handler, then deletes the platform's data for the user in **this app only**, then signs out. The ProAppStore sign-in and other apps are untouched.

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

Replace the topbar through AppShell, not with a header of your own above or inside it. The shell keeps the gates and hands you the rendered navigation and account controls:

```tsx
import { AppShell } from '@proappstore/sdk'

<AppShell
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
</AppShell>
```

#### Pro-only screen with GateScreen

```tsx
import { GateScreen } from '@proappstore/sdk/ui'
import { useProGate } from '@proappstore/sdk/hooks'

// Inside <AppShell app={app} nav={NAV}>, which lets free users in
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
| `@proappstore/sdk` | `initPro`, `ProAppStore`, types; `AppShell`, `NavBar`, `PageHeader`, `useDocumentTitle`, `useToast`, `useOnline`; the hooks; the account components (`Avatar` … `ProProfilePage`). The base components (`Button`, `Card`, `Input`, `Spinner`, `Modal`, `EmptyState`, `Tabs`, `Toast`) are exported only from `/ui`. |
| `@proappstore/sdk/shell` | `AppShell` |
| `@proappstore/sdk/shell.css` | The NavBar and shell styles as a stylesheet. Optional: AppShell injects them at render. |
| `@proappstore/sdk/hooks` | `useProAuth`, `useProSubscription`, `useProGate`, `useProNotifications`, `useTheme` |
| `@proappstore/sdk/ui` | `NavBar`, `PageHeader`, `useDocumentTitle`, `useToast`, `useOnline`, `Avatar`, `SignInButton`, `SignInButtons`, `ThemeToggle`, `TextSizeToggle`, `ProBadge`, `ProfileMenu`, `SubscriptionStatus`, `UpgradeCard`, `BillingButton`, `GateScreen`, `ProProfilePage`, `Button`, `Card`, `Input`, `Spinner`, `Modal`, `EmptyState`, `Tabs`, `Toast` |

## Styling

React apps on PAS style with **Tailwind 4 utilities on the PAS design tokens**
([ADR-011](adr/011-tailwind-on-pas-tokens.md)), in three layers, in this order
of preference:

1. **Components** for anything that repeats (buttons, cards, inputs, dialogs,
   empty states): `@proappstore/sdk/ui`, or app-local components (for example a
   `web/src/design-system.tsx`).
2. **Tailwind utilities on token colours** for layout and one-off styling,
   written in the component's `className`.
3. **`web/src/index.css`** holds only `@import "tailwindcss"`, `@source`, the
   token blocks (`:root` and `:root[data-theme='dark']`), `@theme`, and
   `@layer base` / `@layer components`. No unlayered rules, no feature classes,
   no hex outside the token blocks. `@media print` is allowed for print sheets.

Do not grow `index.css` with feature classes (`.invoice-row`, `.hero-card`).
Write the utilities on the element, or lift the repeated markup into a component.

### Token to utility

The `@theme` block maps each [token](#design-tokens) to a Tailwind colour, so
the utilities follow light and dark mode and the app's own token values:

```css
@import "tailwindcss";
@source "../src";

:root { --paper: #f8fafc; --ink: #1e293b; /* …the token values… */ }
:root[data-theme='dark'] { --paper: #0f172a; --ink: #f1f5f9; /* … */ }

@theme inline {
  --color-paper: var(--paper);
  --color-panel: var(--panel);
  --color-ink: var(--ink);
  --color-muted: var(--muted);
  --color-line: var(--line);
  --color-accent: var(--accent);
  --color-danger: var(--danger);
  --radius-pas: var(--radius);
}
```

| Token | Utilities |
| --- | --- |
| `--paper` | `bg-paper` |
| `--panel` | `bg-panel` |
| `--panel-alt` | `bg-panel-alt` |
| `--ink` | `text-ink` |
| `--ink-strong` | `text-ink-strong` |
| `--muted` | `text-muted` |
| `--line` | `border-line`, `divide-line` |
| `--line-strong` | `border-line-strong` |
| `--accent` | `text-accent`, `bg-accent`, `border-accent` |
| `--accent-hover` | `hover:bg-accent-hover` |
| `--accent-soft` | `bg-accent-soft` |
| `--danger` / `--success` / `--warning` | `text-danger`, `bg-danger-soft`, … |
| `--radius` | `rounded-pas` |
| `--radius-sm` | `rounded-pas-sm` |

The old aliases (`--bg`, `--surface`, `--border`, `--glass`, `--error`) stay
banned. Never write `text-[var(--muted)]`: use `text-muted`.

### A conforming component

```tsx
export function Empty({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="rounded-pas border border-line bg-panel p-6 text-center">
      <p className="text-ink">{title}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
```

No class in `index.css`, no hex, and it follows dark mode by itself.

### Fonts and the page title (#499)

Load the brand fonts (Manrope for body text, Fraunces for headings) with a `<link>` in `web/index.html`, not an `@import` in `index.css`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet" />
```

A Google Fonts `@import` with an optical-size range such as `opsz,wght@9..144` breaks Tailwind 4's CSS compilation (`CssSyntaxError: Invalid declaration`, seen in test builds). The *Brand fonts present* check accepts either place; it reads `.css`, `.scss` and `.html` files.

The `<title>` is the app's display name ("Door Drop"), not its id. `pas create` writes the display name into the title and the `og:title` / `twitter:title` metas; the *App title* check warns on a title that is still `APPNAME` or exactly the app's id.

### Branding stays with the app

An app's palette lives in the **values** of the PAS tokens, for example
`--accent: #d86f4d` in `:root` and in the dark block. Migrating an app to this
model changes how the tokens are *used* (utilities instead of bespoke classes),
never what they are *set to*. Keep the app's token values when you migrate.
