# Contributing to PAS App Templates

All PAS app repositories—including those built from these templates—must enforce a shared quality standard: **a pre-commit hook that validates code locally before it can be committed.**

## Pre-Commit Hook Standard

Every PAS app repo runs this hook before each commit:

- **Typecheck** — TypeScript static analysis
- **Lint** — Code style checks (configured per app)
- **Fast unit tests** — Quick validation (not full e2e; those run in CI)

This catches cheap failures immediately, saving GitHub Actions minutes and keeping CI green.

### Installation

The hook installs automatically when you run `pnpm install` (via the `prepare` script):

```bash
pnpm install
# → husky install + hook set up in .git/hooks/pre-commit
```

### What the Hook Runs

When you commit, `lint-staged` runs the commands in `.lintstagedrc.json` on changed files:

```json
{
  "web/src/**/*.{ts,tsx}": ["pnpm typecheck", "pnpm test"],
  "web/**/*.json": ["pnpm test"]
}
```

If any check fails, the commit is blocked. Fix the issue and commit again.

### Skipping the Hook (Emergencies Only)

The hook has a documented escape hatch for genuine emergencies:

```bash
git commit --no-verify
```

**Use this only when absolutely necessary** — it should be rare. The hook exists to prevent
avoidable CI failures; bypassing it for work-in-progress or broken code defeats that goal.

## Extending the Hook

To add custom linting (ESLint, Prettier, etc.):

1. Install your linter in `web/package.json` (not the root).
2. Update `.lintstagedrc.json` to run it:
   ```json
   {
     "web/src/**/*.{ts,tsx}": [
       "prettier --write",
       "eslint --fix",
       "pnpm typecheck",
       "pnpm test"
     ]
   }
   ```
3. Commit `.lintstagedrc.json`; the hook uses it automatically on next install.

## Questions?

- See your app's `CLAUDE.md` for repo-specific setup.
- Check the platform docs: https://docs.proappstore.online/
