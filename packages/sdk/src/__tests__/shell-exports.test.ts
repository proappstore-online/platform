import { describe, expect, it } from 'vitest';
import { AppShell, ProShell } from '../index.js';
import { AppShell as SubpathAppShell, ProShell as SubpathProShell } from '../shell.js';

describe('AppShell exports (#1288)', () => {
  it('keeps the legacy root and subpath names identical to the canonical component', () => {
    expect(ProShell).toBe(AppShell);
    expect(SubpathAppShell).toBe(AppShell);
    expect(SubpathProShell).toBe(AppShell);
  });
});
