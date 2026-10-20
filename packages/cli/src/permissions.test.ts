import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectAppPermissions } from './permissions.js';

describe('pas permissions (#437)', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('detects what the app source uses, ignoring tests and node_modules', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pas-perms-'));
    const file = (p: string, s: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), s); };
    file('web/src/Call.tsx', 'navigator.mediaDevices.getUserMedia({ audio: true })');
    file('web/src/Map.tsx', 'navigator.geolocation.getCurrentPosition(cb)');
    file('web/src/Call.test.tsx', 'navigator.requestMIDIAccess()');
    file('node_modules/x/index.js', 'navigator.usb');
    expect(await detectAppPermissions(dir)).toEqual(['microphone', 'location']);
  });
});
