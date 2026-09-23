# UI, browser security, and PWA

**Standard version 1.5** · Chapter `UI` · Part of the [Application Standard](./index.md)

**Scope.** UI components, browser security headers and storage, accessibility, responsive and mobile behaviour, PWA.

Clause IDs in this chapter have the form `PAS-UI-<NNN>`; see the
[clause ID grammar](./governance.md#clause-id-grammar). Each clause follows the
[clause template](./governance.md#clause-template) and is audited under the
[audit model](./audit-model.md). Each clause also carries a **Kind** —
*Security*, *Quality*, or *Accessibility (quality)* — so that a security
finding is never confused with a polish recommendation.

## What the platform already does for every app

The host worker serves every file of every app (platform subdomain or custom
domain) with `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()`
and a platform Content-Security-Policy whose `frame-ancestors` admits only the
app itself and the first-party surfaces (store, console, dashboard, admin,
agents). Hashed assets are immutable, HTML is revalidated, source maps are
refused, and `/.pas/*` is reserved before static serving. Uploads through
`app.storage` are capped at 50 MB, refuse HTML/JavaScript/SVG types, and are
served with `nosniff`. Logout and `/.pas/auth/recover` clear Cache Storage.
That is the **automated floor** ([PAS-UI-012](#pas-ui-012)); the clauses say
what the app must do on top of it — and what it must not undo.

## What the scanner proves, and what needs a browser

`pas check` (also the template's `prebuild`, the VibeCode agent, and a weekly
live audit) runs the platform compliance checks. This table maps each to the
clause it evidences. Everything in the right-hand column is **not** provable
statically and needs a browser test or a person ([PAS-UI-023](#pas-ui-023)).

| Compliance check | Status on fail | Evidences clause | What it does not prove |
|---|---|---|---|
| Brand fonts present · Brand tokens defined · No brand overrides · Store link | fail | [001](#pas-ui-001) | that the UI *looks* consistent |
| Dark mode support | warn | [002](#pas-ui-002) | that dark tokens have contrast; that the boot script and toggle agree |
| Accessibility static | fail | [004](#pas-ui-004) | names on links/inputs/custom controls; focus; rendered ARIA |
| HTML meta tags · Viewport support | fail | [008](#pas-ui-008) | that the app works at the declared width |
| No unsafe 100vh | fail | [010](#pas-ui-010) | safe-area padding; iOS first-load scroll |
| PWA manifest · PWA maskable icon · PWA meta tags | fail | [020](#pas-ui-020) | that install actually launches standalone |
| PWA offline correctness | fail | [018](#pas-ui-018), [019](#pas-ui-019) | that no authenticated response is cached; offline UX |
| Bundle size | fail (warn if unbuilt) | [021](#pas-ui-021) | code-splitting quality |
| No tracking SDKs · No .env.production · No template placeholders · MIT License | fail | [022](#pas-ui-022) | dependency behaviour; licence intent (see the MIT caveat) |
| No scroll | fail (games only) | — | not applicable to apps |
| CLAUDE.md slim | warn | — | documentation hygiene, not a UI clause |
| *(none)* | — | [003](#pas-ui-003), [005](#pas-ui-005), [006](#pas-ui-006), [007](#pas-ui-007), [009](#pas-ui-009), [011](#pas-ui-011), [013](#pas-ui-013)–[017](#pas-ui-017) | landmarks, keyboard, contrast, zoom, layout at 360 px, states, per-app CSP, XSS sinks, URL validation, uploads, framing |

## Known scaffold defects this chapter detects

| Defect | Where | Clause |
|---|---|---|
| `user-scalable=no` in the viewport meta (blocks zoom, WCAG 1.4.4) | `template-app/web/index.html` | [PAS-UI-007](#pas-ui-007) |
| Theme boot script reads `fas:theme`; SDK and design system use `stores-theme` | `template-app/web/index.html` vs `@proappstore/sdk` `useTheme` | [PAS-UI-002](#pas-ui-002) |
| Banned token aliases (`--bg`, `--surface`, `--border`, `--glass`, `--dock`) defined as compatibility mappings | `template-app/web/src/index.css` | [PAS-UI-001](#pas-ui-001) |
| Platform CSP allows `script-src 'unsafe-inline'` | host worker header | [PAS-UI-013](#pas-ui-013) (app-level tightening) |

## Security versus quality

| Kind | Clauses | Failure means |
|---|---|---|
| **Security** | [012](#pas-ui-012), [013](#pas-ui-013), [014](#pas-ui-014), [015](#pas-ui-015), [016](#pas-ui-016), [017](#pas-ui-017), [018](#pas-ui-018), [022](#pas-ui-022) | a user's session, data or device can be attacked through the UI |
| **Accessibility (quality)** | [003](#pas-ui-003), [004](#pas-ui-004), [005](#pas-ui-005), [006](#pas-ui-006), [007](#pas-ui-007), [023](#pas-ui-023) | some users cannot use the app |
| **Quality** | [001](#pas-ui-001), [002](#pas-ui-002), [008](#pas-ui-008), [009](#pas-ui-009), [010](#pas-ui-010), [011](#pas-ui-011), [019](#pas-ui-019), [020](#pas-ui-020), [021](#pas-ui-021) | the app is inconsistent, slow, or breaks on some devices |

## SDK components and their accessibility status

From `@proappstore/sdk/ui` and `/shell` (see [UI components](../ui.md)):

| Component | Provides | Still on the app |
|---|---|---|
| `ProShell` | `<header>`, `<main>`, auth and subscription gates, topbar | `<nav>` landmark, headings, titles ([003](#pas-ui-003)) |
| `Modal` | `role="dialog"`, `aria-modal`, `aria-label` from `title`, Escape to close, labelled close button | focus return to the opener; initial focus placement ([005](#pas-ui-005)) |
| `Tabs` | `tablist` / `tab` / `aria-selected` / `tabpanel` | arrow-key navigation between tabs |
| `Toast` | `role="status"`, `aria-live="polite"`, labelled dismiss | — |
| `Input` | `<label htmlFor>`, `aria-invalid` | error text association |
| `Spinner` | `role="status"`, `aria-label="Loading"` | — |
| `ThemeToggle`, `TextSizeToggle` | `aria-label` with current state | — |
| `Button`, `Card`, `EmptyState`, `Avatar`, `SignInButton`, `ProBadge`, `SubscriptionStatus`, `UpgradeCard`, `BillingButton`, `GateScreen`, `ProfileMenu`, `ProProfilePage` | visible text names on controls | icon-only uses need `aria-label`; no other ARIA is provided ([004](#pas-ui-004)) |

## Capability pages this chapter builds on

Clauses link to these as *Supporting links*; they describe what the platform
provides and are not restated here.

- [UI components](../ui.md)
- [Recipes](../recipes.md)
- [Architecture](../architecture.md)
- [Browser auth session model](../auth-session-model.md)
- [Build and deploy](../build-and-deploy.md)
- `~/dev/stores/DESIGN-SYSTEM.md` (shared design system; enforced by `scripts/check-design-system.sh`)

## Clauses

### PAS-UI-001 — The UI is built from the SDK shell or components on the platform's design tokens {#pas-ui-001}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance checks *Brand fonts present*, *Brand tokens defined*, *No brand overrides*, *Store link*; platform CI design-system lint (`scripts/check-design-system.sh`) · **Since:** 1.4 · **Kind:** Quality

**Rule.** The app SHOULD build its chrome with `ProShell` or the composable `@proappstore/sdk/ui` components and MUST style with the canonical tokens (`--paper`, `--ink`, `--accent`, `--line`, `--panel`, `--muted`, the status and radius tokens) and the brand fonts (Manrope body, Fraunces display). It MUST NOT redefine those tokens, add other font families, or use the banned aliases `--bg`, `--surface`, `--border`, `--glass`, `--dock`. Every app MUST link to `proappstore.online`.

**Applicability.** All apps with a user interface.

**Rationale.** One design system is what makes the store feel like one product and lets the components carry accessible behaviour the app would otherwise re-implement. Aliases split the token set and defeat the lint; overrides change the brand per app.

**Recommended implementation.** Level 1: `<ProShell app={app}>`; Level 2: compose `Avatar`, `ProfileMenu`, `ThemeToggle`, `Button`, `Card`, `Input`, `Modal`, `Tabs`, `Toast`, `EmptyState`; Level 3: hooks only, still on the tokens. Use `var(--accent)` etc. in app CSS; never assign to them.

**Conforming example.**

```css
.hero { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius); }
```

**Non-conforming example.**

```css
:root { --accent: #ff0000; --bg: #fff; }         /* override + banned alias */
h1 { font-family: "Comic Sans MS"; }
```

**Evidence.** Source: `@proappstore/sdk/ui` imports; token assignments and `font-family` declarations in `web/src/**/*.css` and inline styles; `pas check` output for the four checks. The template's own `index.css` still *defines* the banned aliases as compatibility mappings — an app MUST NOT reference them.

**Remediation.** Adopt the components; delete overrides and alias references; run `pas check` and `bash scripts/check-design-system.sh web` until clean.

**Tests.** `pas check` passes the listed checks; `grep -rn 'var(--bg)\|var(--surface\|var(--border\b' web/src` is empty.

**Supporting links.** [UI components — choose your level](../ui.md#choose-your-level), [UI — design tokens](../ui.md#design-tokens), [PAS-STACK-022](./stack.md#pas-stack-022).

### PAS-UI-002 — Dark mode is the `data-theme` attribute driven by the `stores-theme` preference {#pas-ui-002}

**Severity:** Low · **Verification:** Manual · **Enforcement:** automated — compliance check *Dark mode support* (warn only); platform CI design-system lint rejects `html.dark`, `classList` dark toggles and non-`stores-theme` keys · **Since:** 1.4 · **Kind:** Quality

**Rule.** The app MUST support the dark scheme by styling `:root[data-theme="dark"]` and MUST read and write the user's preference only through `useTheme` / `ThemeToggle`, which persist to `localStorage['stores-theme']` and set `document.documentElement.dataset.theme`. It MUST NOT use a `.dark` class, a second storage key, or `prefers-color-scheme` media queries to *apply* styles (they may be read to choose the default). The inline boot script in `index.html` MUST read the same `stores-theme` key.

**Applicability.** All apps with a user interface.

**Rationale.** Two mechanisms produce a first paint that disagrees with the toggle. **Known discrepancy:** the app scaffold's `index.html` boot script reads `fas:theme` while the SDK's `useTheme` and `DESIGN-SYSTEM.md` use `stores-theme`; `stores-theme` is canonical. An app generated from the template inherits the split until it edits the boot script.

**Recommended implementation.** Keep the template's boot script but change its key to `stores-theme`; define dark tokens under `:root[data-theme="dark"]`; render `<ThemeToggle />`.

**Conforming example.**

```html
<script>
  (function(){ var p = localStorage.getItem('stores-theme') || 'system';
    var dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.dataset.theme = 'dark'; })();
</script>
```

**Non-conforming example.**

```html
<script>var pref = localStorage.getItem('fas:theme') ...</script>   <!-- different key from useTheme -->
<style>html.dark { --paper: #111 }</style>                            <!-- class, not data-theme -->
```

**Evidence.** Source: `web/index.html` boot script key; CSS selectors for dark tokens; `localStorage` keys containing `theme` (`grep -rn "theme" web/index.html web/src`).

**Remediation.** Change the key; move dark tokens to `[data-theme="dark"]`; remove class toggles.

**Tests.** Toggling via `ThemeToggle` and reloading keeps the chosen scheme with no flash; `document.documentElement.dataset.theme` and `localStorage['stores-theme']` agree.

**Supporting links.** [UI — ThemeToggle](../ui.md#themetoggle), [UI — patterns](../ui.md#patterns), `~/dev/stores/DESIGN-SYSTEM.md` §3.

### PAS-UI-003 — Pages use semantic landmarks, one `h1`, ordered headings and a per-route title {#pas-ui-003}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Accessibility (quality)

**Rule.** Every page MUST have `<header>`, `<main>` and, where there is site navigation, `<nav>` landmarks; exactly one `h1`; heading levels that do not skip; and a `document.title` that changes per route. Apps with more than a handful of links SHOULD provide a skip-to-content link as the first focusable element.

**Applicability.** All apps with a user interface.

**Rationale.** Screen-reader users navigate by landmark and heading; a page that is one `<div>` soup has no structure to navigate. `ProShell` provides `<header>` and `<main>` but not `<nav>`; composable layouts provide none.

**Recommended implementation.** In `ProShell`, put route navigation in a `<nav aria-label="Main">` inside the shell's children; set the title in a route effect; add `<a href="#main" class="skip-link">`.

**Conforming example.**

```tsx
useEffect(() => { document.title = `${task.title} — My App` }, [task.title])
<nav aria-label="Main"><NavLink to="/tasks">Tasks</NavLink></nav>
<main id="main"><h1>{task.title}</h1>…</main>
```

**Non-conforming example.**

```tsx
<div className="topbar">…</div><div className="content"><div className="big">Tasks</div>…</div>   // no landmarks, no heading
```

**Evidence.** Source: JSX for `header`/`nav`/`main`, heading elements, title effects; Runtime: the browser's accessibility tree (devtools → Accessibility) on each route.

**Remediation.** Add the landmarks and headings; set titles per route.

**Tests.** Browser: the accessibility tree shows banner/navigation/main on every route and one level-1 heading; the tab title changes on navigation.

**Supporting links.** [UI — ProShell](../ui.md#proshell), [Recipes — UI patterns](../recipes.md#ui-patterns).

### PAS-UI-004 — Every interactive element has an accessible name and every input a label {#pas-ui-004}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — compliance check *Accessibility static* (buttons with no text and no `aria-label` only) · **Since:** 1.4 · **Kind:** Accessibility (quality)

**Rule.** Every button, link, icon control and form field MUST expose an accessible name: visible text, `aria-label`, `aria-labelledby`, or a `<label htmlFor>`. Icon-only controls MUST carry `aria-label`; decorative images MUST have `alt=""`; informative images MUST have descriptive `alt`. Interactive elements MUST be native `<button>`/`<a>`/`<input>` or carry the equivalent role and keyboard behaviour.

**Applicability.** All apps with a user interface.

**Rationale.** A control with no name is announced as "button" — unusable without sight. The static check catches the crudest case in buttons; links, custom controls and images are invisible to it.

**Recommended implementation.** Use the SDK `Button`/`Input` (the latter associates its label and `aria-invalid`); for icons use `lucide-react` with `aria-label` on the control and `aria-hidden` on the svg.

**Conforming example.**

```tsx
<Input label="Email" value={email} onChange={…} />
<button aria-label="Close" onClick={close}><X aria-hidden /></button>
<img src={logo} alt="" />
```

**Non-conforming example.**

```tsx
<div onClick={close}><X /></div>                 // not focusable, no name, no role
<input placeholder="Email" />                        // placeholder is not a label
```

**Evidence.** Source: `grep -rn "onClick" web/src` on non-button elements; inputs without `label`/`aria-label`; icon-only buttons; `<img` without `alt`.

**Remediation.** Replace divs with buttons; add labels; add `alt`.

**Tests.** Browser: devtools accessibility tree shows a name for every focusable element; `pas check` *Accessibility static* passes.

**Supporting links.** [UI — components](../ui.md#choose-your-level), [Recipes — icons](../recipes.md#ui-patterns).

### PAS-UI-005 — Everything works from the keyboard: visible focus, Tab order, Escape, no traps, focus return {#pas-ui-005}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Accessibility (quality)

**Rule.** All functionality MUST be reachable and operable with Tab/Shift-Tab, Enter/Space and arrow keys where a widget convention exists. Focus MUST be visible (`:focus-visible` styles never removed without replacement), MUST follow reading order, MUST move into an opened dialog and return to the opener on close, MUST NOT be trapped except inside an open modal, and Escape MUST close any dialog, menu or popover.

**Applicability.** All apps with a user interface.

**Rationale.** Keyboard operability is the baseline for screen readers, switch access and power users. The SDK `Modal` handles Escape, `role="dialog"` and `aria-modal`; custom overlays usually miss focus management entirely.

**Recommended implementation.** Use `Modal`, `Tabs`, `ProfileMenu` from the SDK; for custom widgets, follow the WAI-ARIA Authoring Practices pattern; keep `outline` (or a visible replacement) on `:focus-visible`.

**Conforming example.**

```tsx
<Modal open={open} onClose={() => setOpen(false)} title="Edit task">…</Modal>   // Escape + aria-modal handled
// css: :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
```

**Non-conforming example.**

```css
*:focus { outline: none; }                       /* focus invisible everywhere */
/* custom overlay: div with onClick backdrop, no Escape, focus stays behind it */
```

**Evidence.** Source: `outline: none`/`outline: 0` without a replacement; custom overlay components; `tabIndex={-1}` on interactive elements; Runtime: a keyboard walk.

**Remediation.** Restore focus styles; replace custom overlays with `Modal` or add focus management; fix tab order.

**Tests.** Browser test (qa-spec `press` steps or Playwright): Tab through the main flow, open a dialog, Escape closes it and focus returns; no element is unreachable.

**Supporting links.** [UI — Modal and Tabs](../ui.md#choose-your-level), [Recipes — modal](../recipes.md#ui-patterns).

### PAS-UI-006 — Text meets contrast minimums in both schemes {#pas-ui-006}

**Severity:** Medium · **Verification:** Human · **Enforcement:** none (recommended) — no automated contrast scanner exists on the platform · **Since:** 1.4 · **Kind:** Accessibility (quality)

**Rule.** Normal text MUST reach a contrast ratio of at least 4.5:1 and large text (≥ 24 px, or ≥ 19 px bold) and UI component boundaries at least 3:1 against their background, in both the light and dark schemes. Colour MUST NOT be the only means of conveying state (add text, an icon, or a pattern).

**Applicability.** All apps with a user interface.

**Rationale.** The platform tokens meet these ratios in their defaults; app-chosen colours, `--muted` on tinted panels, and gradients are where failures appear. Nothing in `pas check`, the live audit or the QA runner measures contrast, so this is a human check with browser tooling.

**Recommended implementation.** Use `--ink` on `--paper`/`--panel` and `--muted` only for secondary text on plain backgrounds; check custom pairs with the browser's contrast picker or axe DevTools in both schemes.

**Conforming example.**

```css
.hint { color: var(--muted); }            /* on --paper: passes in the default palette */
.status-error { color: var(--danger); } .status-error::before { content: "⚠ "; }
```

**Non-conforming example.**

```css
.hint { color: #bbb; background: #fff; }   /* ≈ 1.9:1 */
.row.overdue { background: #ffe9e9; }        /* colour is the only signal */
```

**Evidence.** Runtime: contrast measurements for each custom colour pair in light and dark; Source: hard-coded colours outside the token set.

**Remediation.** Switch to tokens or adjust the colour; add a non-colour indicator.

**Tests.** Human: axe DevTools (or the devtools colour picker) reports no contrast violations on the main routes in both schemes; the auditor records the pairs checked.

**Supporting links.** [UI — design tokens](../ui.md#design-tokens), [Audit model — verification classes](./audit-model.md#verification-classes).

### PAS-UI-007 — Zoom is never blocked — no `user-scalable=no`, no `maximum-scale` {#pas-ui-007}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Accessibility (quality)

**Rule.** The viewport meta MUST NOT contain `user-scalable=no` or a `maximum-scale` below 5. The app MUST be usable at 200% browser zoom and with the text-size toggle at `lg` without loss of content or function (WCAG 1.4.4 / 1.4.10). **Known violation:** the app scaffold's `index.html` ships `user-scalable=no`; an app MUST remove it before publishing, or record a justified exception in the audit (an exception is expected only for full-screen games and canvas tools where pinch is a gesture the app itself consumes).

**Applicability.** All apps with a user interface.

**Rationale.** Blocking zoom locks out low-vision users on every mobile browser that honours the flag. It was added to templates to stop accidental pinch in game-like UIs; for ordinary apps it is a defect that ships by default.

**Recommended implementation.** `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`; keep `TextSizeToggle`; test at 200%.

**Conforming example.**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

**Non-conforming example.**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />   <!-- template default -->
```

**Evidence.** Source: `web/index.html` viewport meta — **direct audit rule:** `grep -n "user-scalable=no\|maximum-scale" web/index.html`; a hit without a documented exception is a `fail`.

**Remediation.** Remove the attribute; verify layouts at 200% zoom and `lg` text size; document any exception with the reason.

**Tests.** Browser: pinch-zoom works on a phone; at 200% desktop zoom no content is clipped or unreachable.

**Supporting links.** [UI — TextSizeToggle](../ui.md#choose-your-level), [PAS-UI-008](#pas-ui-008).

### PAS-UI-008 — The viewport meta and manifest declare what the app supports {#pas-ui-008}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance checks *HTML meta tags* (`lang`, viewport, title, preview images) and *Viewport support* (manifest `orientation` + `min_viewport_width`) · **Since:** 1.4 · **Kind:** Quality

**Rule.** `web/index.html` MUST declare `<html lang>`, a viewport meta with `width=device-width, initial-scale=1` (and `viewport-fit=cover` for safe areas), a non-empty `<title>`, and Open Graph / Twitter preview images. The manifest MUST declare `orientation` (`any` unless the app truly needs one) and `min_viewport_width` (360 for phone-first apps; 320 if the app is verified there), and the app MUST actually work at that width.

**Applicability.** All apps with a user interface.

**Rationale.** The storefront renders a device-coverage badge from these fields; a declared width the app does not meet is a false promise, and a missing viewport meta renders the desktop layout on phones.

**Recommended implementation.** Keep the template's `index.html` head and `vite.config.ts` manifest; change `min_viewport_width` only when verified; set `orientation` to a single value only for games.

**Conforming example.**

```text
manifest: { orientation: 'any', min_viewport_width: 360, display: 'standalone', … }
<html lang="en"> <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

**Non-conforming example.**

```text
<html>   <!-- no lang -->   <!-- no viewport meta -->   manifest without orientation / min_viewport_width
```

**Evidence.** Source: `web/index.html` head; `vite.config.ts` manifest block (or `web/public/manifest.json`); Runtime: layout at the declared width.

**Remediation.** Restore the fields; verify at the declared width.

**Tests.** `pas check` passes both checks; browser at `min_viewport_width` shows no clipping ([PAS-UI-009](#pas-ui-009)).

**Supporting links.** [PAS-UI-020](#pas-ui-020).

### PAS-UI-009 — Layouts hold at 360 px: no horizontal scroll, no overflowing text or URLs, touch targets ≥ 44 × 44 {#pas-ui-009}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Quality

**Rule.** At the declared minimum width and at the platform's mobile breakpoint (≤ 640 px) the document MUST NOT scroll horizontally, long strings and URLs MUST wrap or truncate (`overflow-wrap: anywhere` / `min-width: 0` on flex children / `text-overflow: ellipsis`), and every touch target MUST be at least 44 × 44 CSS px (or have equivalent spacing).

**Applicability.** All apps with a user interface.

**Rationale.** Horizontal scroll and clipped text are the two most common mobile failures; both are invisible in desktop development. Small targets fail motor-impaired and thumb users alike.

**Recommended implementation.** Use fluid layouts (`grid`/`flex` with `min-width: 0`), `max-width: 100%` on media, `overflow-wrap: anywhere` on user content, and the SDK `Button` (which meets the target size); collapse navigation into the shell's mobile pattern at ≤ 640 px.

**Conforming example.**

```css
.cell { min-width: 0; overflow-wrap: anywhere; }
.icon-btn { min-width: 44px; min-height: 44px; }
```

**Non-conforming example.**

```css
.table { width: 900px; }                      /* fixed width → horizontal scroll */
.chip { padding: 2px 4px; font-size: 11px; }   /* ~18 px target */
```

**Evidence.** Runtime: `document.documentElement.scrollWidth <= innerWidth` at 360 px and 640 px; long-URL fixture rendering; target sizes via devtools; Source: fixed widths, missing `min-width: 0`.

**Remediation.** Fix the widths; add wrapping; enlarge targets.

**Tests.** Browser test at 360 px and 640 px (qa-spec `screenshot` steps or Playwright viewport): no horizontal scroll, a 200-character URL wraps, all controls ≥ 44 px.

**Supporting links.** [Recipes — UI patterns](../recipes.md#ui-patterns), `~/dev/stores/DESIGN-SYSTEM.md` §5 (mobile ≤ 640 px).

### PAS-UI-010 — Safe areas and viewport units are handled with `env()` and `svh`/`dvh` {#pas-ui-010}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance check *No unsafe 100vh* (source scan for `100vh` and Tailwind `h-screen`) · **Since:** 1.4 · **Kind:** Quality

**Rule.** Full-height layouts MUST use `100svh` or `100dvh` (never `100vh`) and any element touching a screen edge MUST pad with `env(safe-area-inset-*)` when `viewport-fit=cover` is set. Fixed bottom bars MUST account for the home indicator.

**Applicability.** All apps with a user interface; mandatory for apps with full-height or edge-anchored UI.

**Rationale.** On iOS Safari `100vh` is taller than the visible area while the URL bar shows, forcing a scroll on first load — invisible to headless testing. With `viewport-fit=cover` the notch and home indicator overlap unpadded content.

**Recommended implementation.** `min-height: 100svh` for the shell; `padding-bottom: env(safe-area-inset-bottom)` on bottom bars; `100dvh` where the layout should follow the URL bar.

**Conforming example.**

```css
.app { min-height: 100svh; }
.bottom-bar { padding-bottom: calc(0.5rem + env(safe-area-inset-bottom)); }
```

**Non-conforming example.**

```css
.app { height: 100vh; }            /* flagged by pas check */
.bottom-bar { bottom: 0; }          /* under the home indicator */
```

**Evidence.** Source: `100vh`, `h-screen`, `min-h-screen`; `env(safe-area` usage with `viewport-fit=cover` present.

**Remediation.** Replace the units; add the insets.

**Tests.** `pas check` passes *No unsafe 100vh*; on an iPhone (or the simulator) the first load does not scroll and bottom controls sit above the indicator.

**Supporting links.** [Recipes — UI patterns](../recipes.md#ui-patterns).

### PAS-UI-011 — Every asynchronous surface has loading, empty and error states {#pas-ui-011}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Quality

**Rule.** Each screen or component that waits on data MUST render a loading state (SDK `Spinner` or a skeleton), an empty state (`EmptyState` with an action) when the result is legitimately empty, and an error state with retry when the call fails — and MUST NOT collapse the last two ([PAS-DATA-021](./data.md#pas-data-021)).

**Applicability.** All apps with a user interface.

**Rationale.** A blank screen during a fetch reads as broken; an error rendered as "no items" hides outages; an empty state with no action strands new users.

**Recommended implementation.** Model `{ kind: 'loading' | 'ok' | 'empty' | 'error' }` per query; render the SDK components; keep the error message actionable.

**Conforming example.**

```tsx
if (s.kind === 'loading') return <Spinner />
if (s.kind === 'error') return <EmptyState title="Couldn't load tasks" action={<Button onClick={reload}>Retry</Button>} />
if (s.rows.length === 0) return <EmptyState title="No tasks yet" action={<Button onClick={create}>Add a task</Button>} />
```

**Non-conforming example.**

```tsx
{rows.length === 0 && <p>No tasks</p>}      // also shown while loading and after a failure
```

**Evidence.** Source: list components — presence of the three states; `.catch(() => [])` patterns.

**Remediation.** Add the states; separate error from empty.

**Tests.** Browser: throttling to offline shows the error state with retry; a new account sees the empty state with its action.

**Supporting links.** [UI — EmptyState and Spinner](../ui.md#choose-your-level), [PAS-DATA-021](./data.md#pas-data-021).

### PAS-UI-012 — The platform's response headers are the security floor and are not weakened {#pas-ui-012}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — the host worker sets on every served file: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()`, and the platform `Content-Security-Policy` (`default-src 'self'`; `script-src 'self' 'unsafe-inline'` + API + Cloudflare Insights; `style-src 'self' 'unsafe-inline'` + Google Fonts; `font-src 'self'` + gstatic; `img-src 'self' data: blob: https:`; `connect-src 'self'` + `*.proappstore.online` + wss + fonts + insights; `frame-ancestors 'self'` + the first-party surfaces; `base-uri 'self'`; `form-action 'self'`) · **Since:** 1.4 · **Kind:** Security

**Rule.** The app MUST work within the platform headers and MUST NOT design around them: no scripts, styles, fonts, frames or connections to origins outside the policy, no `<base>` changes, no forms posting elsewhere. Where the app needs camera, microphone or payment APIs it MUST record that they are disabled by `Permissions-Policy` and file a platform request rather than working around it. An app-level `<meta http-equiv>` MAY only tighten ([PAS-UI-013](#pas-ui-013)); it cannot loosen a header policy.

**Applicability.** All hosted apps.

**Rationale.** These headers are set by the host worker for every file on the app's origin and on custom domains; they are the automated floor for XSS blast radius, MIME sniffing, referrer leakage and clickjacking. An app that needs a third-party script or an external fetch has either found a missing platform capability or is adding a dependency the standard forbids.

**Recommended implementation.** Serve everything from the app's own origin (bundled) or the platform; call third parties through `app.proxy`; keep fonts on Google Fonts or self-hosted.

**Conforming example.**

```text
<script src="/assets/index-abc123.js">            same-origin bundle
app.proxy.fetch('api.example.com/…')                external API via the platform
```

**Non-conforming example.**

```text
<script src="https://cdn.example.com/widget.js">   blocked by script-src (and a substitute dependency)
fetch('https://api.example.com/…')                  blocked by connect-src
```

**Evidence.** Runtime: `curl -sI https://<app>.proappstore.online/` shows the headers; browser console has no CSP violation reports on the main routes; Source: third-party `src`/`href`/`fetch` targets.

**Remediation.** Remove or proxy the external dependency; file a platform issue for a genuinely needed permission.

**Tests.** No CSP violations in the console across the main routes; the headers are present on the app's origin and each custom domain.

**Supporting links.** [Architecture](../architecture.md), [PAS-STACK-015](./stack.md#pas-stack-015), [PAS-UI-017](#pas-ui-017).

### PAS-UI-013 — Apps ship a stricter per-app CSP: hashed inline, no `unsafe-inline`/`unsafe-eval` for scripts, `object-src 'none'` {#pas-ui-013}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Security

**Rule.** The app SHOULD add a `<meta http-equiv="Content-Security-Policy">` in `index.html` that is stricter than the platform header for `script-src`: no `'unsafe-inline'`, no `'unsafe-eval'`, the theme boot script allowed by its SHA-256 hash, `object-src 'none'`, `base-uri 'self'`, and `form-action 'self'`; and SHOULD keep a test that recomputes the hash and asserts the directives, so the policy cannot rot silently.

**Applicability.** All hosted apps; MUST for apps that render any user-generated content.

**Rationale.** The platform header keeps `script-src 'unsafe-inline'` for compatibility, which means an injected inline `<script>` still runs. Browsers apply the intersection of header and meta policies, so an app can close that gap itself. Chess Academy's `csp.test.ts` is the reference: it pins the inline-script hash, the directive set, and a no-HTML-sinks invariant.

**Recommended implementation.** Compute the hash of the exact boot-script text (`sha256`, base64); write the meta before any script; add a vitest that reads `index.html`, recomputes the hash and asserts `script-src` contains it and not `'unsafe-inline'`.

**Conforming example.**

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'sha256-…' https://api.proappstore.online https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://api.proappstore.online https://*.proappstore.online wss://*.proappstore.online; object-src 'none'; base-uri 'self'; form-action 'self'">
```

**Non-conforming example.**

```html
<!-- no meta CSP: the platform's 'unsafe-inline' script-src is the effective policy -->
<meta http-equiv="Content-Security-Policy" content="script-src * 'unsafe-eval'">   <!-- looser than the header: ignored, and a signal -->
```

**Evidence.** Source: the meta tag in `web/index.html`; a test that parses it (`grep -rln "Content-Security-Policy" web/src`); Runtime: no CSP violations after the tightening.

**Remediation.** Add the meta and the test; move any inline handlers into the bundle; hash the boot script.

**Tests.** The test passes; the app runs with no violation reports; an injected inline `<script>` in a fixture does not execute.

**Supporting links.** [PAS-UI-012](#pas-ui-012), [PAS-UI-014](#pas-ui-014), `proappstore-online/chess-academy` `web/src/lib/csp.test.ts`.

### PAS-UI-014 — No HTML sinks: user content is rendered as text, never as markup {#pas-ui-014}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Security

**Rule.** The app MUST NOT use `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or `javascript:` URLs. Rich text MUST be rendered through a component that produces DOM from a safe model (a markdown renderer with HTML disabled, or a sanitiser such as DOMPurify with a strict allow-list) and that path MUST be covered by a test.

**Applicability.** All apps with a user interface; MUST for any app displaying data another user wrote.

**Rationale.** React escapes text by default; every sink above opts out of that. With the platform header still allowing inline scripts ([PAS-UI-012](#pas-ui-012)), one `dangerouslySetInnerHTML` of a user's bio is a stored XSS that runs with the victim's platform session — which in cookie mode can drive every mediated call.

**Recommended implementation.** Render strings as children; for markdown use a renderer with `html: false`; if sanitising, allow-list tags and attributes and strip `style`, `on*`, `href` schemes other than http(s)/mailto; add a sink-ban test like Chess Academy's.

**Conforming example.**

```tsx
<p>{task.description}</p>
<Markdown options={{ disableParsingRawHTML: true }}>{note.body}</Markdown>
```

**Non-conforming example.**

```tsx
<div dangerouslySetInnerHTML={{ __html: note.body }} />
el.innerHTML = template(user.name)
```

**Evidence.** Source — **direct audit rule:** `grep -rn "dangerouslySetInnerHTML\|innerHTML\|insertAdjacentHTML\|document.write\|eval(\|new Function\|javascript:" web/src` — every hit is a `fail` unless it is inside a tested sanitiser wrapper.

**Remediation.** Replace the sink with text rendering or a sanitised renderer; add the sink-ban test.

**Tests.** The grep returns only the sanitiser wrapper; a fixture note containing `<img src=x onerror=alert(1)>` renders inert on the live app.

**Supporting links.** [PAS-UI-013](#pas-ui-013), [PAS-AUTH-001](./auth.md#pas-auth-001).

### PAS-UI-015 — URLs from data are validated before navigation, embedding or linking {#pas-ui-015}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — platform validates OAuth `return_to` (same-origin path; platform or active custom-domain origins) · **Since:** 1.4 · **Kind:** Security

**Rule.** Any URL that comes from data, params or another user MUST be validated before use: in-app navigation MUST accept only same-origin relative paths; `href`/`src`/`iframe` targets MUST be `https:` (or `mailto:`) — never `javascript:`, `data:` for navigation, or protocol-relative; external links MUST carry `rel="noopener noreferrer"` and be visibly external. Sign-in return targets follow [PAS-AUTH-010](./auth.md#pas-auth-010).

**Applicability.** Apps that render links, redirects or embeds from data.

**Rationale.** An unvalidated `href` is a phishing hop or a `javascript:` XSS; an unvalidated in-app redirect (`?next=`) sends users off-origin with the app's trust; an unvalidated embed frames an attacker's page inside the app's chrome.

**Recommended implementation.** One `safeHref(value)` helper: parse with `new URL(value, location.origin)`, allow `http:`/`https:`/`mailto:`, treat same-origin as internal; one `safeNext(value)` for redirects returning `/` on anything but a same-origin path.

**Conforming example.**

```tsx
function safeHref(v: string) { try { const u = new URL(v, location.origin); return ['https:','http:','mailto:'].includes(u.protocol) ? u.toString() : '#' } catch { return '#' } }
<a href={safeHref(link)} rel="noopener noreferrer" target="_blank">{label} ↗</a>
```

**Non-conforming example.**

```tsx
<a href={link}>{label}</a>                       // javascript: passes through
navigate(new URLSearchParams(location.search).get('next') ?? '/')   // off-origin redirect
```

**Evidence.** Source: `href={`/`src={`/`navigate(` with data-derived values; `?next=`/`?redirect=` handling; `target="_blank"` without `rel`.

**Remediation.** Route every data URL through the helpers; add `rel`.

**Tests.** Fixtures with `javascript:alert(1)`, `//evil.example`, and `https://evil.example/?next=` render as `#` or `/`; external links open with `noopener`.

**Supporting links.** [PAS-AUTH-010](./auth.md#pas-auth-010), [PAS-UI-014](#pas-ui-014).

### PAS-UI-016 — Uploads go through `app.storage`, with declared types and sizes, and are never rendered as active content {#pas-ui-016}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — the platform storage route caps uploads at 50 MB, rejects `text/html`, `application/xhtml+xml`, JavaScript types and `image/svg+xml`, and serves objects with `X-Content-Type-Options: nosniff` · **Since:** 1.4 · **Kind:** Security

**Rule.** File inputs MUST declare an `accept` list and the app MUST check type and size before calling `app.storage.upload`, sending the real `Content-Type`. Uploaded files MUST be displayed only through `<img>`, `<video>`, `<audio>` or download links — never inlined as HTML/SVG, `iframe`d, or rendered via `object`/`embed`. Filenames shown to users MUST be treated as text ([PAS-UI-014](#pas-ui-014)).

**Applicability.** Apps that accept uploads.

**Rationale.** The platform blocks the obvious executable types, but a PDF or an image can still carry misleading names and a `nosniff`ed file can still be embedded unsafely. Client-side checks are UX; the platform's are the boundary.

**Recommended implementation.** `<input type="file" accept="image/png,image/jpeg,application/pdf">`; check `file.size` and `file.type`; upload with `file.type`; render with the media element for the type.

**Conforming example.**

```tsx
if (!['image/png','image/jpeg'].includes(file.type) || file.size > 5_000_000) return setError('PNG/JPEG up to 5 MB')
const { url } = await app.storage.uploadUserPublic(`avatars/${crypto.randomUUID()}.png`, file, file.type)
<img src={url} alt="" />
```

**Non-conforming example.**

```tsx
<iframe src={app.storage.publicUrl(doc.key)} />          // embedding a user file
await app.storage.upload(key, file, 'application/octet-stream')   // hides the real type
```

**Evidence.** Source: file inputs (`accept`), pre-upload checks, the `contentType` argument, and how uploaded keys are rendered.

**Remediation.** Add the checks; fix the content type; render through media elements.

**Tests.** Uploading an `.html` renamed `.png` is refused client-side; on the live app the object is served with `nosniff` and does not execute when opened.

**Supporting links.** [PAS-STACK-012](./stack.md#pas-stack-012), [PAS-DATA-013](./data.md#pas-data-013).

### PAS-UI-017 — Framing is controlled by the platform; the app neither busts frames nor embeds untrusted origins {#pas-ui-017}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — host `frame-ancestors 'self' https://proappstore.online https://console… https://dashboard… https://admin… https://agents…` and `X-Frame-Options: SAMEORIGIN` · **Since:** 1.4 · **Kind:** Security

**Rule.** The app MUST rely on the platform's `frame-ancestors` for clickjacking protection and MUST NOT add JavaScript frame-busting. It MUST NOT `iframe` origins it does not control without `sandbox` and a fixed `src`. Apps MUST NOT assume they are never framed: the first-party consoles (store, console, dashboard, admin, agents) may embed an app preview and **an app cannot opt out of that**; state-changing UI MUST therefore be safe when framed by those surfaces (which it is by construction, since the session is same-origin only).

**Applicability.** All hosted apps.

**Rationale.** The header set is the correct, non-bypassable control; frame-busting scripts are bypassable and break the legitimate first-party previews. Embedding an arbitrary origin hands it a full-window UI inside the app's chrome.

**Recommended implementation.** Nothing to add for protection. For embeds, `<iframe sandbox="allow-scripts" src={fixedUrl} />` and only for known providers (maps via `app.maps.embedUrl`).

**Conforming example.**

```tsx
<iframe src={app.maps.embedUrl(lat, lng)} sandbox="allow-scripts" title="Map" />
```

**Non-conforming example.**

```tsx
if (top !== self) top.location = self.location      // frame-busting
<iframe src={userProvidedUrl} />                     // untrusted embed, no sandbox
```

**Evidence.** Source: `top`/`parent` checks; `iframe` elements and their `src`/`sandbox`; Runtime: response headers.

**Remediation.** Remove frame-busting; sandbox or remove embeds.

**Tests.** `curl -sI` shows `frame-ancestors` and `X-Frame-Options`; an embed test page on a third-party origin fails to frame the app.

**Supporting links.** [PAS-UI-012](#pas-ui-012), [PAS-UI-015](#pas-ui-015).

### PAS-UI-018 — The service worker caches only the app shell and static assets — never `/.pas/*`, never scoped data {#pas-ui-018}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — compliance check *PWA offline correctness* (service worker registered; workbox config sane); host `Clear-Site-Data: "cache"` on logout and `/.pas/auth/recover` · **Since:** 1.4 · **Kind:** Security

**Rule.** The service worker MUST keep the template's `navigateFallbackDenylist: [/^\/\.pas\//]`, MUST NOT add runtime caching for `/.pas/*`, `api.proappstore.online`, `data-*` or any authenticated response, MUST precache only build output and fonts, and MUST use `registerType: 'autoUpdate'` so a deploy replaces the shell. Cached data that belongs to a user MUST NOT be served to another account ([PAS-DATA-020](./data.md#pas-data-020)).

**Applicability.** All apps (every app is a PWA).

**Rationale.** A cached `/.pas/auth/me` answers "signed in" after sign-out; a cached action response shows one user's rows to the next; a stale shell that predates the cookie migration keeps trying the legacy flow — the Chess Academy recovery-route case. The platform clears Cache Storage on logout, but only what the SW put there can be cleared, and a SW that intercepts `/.pas/*` navigations breaks sign-in.

**Recommended implementation.** Leave the template `VitePWA` block as generated; add runtime caching only for immutable third-party assets with `CacheFirst` and an expiration.

**Conforming example.**

```text
workbox: { globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,wasm,json}'], navigateFallbackDenylist: [/^\/\.pas\//],
  runtimeCaching: [ { urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i, handler: 'CacheFirst', options: { cacheName: 'google-fonts-webfonts', expiration: { maxEntries: 30, maxAgeSeconds: 31536000 } } } ] }
```

**Non-conforming example.**

```text
runtimeCaching: [ { urlPattern: /\/\.pas\/api\//, handler: 'StaleWhileRevalidate' } ]   // caches authenticated responses
registerType: 'prompt'  // + no prompt UI: old shell forever
```

**Evidence.** Configuration: `web/vite.config.ts` `VitePWA` block (`navigateFallbackDenylist`, `runtimeCaching`, `registerType`); any hand-written `sw.js`; Runtime: Cache Storage contents after use.

**Remediation.** Restore the denylist; delete the offending runtime rules; switch to `autoUpdate`.

**Tests.** Browser: after sign-in, Cache Storage holds no `/.pas/` or API entries; after sign-out `/.pas/auth/me` is 401 with the SW active; a new deploy is picked up on the next load.

**Supporting links.** [PAS-AUTH-007](./auth.md#pas-auth-007), [PAS-DATA-020](./data.md#pas-data-020), [Browser auth session model](../auth-session-model.md).

### PAS-UI-019 — Offline, the shell loads and data screens say so — no stale scoped data, no silent lost writes {#pas-ui-019}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance check *PWA offline correctness* (precache covers `web/public` assets and the workbox size limit fits the bundle) · **Since:** 1.4 · **Kind:** Quality

**Rule.** Installed, the app MUST open offline to its shell (precached), MUST render an explicit offline/error state on data screens ([PAS-UI-011](#pas-ui-011)) rather than stale rows, and MUST NOT queue writes for later replay unless the action is idempotent ([PAS-DATA-018](./data.md#pas-data-018)) and the user is told the write is pending.

**Applicability.** All apps (every app is a PWA).

**Rationale.** The platform mandates installable PWAs; an installed app that white-screens offline fails the promise, and one that replays a non-idempotent write on reconnect duplicates it.

**Recommended implementation.** Keep the template precache; detect `navigator.onLine`/fetch failure and render the offline state; for drafts, save to `app.kv` when back online rather than replaying writes.

**Conforming example.**

```tsx
if (!navigator.onLine) return <EmptyState title="You're offline" description="Tasks will load when you're back online." />
```

**Non-conforming example.**

```tsx
// service worker StaleWhileRevalidate on action responses → yesterday's rows shown as current, silently
```

**Evidence.** Configuration: precache globs and `maximumFileSizeToCacheInBytes`; Source: offline handling in data screens; any replay queue.

**Remediation.** Add the offline state; remove non-idempotent replay.

**Tests.** Browser: with the network offline the installed app opens and each data screen shows the offline state; `pas check` passes *PWA offline correctness*.

**Supporting links.** [PAS-UI-018](#pas-ui-018), [PAS-DATA-018](./data.md#pas-data-018).

### PAS-UI-020 — The app is installable: manifest, icons, install metas and preview images {#pas-ui-020}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance checks *PWA manifest* (`name`, `short_name`, `start_url`, `display`), *PWA maskable icon*, *PWA meta tags* (iOS capable metas), *HTML meta tags* (preview images) · **Since:** 1.4 · **Kind:** Quality

**Rule.** The manifest MUST declare `name`, `short_name`, `start_url: '/'`, `scope: '/'`, `display: 'standalone'`, `theme_color`, `background_color`, `orientation`, `min_viewport_width`, and icons at 192 and 512 px including one with `purpose: 'maskable'`. `index.html` MUST carry `theme-color`, `apple-mobile-web-app-capable` / `mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, an `apple-touch-icon`, and Open Graph / Twitter preview images. Placeholder `APPNAME` strings MUST be gone.

**Applicability.** All apps (every app is a PWA).

**Rationale.** Without the maskable icon Android installs a shortcut, not an app; without the Apple metas iOS opens a Safari tab; without preview images the app's link shares as a blank card.

**Recommended implementation.** Keep the template's manifest and head; replace `APPNAME`, the icons and `og-image.png`; keep `theme-color` in sync with the light `--paper`.

**Conforming example.**

```text
icons: [ { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
         { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
         { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' } ]
```

**Non-conforming example.**

```text
icons: [ { src: '/favicon.ico', sizes: '64x64' } ]     // no 512, no maskable
<title>APPNAME — ProAppStore</title>                     // placeholder shipped
```

**Evidence.** Configuration: `vite.config.ts` manifest; `web/index.html` head; `web/public` icons and `og-image.png`; `pas check` output.

**Remediation.** Fill in the fields and assets; replace placeholders.

**Tests.** `pas check` passes the four checks; Chrome's install prompt appears; iOS "Add to Home Screen" launches standalone.

**Supporting links.** [PAS-UI-008](#pas-ui-008), [PAS-UI-018](#pas-ui-018).

### PAS-UI-021 — The bundle stays within budget and ships no source maps {#pas-ui-021}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance check *Bundle size* (largest JS asset ≤ 300 KB gzip; `warn` when `web/dist` is unbuilt); host refuses `*.map`; VCQA code-health report on every deploy · **Since:** 1.4 · **Kind:** Quality

**Rule.** The largest JavaScript chunk MUST be at most 300 KB gzipped; heavy features SHOULD be code-split with `React.lazy`/dynamic `import()`; `build.sourcemap` MUST stay off for production. The VCQA quality score SHOULD stay above the platform gate (40) and its findings SHOULD be triaged.

**Applicability.** All apps.

**Rationale.** The budget is what keeps first load acceptable on mobile networks; the map/host cap on `.map` files exists because a published source map would expose an app's proprietary source.

**Recommended implementation.** Lazy-load routes and heavy libraries; check `pnpm build` output sizes; keep Vite's default `sourcemap: false`.

**Conforming example.**

```tsx
const Editor = lazy(() => import('./Editor'))
```

**Non-conforming example.**

```tsx
import * as pdfjs from 'pdfjs-dist'          // 1.2 MB in the main chunk
build: { sourcemap: true }
```

**Evidence.** Configuration: `vite.config.ts` `build.sourcemap`; Process: `pas check` after `pnpm build`; the deploy's VCQA report at `/.vcqa/report.json`.

**Remediation.** Split the chunk; disable source maps.

**Tests.** `pas check` passes *Bundle size* on a built tree; `https://<app>.proappstore.online/assets/*.map` returns 404.

**Supporting links.** [PAS-STACK-024](./stack.md#pas-stack-024), [Build and deploy](../build-and-deploy.md).

### PAS-UI-022 — Dependencies are pinned, reviewed, tracker-free and secret-free {#pas-ui-022}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — compliance checks *No tracking SDKs*, *No .env.production*, *No template placeholders*, *MIT License* · **Since:** 1.4 · **Kind:** Security

**Rule.** `pnpm-lock.yaml` MUST be committed and installs MUST use `--frozen-lockfile` in CI. The app MUST NOT include analytics or tracking SDKs, MUST NOT commit `.env.production` or any credential, and MUST NOT add a dependency that substitutes for a platform primitive ([PAS-STACK-024](./stack.md#pas-stack-024)). New dependencies SHOULD be reviewed for `eval`/`new Function` use, install scripts and network calls. A `LICENSE` file MUST be present; note that the *MIT License* compliance check still assumes MIT while the Pro tier permits proprietary source — an app with a proprietary licence records the check's failure as a known platform inconsistency, not an app defect.

**Applicability.** All apps.

**Rationale.** The dependency list is the fastest audit of everything else in this chapter: a tracker, a bundled key, a DOM-string templating library, or a second auth SDK all arrive as a `package.json` line.

**Recommended implementation.** Add dependencies deliberately; prefer pure client-side libraries; run `pas check`; keep `.env*` in `.gitignore`.

**Conforming example.**

```text
"dependencies": { "@proappstore/sdk": "^1.16.0", "react": "^19.2.5", "react-dom": "^19.2.5", "lucide-react": "^0.5.0", "date-fns": "^4.1.0" }
```

**Non-conforming example.**

```text
"dependencies": { "react-ga4": "^2", "firebase": "^11", "lodash.template": "^4" }   + .env.production committed
```

**Evidence.** Configuration: `web/package.json`, `pnpm-lock.yaml`, `.gitignore`, `LICENSE`; `pas check` output; Process: `--frozen-lockfile` in `ci.yml`.

**Remediation.** Remove the offending packages and files; rotate any committed secret; commit the lockfile.

**Tests.** `pas check` passes the listed checks (with the MIT caveat recorded if applicable); `git ls-files .env.production` is empty.

**Supporting links.** [PAS-STACK-021](./stack.md#pas-stack-021), [PAS-STACK-024](./stack.md#pas-stack-024), [PAS-STACK-015](./stack.md#pas-stack-015).

### PAS-UI-023 — Rendered accessibility, responsiveness and installability are verified in a browser by a person {#pas-ui-023}

**Severity:** Medium · **Verification:** Human · **Enforcement:** none (recommended) · **Since:** 1.4 · **Kind:** Accessibility (quality)

**Rule.** Before an audit closes, a person MUST run the checklist below on the deployed app in a real browser (desktop and a phone or emulator), in both colour schemes, and record the outcome. An AI auditor records this clause as `manual-review` with the checklist; it MUST NOT mark it `pass`. Automated steps (qa-spec/Playwright) MAY cover the keyboard and viewport items and MUST be cited where they do.

**Applicability.** All apps with a user interface.

**Rationale.** The static scanner proves the presence of metas, tokens, a service worker and labelled buttons. It cannot prove contrast, focus order, rendered ARIA, zoom, horizontal scroll, safe areas, install behaviour or offline behaviour — the items that decide whether the app is usable.

**Recommended implementation.** Run the list; attach screenshots at 360 px and 200 % zoom; note axe DevTools results.

**Conforming example.**

```text
[ ] axe DevTools: no critical/serious issues on the main routes, light and dark
[ ] Keyboard walk: every control reachable; focus visible; dialog opens/Escape closes/focus returns
[ ] Landmarks + one h1 per route in the accessibility tree; title changes per route
[ ] 360 px: no horizontal scroll; long URL wraps; targets ≥ 44 px
[ ] 200 % zoom and text size lg: nothing clipped; pinch-zoom works on a phone
[ ] Contrast of custom colour pairs measured, both schemes
[ ] Install (Android + iOS): standalone launch, correct icon; opens offline to the shell
[ ] Sign-out then Cache Storage: no /.pas/ or API entries
[ ] No CSP violations in the console
```

**Non-conforming example.**

```text
AI report: PAS-UI-023 pass (inferred from source)      ← not allowed: Human verification
```

**Evidence.** Runtime: the completed checklist with browser/device, date, and screenshots; Documentation: the audit report.

**Remediation.** Run the checklist; file findings under the clause each failure breaches.

**Tests.** Every line passed or has a linked finding.

**Supporting links.** [Audit model — verification classes](./audit-model.md#verification-classes), [PAS-AUTH-020](./auth.md#pas-auth-020).
