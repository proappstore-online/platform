---
description: "Architecture decision making Tailwind 4 utilities on the PAS design tokens the one styling model for React apps."
---

# ADR-011: Tailwind on PAS tokens

## Status

Accepted

## Date

2026-10-28

## Context

The platform gave agents three contradictory styling instructions, and an agent
follows whichever one it reads:

- `docs/ui.md` told agents the scaffold's `src/index.css` holds utility classes
  and to "use these instead of inline Tailwind". That is an instruction to write
  bespoke global classes. It is how `bookkeeper` went from 1 class at scaffold
  to 133, and how `austax` reached 111 classes, 230 unlayered class rules and 145
  hard-coded hex values.
- The Application Standard called Tailwind 4 "optional (template choice)"
  (PAS-STACK-001).
- `skills.md` listed `--border`, `--surface` and `--bg` as the CSS tokens to use.
  `scripts/check-design-system.sh` bans exactly those three aliases. It also said
  the SDK components need "no Tailwind", which reads as "Tailwind is not
  required".

An audit of all 28 app repos on 2026-10-27 (epic #496) found two apps with
sprawling bespoke CSS, 17 apps still carrying banned aliases, and thousands of
long-hand `text-[var(--muted)]` classes because no `@theme` mapping existed.
23 of 25 web apps already use Tailwind 4. The apps that were clean were clean
because of which runs happened to touch them, not because a rule protected them.

## Decision

React apps on PAS style with **Tailwind 4 utilities on PAS design tokens**, in
three layers, in this order of preference:

1. **Components** for anything that repeats (buttons, cards, inputs, dialogs,
   empty states): `@proappstore/sdk/ui`, or app-local components (the `hiring`
   model: `web/src/design-system.tsx`).
2. **Tailwind utilities on token colours** (`text-ink bg-panel border-line`, via
   an `@theme` mapping of the tokens) for layout and one-off styling, written in
   the component's `className`.
3. **`web/src/index.css`** holds only `@import "tailwindcss"`, `@source`, the
   token blocks (`:root` and `:root[data-theme='dark']`), `@theme`, and
   `@layer base` / `@layer components`. No unlayered rules, no feature classes,
   no hex outside the token blocks. `@media print` is allowed for print sheets.

Tailwind is **required** for React apps. Apps that do not depend on `tailwindcss`
are outside the rule's checks; today that is only `bandmates` (MUI), which is
inactive. `austax` is inactive too and out of scope.

**Branding stays with the app.** An app's palette lives in the *values* of the
PAS tokens (for example `--accent: #d86f4d` in `:root` and in the dark block).
Migrating to this model changes how the tokens are *used*, never what they are
*set to*. PAS-STACK-022 already lets app owners control their branding.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Keep Tailwind optional and enforce only tokens and layering | 23 of 25 web apps already use Tailwind 4, and leaving the framework open still lets an app grow another `index.css` like `austax`'s. |
| CSS modules | Local, but still a second file per component plus naming decisions; no cheaper for agents to read or write. |
| A component library (MUI etc.) | Brings its own theme system, which works against the PAS tokens and ProShell, and costs bundle size (`bundle-size` check). |

## Consequences

**Positive:**
- One instruction, everywhere: the standard, `docs/ui.md` and `skills.md` agree.
- Agents write utilities on tokens instead of growing global CSS, so dark mode
  and per-app branding keep working through the token values.
- A `css-discipline` compliance check can enforce the model mechanically.

**Negative:**
- The standard now publishes a rule the compliance check does not yet enforce.
  This is intended: the check ships as a warning first (epic #496, #493) and
  flips to `fail` after the fleet rollout (#495).
- Existing apps need a migration (the `pas migrate tailwind-tokens` codemod, #494).

**Neutral:**
- Follow-up work is tracked in epic #496: template `@theme` mapping (#492), the
  compliance check (#493), the codemod (#494) and the fleet rollout (#495).
- The old seed classes (`.card`, `.btn`, `.input`, `.badge`) come from the
  agent-teams seed and are retired by the templates work, not by this ADR.
