import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsFileSource, mapFileSource } from '../lib/file-source.js';
import { checkTemplateDefaultIcon } from './template-default-icon.js';

const FIX = join(__dirname, '..', '__fixtures__', 'template-icons');
const fixture = (n: string) => readFileSync(join(FIX, n));

function app(icons: Record<string, Buffer | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'icon-check-'));
  mkdirSync(join(dir, 'web', 'public'), { recursive: true });
  for (const [f, b] of Object.entries(icons)) writeFileSync(join(dir, 'web', 'public', f), b);
  return dir;
}

describe('checkTemplateDefaultIcon (#505)', () => {
  it('warns (does not fail) on the old template F icon', async () => {
    const r = await checkTemplateDefaultIcon(fsFileSource(app({ 'icon-192.png': fixture('f-192.png'), 'icon-512.png': fixture('f-512.png') })));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('web/public/icon-192.png');
    expect(r.detail).toContain('web/public/icon-512.png');
    expect(r.suggestions?.join(' ')).toContain('pas brand icons');
  });

  it('warns on the neutral PAS placeholder the template ships now', async () => {
    const r = await checkTemplateDefaultIcon(fsFileSource(app({ 'icon-192.png': fixture('placeholder-192.png') })));
    expect(r.status).toBe('warn');
  });

  it('passes on a custom icon', async () => {
    const r = await checkTemplateDefaultIcon(fsFileSource(app({ 'icon-192.png': 'owner-logo', 'icon-512.png': 'owner-logo' })));
    expect(r.status).toBe('pass');
  });

  it('passes when there are no icons, and where binary files cannot be read', async () => {
    expect((await checkTemplateDefaultIcon(fsFileSource(app({})))).status).toBe('pass');
    expect((await checkTemplateDefaultIcon(mapFileSource(new Map()))).status).toBe('pass');
  });
});
