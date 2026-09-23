# Direct audit rules — fast, high-confidence checks

The greps the chapters mark as direct rules, as published in the
[audit instructions](https://docs.proappstore.online/standard/audit-instructions/). A hit is a `fail` for
the named clause unless the clause states an exception. The regex column is
what the evaluation fixtures apply; the grep column is what a person runs.

| # | Regex (over the named files) | Grep | Clause |
|---|---|---|---|
| 1 | `initPro\(` without `authMode: 'platform-cookie'` in the same call, on a hosted app | `grep -rn "initPro(" web/src` | [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001) |
| 2 | `pas:session\|pas_session\|\?session=\|\.auth\.token` in `web/src` | `grep -rn "pas:session\|pas_session\|?session=\|\.auth\.token" web/src` | [PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002), [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003) |
| 3 | `/v1/auth\|/\.pas/auth` in `web/src` | `grep -rn "/v1/auth\|/.pas/auth" web/src` | [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003) |
| 4 | `app\.db\.(query\|execute\|batch)` in a user path | `grep -rn "app\.db\.\(query\|execute\|batch\)" web/src` | [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003) |
| 5 | `dangerouslySetInnerHTML\|innerHTML\|document\.write\|eval\(\|new Function\|javascript:` in `web/src` | `grep -rn "dangerouslySetInnerHTML\|innerHTML\|document.write\|eval(\|new Function\|javascript:" web/src` | [PAS-UI-014](https://docs.proappstore.online/standard/ui/#pas-ui-014) |
| 6 | `user-scalable=no\|maximum-scale` in `web/index.html` | `grep -n "user-scalable=no\|maximum-scale" web/index.html` | [PAS-UI-007](https://docs.proappstore.online/standard/ui/#pas-ui-007) |
| 7 | `data-[a-z0-9-]+\.proappstore\.online\|/\.pas/data\|workers\.dev\|X-Internal-Token` in `web/src` | `grep -rn "data-.*proappstore.online\|/.pas/data\|workers.dev\|X-Internal-Token" web/src` | [PAS-DATA-016](https://docs.proappstore.online/standard/data/#pas-data-016) |
| 8 | an `mcp.json` statement with `requires_auth: true` whose SQL has no `:__user_id` (or uses it only tautologically) | read every `sql` / `statements` entry | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) |

Rules 1 and 8 need context (hosted or not; the statement's predicate), so a
person or the auditor reads the match before recording the result. Rules 2
to 7 are recorded as `fail` on a hit with `confidence: high`.
