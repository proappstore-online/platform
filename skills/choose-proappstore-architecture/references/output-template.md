# Output template — the bounded architecture decision

```markdown
## Architecture decision: <app name>

**Category:** <Tailored | Ready> · **Standard:** 1.5 · **Decided:** <date>

### Requirements → platform services
| Need | Service | Why (one line) | Clause |
|---|---|---|---|
| <need> | `app.<module>` / registered actions / … | <trade-off in one line> | [PAS-…](https://docs.proappstore.online/standard/<chapter>/#pas-…) |

### Data scoping sketch
- <table>: tied to the caller by `<column> = :__user_id` / membership on `<members table>`
- Batch actions: <flows that must not half-apply>

### Unsupported requirements
| Requirement | Interim pattern | Issue |
|---|---|---|
| <need> | <pattern from unsupported-requirements.md> | #123 / #148 / … |

### Verified surfaces
- `sdk_reference(<feature>)`: <methods confirmed>
- `recipe(<name>)`: <starting pattern>

### Follow-ups
1. <e.g. set authMode: 'platform-cookie' on day one — PAS-AUTH-001>
2. <e.g. write the cross-tenant negative tests — PAS-DATA-022>

### Blockers
- <class>: <what is missing and who decides>

Next: create the app with `create-proappstore-app` (category: <…>, visibility: <…>).
```
