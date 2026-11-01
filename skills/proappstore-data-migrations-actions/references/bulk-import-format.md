# Owner bulk import (#515): loading data a port brings with it

A ported app (Firebase above all — see the `choose-proappstore-architecture`
skill's `references/port-from-firebase.md`) usually arrives with existing rows
and files. This is the one supported way to
load them: owner-only, idempotent, validated against the app's own live
schema before anything is written. It is not a registered-action surface —
`mcp.json` actions stay the app's only user-facing data path.

**Out of scope on purpose:** there is no Firestore-specific exporter. Each
port writes its own one-off export/transform script into the format below —
that script is where "Firestore timestamp → `INTEGER` ms" and "nested
document → flattened row" decisions belong (see the
[Schema](decision-tables.md#schema-migrationsjson) table for the shape a
target table should already have).

## Rows → D1: `pas data import <dir> [--dry-run]`

One file per table in `<dir>`:

- `<table>.json` — a JSON array of row objects.
- `<table>.jsonl` — one JSON object per line (blank lines skipped).

The table name is the file name without its extension. The CLI posts every
table's rows in one call to `POST /v1/apps/:appId/data/import`
(`routes/data-import.ts`), which, before writing anything:

1. Reads the table's LIVE schema (`PRAGMA table_info`, the same live-schema
   read the console's custom-endpoint builder uses) — never `migrations.json`,
   which is the intended shape, not necessarily what is actually live.
2. Refuses the whole call if any table does not exist, any row names a column
   the live table does not have, or the table has no primary key — an import
   target needs one so a re-run can tell "already imported" from "new". This
   refusal applies with or without `--dry-run`.
3. With no mismatches, `--dry-run` reports the row count per table and writes
   nothing; otherwise every row is written as
   `INSERT INTO "<table>" (...) VALUES (...) ON CONFLICT ("<pk>") DO NOTHING`
   over the data worker's `/batch` endpoint — the same trusted path registered
   batch actions and the entitlement mirror use, chunked to its batch-size
   cap. Running the same file twice changes nothing the second time.

Auth: the app owner's own CLI session, with a recent sign-in — the same gate
`pas worker` uses to deploy from a session ([PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016)) —
never a long-lived app token. One `app_logs` entry (`category: "import"`)
records each call: row counts per table, and whether it was a dry run.

## Files → storage: `pas storage import <dir> [--prefix <p>]`

Uploads every file under `<dir>`, recursively, through the existing storage
upload route (`PUT /v1/apps/:appId/storage/_public/<path>`) — no parallel
upload path. Prints (or `--json`-emits) a manifest: each file's path relative
to `<dir>` mapped to its new storage key. Name local files after whatever the
old dataset used to identify them (the old URL's path, or an id a D1 row
already carries) so the manifest is directly useful for rewriting stored image
URLs before the D1 import runs.

## Worked shape

```
export/
  malls.json           [{ "id": "m1", "name": "Example Mall", "created_at": 1730000000000 }]
  floors.jsonl          {"id":"f1","mall_id":"m1","level":1}
  images/
    m1/ground-floor.png
```

```
pas storage import export/images --prefix malls   # -> _public/malls/m1/ground-floor.png
pas data import export --dry-run                  # reports row counts, writes nothing
pas data import export                             # writes; re-running it is a no-op
```
