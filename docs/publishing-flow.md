# Publishing flow

`pas publish` calls `POST /v1/provision` on the PAS backend
(`api.proappstore.online`). The PAS platform owns the full publish flow —
no delegation to FAS or any other store's admin.

## End-to-end sequence

```text
publisher                  PAS backend (api.proappstore.online)
  |                                       |
  |-- pas publish (/v1/provision) ------> |
  |   (metadata)                          |
  |                                       |-- 1. Validate input
  |                                       |-- 2. Create GitHub repo in proappstore-online org
  |                                       |-- 3. Create CF Pages project `proappstore-{id}`
  |                                       |-- 4. Add custom domain `{id}.proappstore.online`
  |                                       |-- 5. Create DNS CNAME -> `proappstore-{id}.pages.dev`
  |                                       |-- 6. Create per-app D1 database
  |                                       |-- 7. Deploy `data-{id}.proappstore.online`
  |                                       |-- 8. Set CLOUDFLARE_API_TOKEN as repo secret (CI deploy)
  |                                       |-- 9. Add entry to platform/storefront metadata
  |                                       |--10. Provision CF Web Analytics RUM site
  |                                       |
  | <---- result + URL ---------------    |
  |
  +-- git push origin main
     auto-deploys via CF Pages in ~30s
```

## Key properties

- **Standalone.** The PAS backend has its own Cloudflare/GitHub credentials for
  Pages, DNS, D1, data-worker deploys, and repo setup. No cross-store service
  bindings.
- **Idempotent.** Re-running on a partially-provisioned app fills in only missing pieces.
- **CLI-driven.** `pas publish` is the intended entrypoint; it calls
  `POST /v1/provision` and then registers `mcp.json` app tools when present.

## Failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| `Pages GitHub app not installed` | CF Pages app not added to `proappstore-online` | Surface error to publisher |
| `repo already exists` | Retry after partial failure | Safe if state matches; otherwise abort |
| DNS race | CNAME created before custom domain registration completed | Retry once; the Pages API is idempotent here |
| `D1 quota exceeded` | Account-level D1 limit reached | Block provisioning, alert |

## Testing

PAS admin will have a vitest suite mocking GitHub + CF Pages + DNS APIs. Run `pnpm test` in `~/dev/stores/pas/admin/`.
