# Output template — the auth and permissions plan

```markdown
## Auth & permissions plan: <app name>

**Hosting:** <subdomain | custom domain(s)> · **Category:** <Tailored | Ready> · **Standard:** 1.5

### Decisions
| Need | Decision | Clause |
|---|---|---|
| session mode | `initPro({ appId, authMode: 'platform-cookie' })` | PAS-AUTH-001 |
| sign-in paths | <github / google / email / provisioned> | PAS-AUTH-004 |
| hydration | `app.auth.init()` via `useProAuth` / `ProShell` | PAS-AUTH-005 |
| sign-out & recovery | `app.auth.signOut()` + cache clear + `/.pas/auth/recover` | PAS-AUTH-007 |

### Findings (existing app only)
| # | Finding | File:line | Clause | Remediation |
|---|---|---|---|---|

### Role vocabulary
| Role | May | Actions (`app_roles`) | Granted by |
|---|---|---|---|
| member | signed in; own rows only | — | automatic |
| <editor> | <…> | <action names> | admin / invite |
| <admin> | administer roles | <role actions> | creator |

### Permissions UI
- Screen: <route>, rendered only when `app.roles.check('<admin>')` resolves true; error state on failure
- Lists `app.roles.listAll()`, grants/revokes with confirmation, shows who/when; invites via `app.invites`
- The screen is UX; every action it calls is gated by `app_roles` and scoped in SQL

### Negative tests to add
- <action> as user B against A's ids → no rows / no change
- <action> as `member` → 403

### Human verification (PAS-AUTH-020)
- [ ] each sign-in path on <hostname(s)>
- [ ] sign-out, then `/.pas/auth/me` is 401
- [ ] `/.pas/auth/recover` on an installed PWA
- [ ] grant a role → second account gains the feature; revoke → loses it

### Blockers
- <class>: <what is missing and who decides>
```
