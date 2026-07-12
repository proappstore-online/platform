# @proappstore/qa-spec

The browser e2e **test-flow format** and its executor — one definition of step
semantics, shared by every runner so a flow can never pass in one place and fail
in another. Pure TypeScript, no runtime deps.

```ts
import { validateFlow, runFlow, toPlaywright, type TestFlow } from '@proappstore/qa-spec';

const flow: TestFlow = {
  id: 'student-sign-in',
  name: 'A student signs in with their login',
  startPath: '/',
  steps: [
    { op: 'click', target: { text: "Sign in with your teacher's login" } },
    { op: 'fill', target: { label: 'Login' }, value: 'qa-lynx-heron-mole' },
    { op: 'fill', target: { label: 'Password' }, value: '••••' },
    { op: 'click', target: { label: 'Sign in' } },
    { op: 'expectText', text: 'QA Lynx' },
    { op: 'screenshot', name: 'signed-in' },
  ],
};

const problem = validateFlow(flow);           // null, or a human-readable reason
const result = await runFlow(flow, host);      // executes against a Document
const spec = toPlaywright(flow);               // → a Playwright .spec.ts string
```

## Steps

| op | fields | notes |
|---|---|---|
| `goto` | `path` | same-app navigation |
| `click` | `target` | auto-waits for the target (up to the timeout) |
| `clickPoint` | `xPct`, `yPct` | viewport-relative — for coordinate UIs (a chess board) with no semantic target |
| `fill` | `target`, `value` | React-safe: native value setter + `input`/`change` |
| `press` | `key` | keydown/keyup on the active element |
| `expectVisible` | `target` | polls until present |
| `expectText` | `text` | polls the document text |
| `waitFor` | `ms?` / `target?` | wait a duration, or for a target |
| `screenshot` | `name?` | delegated to the host (runner page / worker) |

A **target** sets exactly one of `{ label }` (aria-label), `{ text }` (visible
text), or `{ selector }` (CSS). Resolution priority: selector › label › text;
exact text before containment, innermost match on ties.

Limits: ≤ `MAX_STEPS` (100) steps per flow, ≤ `MAX_FLOWS_PER_APP` (20) per app.

## Three executors, one runner

`runFlow(flow, host)` takes a `RunnerHost` (a `getDocument()`, a `navigate()`,
an optional `screenshot()` and `onStep()`). The **same** `dom-runner` code runs
in:

- the observable runner page (`packages/host` `/__qa/`) against the app iframe,
- the headless worker (`packages/qa-worker`), which injects the bundled runner
  via `page.evaluate`,

so step semantics are defined exactly once. `to-playwright.ts` is a separate
best-effort transpiler for CI parity (exact for selector/text/label/clickPoint).

Tests: `pnpm --filter @proappstore/qa-spec test` (Vitest + happy-dom).

## License

MIT.
