# App Development Guide

## Pre-Commit Hook Standard

Every PAS app repo includes a **pre-commit hook** that validates code before each commit. This is a platform-wide requirement for all app repositories.

### Why This Matters

The hook catches failures locally instead of burning GitHub Actions CI minutes:

- **Typecheck** finds type errors before pushing
- **Lint** enforces code style consistency
- **Fast tests** validate logic quickly (no e2e setup needed)

Full integration and e2e suites stay in CI; the hook handles the cheap checks.

### What the Hook Does

When you commit, the hook runs:

```bash
pnpm typecheck   # TypeScript static analysis
pnpm test        # Fast unit tests (not full e2e)
pnpm lint        # Code style checks (if configured)
```

If any check fails, your commit is blocked. Fix the issue and try again.

### Installation

The hook installs automatically when you clone or set up an app repo:

```bash
pnpm install
# → Installs husky + lint-staged + sets up .git/hooks/pre-commit
```

### The `--no-verify` Escape Hatch

For genuine emergencies, you can bypass the hook:

```bash
git commit --no-verify
```

**Use this sparingly.** The hook exists to protect CI and team quality. Overusing it defeats its purpose.

Common (valid) reasons:
- Merging a hotfix in an already-broken state (temporary bypass to land the fix)
- Committing work-in-progress that you're about to immediately fix

Invalid reasons:
- "I didn't want to fix the type error" — fix it; typecheck is cheap and catches real bugs
- "The test takes too long" — the hook runs *fast* tests; full e2e runs in CI
- "I'm not done yet" — commit when you have working code, not broken WIP

## Extending the Hook for Your App

The hook runs commands defined in `.lintstagedrc.json`. To add custom linting:

### 1. Install your linter

If you want ESLint, Prettier, or another tool:

```bash
# In the app repo root
pnpm add -D eslint prettier
# or in the web subpackage:
pnpm --filter @APPNAME/web add -D eslint prettier
```

### 2. Configure the tool

Create `.eslintrc.json`, `prettier.config.json`, etc. per the tool's docs.

### 3. Update `.lintstagedrc.json`

Add your linter to the pre-commit check:

```json
{
  "web/src/**/*.{ts,tsx}": [
    "prettier --write",
    "eslint --fix",
    "pnpm typecheck",
    "pnpm test"
  ],
  "web/**/*.json": ["prettier --write"]
}
```

### 4. Test it

Make a change and commit — your linter should run automatically.

## File Structure

```
your-app-repo/
├── .husky/
│   └── pre-commit        # Hook entry point (do not edit)
├── .lintstagedrc.json    # Hook configuration (customize for your app)
├── .github/workflows/    # CI pipelines
├── web/                  # Frontend React app
├── qa/                   # Fast unit/integration tests
├── migrations.json       # D1 database schema
├── mcp.json              # Action + tool definitions
├── package.json          # Root scripts
└── CONTRIBUTING.md       # Contributing guidelines (from template)
```

## Quick Start Checklist

- [ ] `pnpm install` (sets up the pre-commit hook)
- [ ] `pnpm dev` (start the dev server)
- [ ] `pnpm test` (run fast tests locally)
- [ ] `pnpm build` (verify the build works)
- [ ] Make a small change and commit (verify the hook runs)
- [ ] Check `.lintstagedrc.json` for what your hook actually runs

## Troubleshooting

### Hook didn't run on commit

Husky may not have installed. Try:

```bash
pnpm install
# Then re-run your commit
```

### Hook ran the wrong checks

Update `.lintstagedrc.json` to match your needs, then commit the changes.

### Tests are too slow

The hook runs *fast* tests only. If your `pnpm test` includes slow e2e:

1. Move slow tests to a separate script (e.g., `pnpm test:e2e`)
2. Update `.lintstagedrc.json` to run `pnpm test` (fast only), not `test:e2e`

### I need to temporarily bypass the hook

```bash
git commit --no-verify
```

Then fix the underlying issue and commit again properly (without `--no-verify`).
