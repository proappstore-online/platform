import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const templates = ['template-workspace', 'template-map', 'template-membership'] as const;

describe.each(templates)('%s lint-staged configuration', (template) => {
  const configPath = new URL(`../templates/${template}/.lintstagedrc.cjs`, import.meta.url);
  const legacyConfigPath = new URL(`../templates/${template}/.lintstagedrc.json`, import.meta.url);

  it('runs whole-project checks from function commands without staged filenames', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(legacyConfigPath)).toBe(false);

    const config = require(configPath.pathname) as Record<string, (files: string[]) => string[]>;
    const sourceChecks = config['web/src/**/*.{ts,tsx}'];
    const jsonChecks = config['web/**/*.json'];

    expect(sourceChecks).toEqual(expect.any(Function));
    expect(jsonChecks).toEqual(expect.any(Function));
    expect(sourceChecks(['web/src/App.tsx'])).toEqual(['pnpm typecheck', 'pnpm test']);
    expect(jsonChecks(['web/package.json'])).toEqual(['pnpm test']);
  });
});
