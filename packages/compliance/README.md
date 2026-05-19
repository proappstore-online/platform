# @freeappstore/compliance

Compliance checks for apps published on **freeappstore.online**. Same checks the CLI runs locally and the template's CI runs on every push.

```ts
import { runChecks } from '@freeappstore/compliance';

const results = await runChecks(process.cwd());
for (const r of results) {
  console.log(`${r.status}  ${r.name}  ${r.detail}`);
  for (const s of r.suggestions ?? []) console.log(`   → ${s}`);
}
```

## Checks (v0.1.0)

| Name | What it checks | Status on fail |
|---|---|---|
| `No template placeholders` | No file still contains `APPNAME` | **fail** |
| `No tracking SDKs` | No reference to google-analytics / gtag / amplitude / mixpanel / segment / hotjar / plausible / posthog | **fail** |
| `Brand fonts present` | Manrope + Fraunces referenced in CSS or HTML | **fail** |
| `PWA manifest` | `web/public/manifest.json` exists and has name / short_name / start_url / display | warn |
| `Bundle size` | Largest JS in `web/dist/assets/` is ≤ 300 KB gzipped | **fail** if too big; warn if not built yet |

## License

MIT.
