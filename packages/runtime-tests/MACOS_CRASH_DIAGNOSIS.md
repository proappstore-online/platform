# Native macOS workerd crashes in the backend runtime suite (#543)

**Status: unresolved.** No fix is claimed. This document records the evidence, what has been ruled in
or out, the mitigation that was added, and the steps that need a native macOS machine. It was written
on a Windows machine, which cannot run the `workerd-darwin-64` binary, so nothing here is a macOS
result. Not reproducing a crash on Windows or Linux proves nothing about macOS.

## 1. What was reported

During #540 verification, on macOS (Node 22.23.2, `@cloudflare/vitest-pool-workers` 0.8.71,
`workerd-darwin-64` 1.20250906.0, i.e. an **Intel** Mac):

| Run | Result |
| --- | --- |
| `pnpm test:runtime`, backend project | SIGSEGV after `e2e-conformance.test.ts` passed |
| Second backend attempt | SIGSEGV after `visibility.test.ts` and `team-accounts.test.ts` passed |

- No assertion failed before either crash, and `per-app-deletion.test.ts` (the changed scenario) had not run.
- The `ECONNREFUSED` / fetch failures that follow are consequences: they appear after the native process died.
- A separate config-drift retry hit five-second Miniflare startup deadlines under machine contention. It
  passed (31 tests) with a 15-second startup allowance. That is a different symptom and is not treated as
  part of the crash.
- The backend config is `singleWorker: true`, `isolatedStorage: false`. All 89 files in `test/backend`
  share one workerd process.

No crash report, core file or log from those runs was kept, and none exists in this repository, so the
evidence is the issue text alone.

## 2. What the "boundary files" have in common

Short answer: **nothing that points to a cause, and the named files are probably not where the crash happened.**

1. *"Crashed after passing X" does not say where it crashed.* The test files that were running when the
   process died are not named. The crash is in whichever file ran next. Vitest orders files by recorded
   duration and size from its own cache, so that order can differ between machines and runs. A fixed split
   "after `team-accounts`" would be an arbitrary cut.
2. The three named files do different things:
   - `e2e-conformance.test.ts` (13 tests): synthetic ingest, aggregates and incident reads through the real
     backend. No sockets and no Durable Object access. "room" appears only as a log *category* in scenario 6.
   - `visibility.test.ts` (27 tests): the most Room-heavy file. It opens WebSockets through the Room Durable
     Object, calls `runDurableObjectAlarm`, and reads `env.ROOM` stubs. The sockets it opens are closed
     (by the test or by the server's `4401` close), so no leak was found there.
   - `team-accounts.test.ts` (22 tests): no rooms. It makes heavy use of simultaneous D1 writes
     (12 `Promise.all` calls: simultaneous owner leave, mutual removal and demotion, six parallel invitation accepts).
3. What they share is only that all three run late in a long single-process run, after dozens of files,
   in one workerd process that has accumulated state. That is a property of the configuration (section 3),
   not of these files.

Windows cannot add to this: the WebSocket upgrade path (`SELF.fetch(...Upgrade: websocket)` returning
`res.webSocket`) fails on Windows workerd 1.20250906.0 (18 tests across `room-publish`, `room-seq-durable`,
`rooms-do` and `visibility` fail at `null.accept`). Those fail identically on clean `main`, so the Room paths
cannot be exercised locally at all.

## 3. Why the configuration makes a native fault expensive

- `singleWorker: true`: every file in a project runs in the same workerd process and isolate. Vitest resets
  module state per file; workerd's native state (Durable Object instances, their SQLite storage, alarms, the
  D1 and R2 simulators, open handles) is not reset by that.
