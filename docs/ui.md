# UI Component Library

Drop-in React components for ProAppStore apps. Composable primitives, design tokens, and a zero-config shell.

## Choose your level

Pick the abstraction that fits your needs:

#### Level 1: ProShell

Zero-config. Auth gates, subscription checks, topbar.

```
<ProShell app={app}>
  <MyApp />
</ProShell>
```

#### Level 2: Composable

Custom layout with SDK components.

```
import { Avatar, ProfileMenu,
  ThemeToggle } from
  '@proappstore/sdk/ui'
```

#### Level 3: Hooks only

Full control. Build your own UI.

```
import { useProAuth, useTheme }
  from '@proappstore/sdk/hooks'
```

#### Level 4: Profile page

Dedicated settings page for any route.

```
<Route path="/profile"
  element={<ProfilePage
    app={app} />} />
```

## Design Tokens

SDK components reference CSS custom properties. ProAppStore uses a purple accent palette.

| Token | Light | Dark | Purpose |
| --- | --- | --- | --- |
| `--bg` | `#f8fafc` | `#0f172a` | Page background |
| `--surface` | `#ffffff` | `#1e293b` | Card/panel background |
| `--ink` | `#1e293b` | `#f1f5f9` | Primary text |
| `--muted` | `#64748b` | `#94a3b8` | Secondary text |
| `--border` | `#e2e8f0` | `#334155` | Borders |
| `--accent` | `#7c3aed` | `#a78bfa` | Primary action (purple) |
| `--accent-hover` | `#6d28d9` | `#7c3aed` | Action hover |
| `--accent-soft` | `#f5f3ff` | `#2e1065` | Accent background |
| `--ink-strong` | `#0f172a` | `#ffffff` | Emphasized text |
| `--surface-2` | `#f1f5f9` | `#0f172a` | Secondary surface |
| `--border-strong` | `#cbd5e1` | `#475569` | Strong borders |
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
  priceLabel="$9/month"
  features={['Cloud sync', 'AI assistant', 'Priority support']}
/>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `title` | `string` | `"Upgrade to Pro"` | Card heading |
| `description` | `string` | (default text) | Card description |
| `priceLabel` | `string` | `"$9/month"` | Price shown on button |
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

Renders the appropriate gate screen based on state: loading spinner, sign-in prompt, or upgrade card. Used internally by ProShell, but available for custom layouts.

```
import { GateScreen } from '@proappstore/sdk/ui'
import { useProGate } from '@proappstore/sdk/hooks'

function App() {
  const { gate, ...rest } = useProGate(app)
  if (gate !== 'ready') return <GateScreen gate={gate} app={app} appName="My App" />
  return <MyApp />
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

The original zero-config shell. Handles auth gates, subscription checks, topbar. Still available at `@proappstore/sdk/shell`.

```
import { ProShell } from '@proappstore/sdk/shell'

<ProShell app={app} appName="My App">
  <MyAppContent />
</ProShell>
```

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `app` | `ProAppStore` | - | SDK instance |
| `children` | `ReactNode` | - | App content |
| `appName` | `string?` | - | Topbar name |
| `allowFree` | `boolean` | `true` | Skip subscription gate |
| `showThemeToggle` | `boolean` | `true` | Show theme toggle in profile menu |

ProShell now uses CSS custom properties for theming, includes a footer, and uses the `./ui` components internally. For custom layouts, use the primitives directly.

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

```
import { Avatar, ThemeToggle, ProBadge } from '@proappstore/sdk/ui'
import { useProAuth, useProSubscription } from '@proappstore/sdk/hooks'

function MyHeader() {
  const { user } = useProAuth(app)
  const { isPro } = useProSubscription(app)
  return (
    <header>
      <h1>My App {isPro && <ProBadge />}</h1>
      <ThemeToggle />
      {user && <Avatar user={user} />}
    </header>
  )
}
```

#### Custom gate with GateScreen

```
import { GateScreen } from '@proappstore/sdk/ui'
import { useProGate } from '@proappstore/sdk/hooks'

function App() {
  const { gate } = useProGate(app)
  if (gate !== 'ready') return <GateScreen gate={gate} app={app} />
  return <MyApp />
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
| `@proappstore/sdk` | `initPro`, `ProAppStore`, types |
| `@proappstore/sdk/hooks` | `useProAuth`, `useProSubscription`, `useProGate`, `useProNotifications`, `useTheme` |
| `@proappstore/sdk/shell` | `ProShell` |
| `@proappstore/sdk/ui` | `Avatar`, `SignInButton`, `ThemeToggle`, `ProBadge`, `ProfileMenu`, `SubscriptionStatus`, `UpgradeCard`, `BillingButton`, `GateScreen`, `ProProfilePage` |

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
| `var(--error)` | Error/destructive state |

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
