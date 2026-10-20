import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkPermissions } from './permissions.js';

const run = (files: Record<string, string>) => checkPermissions(mapFileSource(new Map(Object.entries(files))));

describe('checkPermissions (#437)', () => {
  it('passes an app that uses nothing special', async () => {
    expect(await run({ 'web/src/App.tsx': 'export const App = () => null' })).toMatchObject({ status: 'pass', detail: 'uses no special browser permissions' });
  });

  it('warns, naming each detected permission mcp.json does not declare', async () => {
    const r = await run({ 'web/src/Call.tsx': 'getUserMedia({ video: true, audio: true })', 'web/src/Map.tsx': 'navigator.geolocation' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('microphone, camera, location');
    expect(r.suggestions![0]).toContain('"id": "microphone"');
  });

  it('passes when everything detected is declared, and lists declared extras', async () => {
    const r = await run({
      'web/src/Call.tsx': 'getUserMedia({ audio: true })',
      'mcp.json': JSON.stringify({ tools: [], permissions: [{ id: 'microphone', reason: 'Voice notes' }, 'notifications'] }),
    });
    expect(r).toMatchObject({ status: 'pass', detail: 'declares microphone, notifications' });
  });

  it('warns on an invalid declaration', async () => {
    const r = await run({ 'mcp.json': JSON.stringify({ permissions: [{ id: 'x' }] }) });
    expect(r).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^mcp\.json permissions\[0\]\.id/) });
  });
});
