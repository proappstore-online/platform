# Output template

Use this shape for the final report. Replace angle-bracket fields; drop a
section only if it is genuinely empty.

```markdown
## <App name> (`<app_id>`) — provisioned on ProAppStore

**Session:** <login> (<roles>) · **Standard:** 1.5 · **Report time:** <date>

### Created
- Repository: https://github.com/<org>/<app_id> (<private|public>)
- Live URL: https://<app_id>.proappstore.online
- Data worker: https://data-<app_id>.proappstore.online
- Template: `<template_id>` — <status>, reviewed commit `<reviewed 7-hex>`; **copied revision** `<template_rev 12-hex | unknown>`

### Why this template
<one paragraph: fit to category + data needs; alternatives considered (none today)>

### Verification
| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | GitHub repository | passed | `+ GitHub repo: created …` |
| … | … | passed / pending / failed | <tool + line> |

### Day-one follow-ups (template known deviations)
1. Set `authMode: 'platform-cookie'` in `initPro` — https://docs.proappstore.online/standard/auth/#pas-auth-001
2. Theme boot key → `stores-theme` — https://docs.proappstore.online/standard/ui/#pas-ui-002
3. Remove `user-scalable=no` — https://docs.proappstore.online/standard/ui/#pas-ui-007

### Next steps
- `git clone` the repo, `pnpm install`, build the first feature; every push to `main` deploys.
- When ready for the storefront: ask for `publish_app` (name, category, description) — not run by this skill.

### Blockers
- <class>: <what the tool said> → <who must act>
```
