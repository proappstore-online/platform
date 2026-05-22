#!/bin/bash
# Design system lint — run in CI to catch violations.
# See DESIGN-SYSTEM.md for the full spec.
set -euo pipefail

FAIL=0

# 1. Banned CSS variable names (old aliases)
# Match --bg followed by : or ) but NOT --bg- (compound like --icon-bg)
BANNED_VARS='var\(--bg\)|--bg\s*:|var\(--surface\)|--surface\s*:|var\(--border\b|--border\s*:|var\(--glass|--glass\s*:|var\(--dock|--dock\s*:'
if grep -rn --include="*.css" -E "$BANNED_VARS" "${1:-.}" 2>/dev/null | grep -v node_modules | grep -v '.min.css' | grep -v 'prism' | grep -v 'test/fixtures' | grep -v '/dist/'; then
  echo "FAIL: Found banned CSS variable names. Use standard tokens from DESIGN-SYSTEM.md"
  echo "  --bg → --paper, --surface → --panel, --border → --line, --glass → --panel"
  FAIL=1
fi

# 2. Dark mode must use [data-theme], not .dark class
if grep -rn --include="*.css" 'html\.dark\b' "${1:-.}" 2>/dev/null | grep -v node_modules | grep -v '.min.css' | grep -v 'prism' | grep -v 'test/fixtures' | grep -v '/dist/'; then
  echo "FAIL: Found html.dark selector. Use :root[data-theme='dark'] instead"
  FAIL=1
fi

# 3. Theme storage key must be 'stores-theme'
if grep -rn --include="*.js" --include="*.ts" --include="*.tsx" "localStorage.*theme" "${1:-.}" 2>/dev/null | grep -v node_modules | grep -v 'stores-theme' | grep -v '.min.js' | grep -v 'prism' | grep -v 'test/fixtures' | grep -v '/dist/'; then
  echo "FAIL: Theme localStorage key must be 'stores-theme'"
  FAIL=1
fi

# 4. classList.add('dark') or classList.remove('dark') — old dark mode toggle
if grep -rn --include="*.js" --include="*.ts" --include="*.tsx" "classList.*['\"]dark['\"]" "${1:-.}" 2>/dev/null | grep -v node_modules | grep -v '.min.js' | grep -v 'test/fixtures' | grep -v '/dist/'; then
  echo "FAIL: Found classList dark toggle. Use dataset.theme='dark' instead"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK: Design system checks passed"
fi

exit $FAIL
