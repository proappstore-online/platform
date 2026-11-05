import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const templates = ['template-workspace', 'template-map', 'template-membership'] as const;

it('loads a CommonJS config through a file URL containing spaces and # (#554)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pas config #'));
  try {
    const path = join(dir, 'config.cjs');
    writeFileSync(path, 'module.exports = { check: true };');
    expect(require(fileURLToPath(pathToFileURL(path)))).toEqual({ check: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe.each(templates)('%s lint-staged configuration', (template) => {
  const configPath = new URL(`../templates/${template}/.lintstagedrc.cjs`, import.meta.url);
  const legacyConfigPath = new URL(`../templates/${template}/.lintstagedrc.json`, import.meta.url);

  it('runs whole-project checks from function commands without staged filenames', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(legacyConfigPath)).toBe(false);

    const config = require(fileURLToPath(configPath)) as Record<string, (files: string[]) => string[]>;
    const sourceChecks = config['web/src/**/*.{ts,tsx}'];
    const jsonChecks = config['web/**/*.json'];

    expect(sourceChecks).toEqual(expect.any(Function));
    expect(jsonChecks).toEqual(expect.any(Function));
    expect(sourceChecks(['web/src/App.tsx'])).toEqual(['pnpm typecheck', 'pnpm test']);
    expect(jsonChecks(['web/package.json'])).toEqual(['pnpm test']);
  });
});
