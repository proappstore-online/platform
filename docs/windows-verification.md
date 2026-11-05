# Verification from a Windows host

Use Node 22 and pnpm 10.30.3 (the CI toolchain). Run from the platform root:

```powershell
pnpm verify
```

The command uses pnpm's JavaScript entry point through Node, so spaces in the install path and
PowerShell's `.ps1`/`.cmd` wrappers do not require shell quoting. Every gate in `CLAUDE.md` appears
in `artifacts/verification/report.json`, with a separate log and exact exit code. It continues
collecting evidence after a failed check. A gate has a ten-minute deadline; a timeout fails the
gate and attempts to terminate its process tree. Cleanup waits at most three additional seconds.
If termination fails or the process still has not closed, the log and report record warnings,
the runner disconnects its pipes and continues with a failed timeout result. Descendants may
remain when termination fails; the report does not claim successful cleanup. No timeout is a test pass.

The report records HEAD, dirty status, the tracked patch, hashes of that patch and untracked files,
Node/pnpm versions and platform. HEAD is captured in both the initial and final fingerprints,
so moving between clean commits also invalidates the release result. Changes detected between
the initial and final fingerprints invalidate its release result.
Keep the report and logs with the handoff. Do not infer success from the last lines of a partial log.

Windows preflight leaves `design`, `unit` and `coverage` as `pending-posix`, with no exit code.
The full unit suite executes actual Bash workflow steps with executable shell stubs and asserts
POSIX credential file/directory permission bits. Native Windows does not implement that permission
contract. MSYS2 Bash alone does not turn Windows Node into POSIX Node. No tests or permission
assertions are disabled, and coverage floors are unchanged. The other gates execute locally and
can still fail for missing browser binaries, runtime support or toolchain problems.

## Complete release verification

Use an already approved Linux runner with Node 22, pnpm 10.30.3, Bash, jq, coreutils, and the
Chromium/WebKit binaries and libraries used by `.github/workflows/ci.yml`. If Bash is outside PATH,
set `PAS_VERIFY_BASH` to its executable path for the design check. Unit workflow tests use `bash`
from PATH, so that must also resolve to the runner's native Bash. Do not select Windows' WSL launcher.

On that runner, use the exact candidate contents, then run:

```sh
pnpm verify
```

On POSIX this executes every gate, including full unit tests, V8 coverage with the existing floors,
real workerd/D1 runtime tests, both browser checks, docs, design, deploy paths, Knip, typecheck,
build, skill validation and the read-only template drift check. The drift check needs the existing
authorized GitHub access to `proappstore-online/template-app`. `releasePassed: true` and exit 0
require every gate to pass with unchanged inputs. CI's existing Ubuntu jobs remain mandatory.

If no approved compatible runner is accessible, report that dependency and keep the release
unverified. Do not install WSL, provision a runner, obtain credentials, restart machines, change
agent pins or expand permissions to work around it. A successful CI run at a different revision
does not verify local changes.

## Issue #552 handoff

Keep its seven unfinished files separate from #554. Compare failures on the clean baseline and
candidate using the same toolchain and build prerequisites before attributing them to feature code.
The clean baseline for this investigation is `93b7ec06c1bacf38a9033fd3fdd519caa5e30561`.
The detached baseline checkout is `../platform-baseline-554`; it contains no #552 working changes.
Existing recovery refs and stashes are untouched.

The clean baseline on Windows/Node `v24.12.0`/pnpm `10.30.3`, after frozen install and workspace
build (both exit 0), ran `pnpm vitest run --reporter=json --outputFile=baseline-554-built.json`:
exit 1, 408 files (400 passed, 8 failed), 6,563 passed / 45 failed / 9 skipped assertions.
There were no suite-load failures after the build prerequisite. The initial run before building
had missing workspace-package entry points and is not the comparison baseline.

| Failing file | Assertions | Cause and remedy |
| --- | ---: | --- |
| `packages/admin/src/publish.test.ts` | 26 | `bash` selected the WSL launcher with no distribution. Execute the real workflow scripts and stubs on native POSIX with Bash/jq/coreutils/Node. |
| `packages/admin/src/app-deploy-workflow.test.ts` | 9 | Same shell failure; preserve OIDC and migration fail-closed assertions on POSIX. |
| `packages/cli/src/marketing.test.ts` | 2 | Expected slash paths instead of native filesystem paths; construct expected paths with `node:path.join`. |
| `packages/cli/src/mcp-remote-auth.test.ts` | 1 | Windows mode `0666` versus required POSIX `0600`; keep the `0600`/`0700` security assertions on POSIX. |
| `packages/agent-teams/src/runtimes/ai-gateway.test.ts` | 1 | Normalize relative inventory paths before comparing slash-separated repository names. |
| `packages/backend/src/lib/accounts/contract.test.ts` | 2 | Normalize inventory paths before applying ownership exclusions and classification keys. |
| `test/deploy-paths.test.ts` | 1 | Normalize repository paths in checker diagnostics, preserving dependency checks. |
| `test/template-lint-staged.test.ts` | 3 | Convert file URLs with `fileURLToPath`, preserving drive letters and decoding escaped characters. |

`artifacts/verification/baseline-inventory.json` records every exact failing assertion name, message,
platform and remedy; `baseline-unit.json` retains the full machine-readable baseline. Knip also
fails on unchanged main while loading `packages/runtime-tests/vitest.backend.ts` with
`Cannot read properties of undefined (reading 'resolve')`; do not suppress its runtime config or
unused-file checks. Verify it on the supported Node 22/POSIX toolchain before release.

Deliver the exact candidate identity, report and all logs, plus a complete failure inventory with
test names, platform, messages and remedies. Focused #552 tests cannot substitute for the release
bar. Do not close the promoter epic or publish unfinished #552 work on their strength.