- `isolatedStorage: false` (needed because the Room DO's SQLite `-shm` files cannot be snapshotted by the pool):
  nothing is rolled back between files either. Each file empties the tables it writes.
- The Room DO uses non-hibernating `server.accept()` WebSockets and re-arms a 60-second visibility alarm
  (`VISIBILITY_RECHECK_MS`) for as long as any peer is connected. Room objects persist across files.
- The result is one long-lived native process that sees all 89 files. A single native fault ends the run, at
  a file boundary, with no assertion failure, and hides every file after it. That is the symptom reported.
- The existing patch (`patches/@cloudflare__vitest-pool-workers@0.8.71.patch`, #313) is JavaScript-side only
  (it stops the pool nesting one Proxy per instance). It cannot cause a native fault, but it shows how
  long-lived this isolate is.

## 4. Upstream reports

- **workerd#6583** (open): a macOS segfault, `kj::Path::evalPart` in `ModuleRegistryImpl::resolve`, deterministic,
  *before any test body runs*, triggered by importing certain Worker/Durable Object modules, reported with
  `node:sqlite`. Pool 0.14.6, vitest 4, arm64. **Not a close match here:** nothing that runs under workerd in
  this repository imports `node:sqlite` (it appears only in node-side unit tests and `src/sqlite-d1.ts`), and the
  reported crashes came after files had passed. The reproduction repo linked there is worth running on the Mac.
- **workerd#6763** (open): an intermittent segfault when Miniflare tears a worker down between test files, with
  every test already passing. Reported on linux-x64 and macOS-arm64 (pool 0.12.21 to 0.16.4, vitest 2.0 to 4.1),
  about 5 in 39 sequential files, never with a single file. Same class of symptom (no assertion failure, a "Worker
  exited unexpectedly" / lost connection). **Partial fit:** in this repository's `singleWorker` runs the logs show
  one "Shutting down runtimes" at the end, not one teardown per file, so per-file teardown may not be the path. That
  needs confirming on the Mac (section 7, step 4).

Neither report establishes this crash's cause.

## 5. Suspected causes, most to least likely

None is confirmed. Ranked on how well each fits "intermittent, different boundaries, no assertion failure,
only on the long single-process run, macOS Intel, workerd 1.20250906.0".

1. **A workerd 1.20250906.0 native bug reached only by long, state-accumulating runs** (a Durable Object /
   SQLite / WebSocket / alarm path, or event-loop teardown). Fits everything and is consistent with the upstream
   reports. *Test:* run the same batches on the Mac with a newer workerd; read the macOS crash report's stack (7.6).
2. **Teardown-time fault of the 6763 class**, if the pool tears the runtime down more often than the logs suggest.
   *Test:* section 7, step 4.
3. **Concurrent D1 pressure** from the heavily parallel files (`team-accounts`, `quota-concurrency`,
   `usage-ping` with 50 parallel requests, the new 20-request join burst) on the native SQLite-backed D1.
   *Test:* run each parallel-heavy file alone, in a loop, on the Mac.
4. **Machine-specific:** an older Intel Mac under memory or CPU contention (the config-drift retry already hit
   startup deadlines). A SIGSEGV is not an out-of-memory kill, so this is less likely to be the crash itself, but
   contention changes timing. *Test:* repeat on an idle machine.
5. **#6583's `node:sqlite` trigger.** Unlikely, per section 4.

## 6. What was changed in this repository

`scripts/run-backend-batches.mjs`, wired into `pnpm test:runtime` and `pnpm --filter @proappstore/runtime-tests test:backend`.
The backend suite now runs as three sequential vitest processes, each with its **own workerd**:

| Batch | Files |
| --- | --- |
| `general-1` | the first 43 of the non-Room files, alphabetically |
| `general-2` | the remaining 42 |
| `rooms` | `room-publish`, `room-seq-durable`, `rooms-do`, `visibility` (the Room / WebSocket Durable Object files) |

- Every file runs exactly once. The script checks the batches partition `test/backend` and fails if an isolated
  file is renamed or missing. No test is removed, skipped or reordered within a batch.
- A failing batch does not stop the others, and the run exits non-zero if any batch failed.
- **There is no retry.** A suspected native crash (death by signal, exit 139, or a SIGSEGV/workerd-exit message)
  is printed as `NATIVE CRASH SUSPECTED` for that batch. It is a failure, not a flake.
- `pnpm --filter @proappstore/runtime-tests test:backend:single` runs the old single-process form for comparison.
  `node scripts/run-backend-batches.mjs --list` and `--batch <name|number>` list and run one batch.

**What this does and does not do.** It contains a native fault to one batch and names it, and it shortens the
process lifetime so less state accumulates. It does **not** remove the crash, and it does not prove the crash is
absent: if the Mac still crashes inside a batch, that is a result. The Linux CI `runtime-integration` job and the
backend deployment gate run the same full suite, now in three processes.

## 7. Reproduction on a Mac (needs a native macOS machine)

Run these on the affected Mac. They are read-only except for writing `*.log` files in the working directory.

```sh
# 0. Record the environment
sw_vers; uname -m; node -v; pnpm -v
vm_stat | head -5; sysctl hw.memsize hw.ncpu

# 1. Clean install and build, as CI does
git clone https://github.com/proappstore-online/platform.git && cd platform
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' build
pnpm --filter @proappstore/runtime-tests exec node ../backend/scripts/embed-data-worker.mjs
pnpm --filter @proappstore/runtime-tests exec node ../backend/scripts/embed-app-worker-shim.mjs

# 2. Baseline: the old single-process run, with the file order printed. Expected to reproduce the crash.
pnpm --filter @proappstore/runtime-tests test:backend:single --reporter=verbose 2>&1 | tee single.log
echo "exit=$?"; grep -nE "SIGSEGV|Segmentation|Worker exited|ECONNREFUSED" single.log | head
# The LAST file with a result line is where the process died; the next one in the order is the suspect.

# 3. The batched run (this change). Note which batch, if any, reports NATIVE CRASH SUSPECTED.
pnpm --filter @proappstore/runtime-tests test:backend 2>&1 | tee batches.log

# 4. Does the pool tear the runtime down per file or once? Count the markers.
grep -c "Shutting down runtimes" single.log; grep -c "Disposing remote proxy" single.log

# 5. Bisect: repeat a crashing batch, and each parallel-heavy file alone, 10 times.
cd packages/runtime-tests
for i in $(seq 1 10); do node scripts/run-backend-batches.mjs --batch rooms >/dev/null 2>&1; echo "rooms $i exit=$?"; done
for f in team-accounts quota-concurrency usage-ping e2e-conformance visibility; do
  for i in 1 2 3; do npx vitest run --config vitest.backend.ts test/backend/$f.test.ts >/dev/null 2>&1; echo "$f $i exit=$?"; done
done

# 6. Collect the native crash report: this has the stack. Attach it to #543.
ls -t ~/Library/Logs/DiagnosticReports/ | grep -i workerd | head
cp ~/Library/Logs/DiagnosticReports/workerd-*.ips . 2>/dev/null

# 7. Upstream's #6583 reproduction, for comparison
git clone https://github.com/paralin/workerd-issue-6583 && cd workerd-issue-6583 && npm install
node ./node_modules/vitest/vitest.mjs run --max-workers=1 --no-isolate src/control.test.ts   # passes upstream
```

Report back: the macOS version and `uname -m`, which file the single-process run died after (and the next file
in the verbose order), whether `rooms`, `general-1` or `general-2` crashed in step 3, the loop results in step 5,
and the `.ips` crash report. A crash in a batch means the batching is not enough on its own; a clean batched run
means it contained the fault but the single-process crash still needs a workerd upgrade (section 8).

## 8. Upgrading workerd or the pool

- `miniflare` 4.20250906.0, which the pool pins exactly, pins `workerd` to exactly 1.20250906.0. A newer
  workerd **cannot** be taken within pool 0.8.71's constraints without a pnpm override that bypasses that pin,
  which is unsupported and untested.
- The supported route is a newer pool: 0.9.x to 0.12.x (peer range vitest 2.0 to 3.2, so vitest 2.1.9 stays),
  which move Miniflare/workerd forward (0.12.0 uses miniflare 4.20260103.0 / workerd 1.20260103.0). 0.23.x and
  `@cloudflare/vitest-plugin` need vitest 4 or later, a larger migration. The pool package is deprecated in favour
  of the plugin.
- The existing patch targets 0.8.71's bundled file and must be re-derived for any newer pool, and whether upstream
  already fixed the Proxy nesting (#313) would need checking.
- The lockfile already holds a second workerd (1.20260430.1, pulled in by wrangler). That binary exists for
  Windows and Linux in `node_modules`, but is not what the tests use.
- Whether a newer workerd fixes a crash of this class is **unknown**: the upstream reports above are open and
  reproduce on 2026 builds, so a bump is a test to run on the Mac, not a fix to assume. No version was changed
  here, because the full runtime matrix has not been run against any other version and the macOS result is missing.
- Not recommended: wrapping the pool's dispose and close paths to swallow a post-test worker exit (as suggested
  in workerd#6763). It would turn a native crash into a green run, which #543 rules out.

## 9. Windows result for the batched run

Run on the Windows development machine (Node 24, `workerd-windows-64` 1.20250906.0), 2026-11-05, with
`node scripts/run-backend-batches.mjs`:

| Batch | Files | Tests |
| --- | --- | --- |
| `general-1` | 43 passed | 358 passed |
| `general-2` | 42 passed | 384 passed |
| `rooms` | 4 failed | 18 failed, 26 passed |

- That is 786 tests in all, the same number as the single-process run on the same machine (768 passed, 18 failed).
  The batching did not drop or add a test.
- The 18 failures are all in the `rooms` batch (`room-publish` 10, `room-seq-durable` 3, `rooms-do` 2,
  `visibility` 3), all the Windows WebSocket upgrade failure of section 2 (`res.webSocket` is null). They fail
  the same way on clean `main` without this change. They are not the macOS crash.
- No `NATIVE CRASH SUSPECTED` line was printed and no batch exited by signal.
- **This says nothing about macOS.** A different OS, architecture and workerd binary were used, the Room paths
  do not run here, and the crash was intermittent even where it was seen. The Windows run shows that the batching
  is a complete partition and works; it does not show that it prevents or fixes the crash.

## 10. What is still needed

A run of section 7 on the affected Intel Mac, and its `workerd-*.ips` crash report, are what is needed to pick
among the causes in section 5. Until then **#543 stays open**. Native validation may show that batching contains
the crash, that a specific file or Durable Object path triggers it, or that a pool upgrade (section 8) is required.
