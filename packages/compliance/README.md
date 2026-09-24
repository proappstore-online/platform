# @proappstore/compliance

Compliance checks for apps published on **proappstore.online**. Same checks the CLI runs locally and the template's CI runs on every push.

```ts
import { runChecks } from '@proappstore/compliance';

const results = await runChecks(process.cwd());
for (const r of results) {
  console.log(`${r.status}  ${r.name}  ${r.detail}`);
  for (const s of r.suggestions ?? []) console.log(`   → ${s}`);
}
```

## Check ids and standard citations

Every result is decorated with a stable `checkId`, `citations[]` into the
public [Application Standard](https://docs.proappstore.online/standard/)
(`{ clauseId, url }`), an `automation` level (`full` | `partial`) and
`evidence` (`{ class, detail }`). The mapping lives in `src/clause-map.ts` and
is published at
<https://docs.proappstore.online/standard/compliance-checks.json>; `CHECKS`,
`clauseUrl()`, `annotateByName()` and `complianceMap()` are exported. Ids are
never renamed. These checks are hygiene scans, not a security audit — see
[automation levels](https://docs.proappstore.online/standard/audit-model/#automation-levels).

## What is scanned

`fsFileSource(dir)` walks the working directory honouring every `.gitignore` it
meets (nested files, `!` re-includes, last match wins) and, regardless of
`.gitignore`, skips `.git`, `node_modules`, `dist`, `.next`, `.cache`,
`.wrangler`, `.turbo` and the generated-report directories `.vibe-check`,
`playwright-report`, `test-results`, `coverage`, `.vite`, `graphify-out`.
`mapFileSource(map)` — the publish gate, fed with the files that are actually in
the repository — applies only the directory skip list: ignore rules never
governed tracked files, so honouring them there could only hide real source.
There is no separate ignore configuration; `.gitignore` is it.

## Checks

`runChecks(dir)` (and `runChecksFromFiles(map)`) runs the full suite below.
There is also a separate live-URL audit (`auditLive`, exported from
`@proappstore/compliance` — a subset re-run against the deployed app).

| Name | What it checks | Status on fail |
|---|---|---|
| `MIT License` | A `LICENSE` file exists and is the MIT license | **fail** |
| `No .env.production` | No committed `.env.production` | **fail** |
| `No template placeholders` | No file still contains `APPNAME` | **fail** |
| `No tracking SDKs` | No reference to any of the known trackers (google-analytics, gtag, amplitude, mixpanel, segment, hotjar, plausible, posthog) — hardened word-boundary matching via the shared `TRACKERS` / `matchedTrackers` | **fail** |
| `Brand fonts present` | Manrope + Fraunces referenced in CSS or HTML | **fail** |
| `Brand tokens defined` | Canonical brand CSS custom properties (`--paper`, `--ink`, `--accent`, …) are defined in theme CSS | **fail** |
| `No brand overrides` | App does not redefine the platform-defined brand tokens/fonts | **fail** |
| `No scroll (games only)` | Games fit the viewport — no document-level scroll (games only; skipped for non-games) | **fail** / warn |
| `Viewport support` | Declares supported screens + orientations for the storefront coverage badge | **fail** / warn |
| `No unsafe 100vh` | No bare `100vh` (breaks on iOS Safari with the URL bar visible) | warn |
| `Accessibility static` | Source-level baseline: image alt text, accessible button names, form control labels | **fail** |
| `HTML meta tags` | `web/index.html` declares lang + viewport + non-empty title + share-preview images | **fail** |
| `PWA meta tags` | `web/index.html` has an iOS/Android standalone install hint | **fail** / warn |
| `PWA offline correctness` | Service worker / offline behaviour is correct | **fail** / warn |
| `PWA manifest` | Static `web/public/manifest.json` (or inline VitePWA manifest) declares name / short_name / start_url / display | **fail** |
| `PWA maskable icon` | Manifest declares at least one `purpose: "maskable"` icon | **fail** |
| `Store link` | Some source file links back to `proappstore.online` | warn |
| `Dark mode support` | Respects the system colour-scheme preference | warn |
| `Bundle size` | Largest JS in `web/dist/assets/` is ≤ 300 KB gzipped | **fail** if too big; warn if not built yet |
| `CLAUDE.md slim` | Per-repo `CLAUDE.md` stays slim (no drift-prone platform-wide content) | warn |

## License

MIT.
