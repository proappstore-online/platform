import { describe, expect, it } from 'vitest';
import { validateConnectors } from './connectors.js';
import type { HookDef } from './hooks.js';

const ghHook = { name: 'gh', verify: { kind: 'github-app' }, to: 'worker' } as unknown as HookDef;
const otherHook = { name: 'other', verify: { kind: 'hmac' }, to: 'worker' } as unknown as HookDef;

describe('validateConnectors', () => {
  it('validates Google capability and publisher disclosure boundaries', () => {
    const disclosure = { purpose: 'Read selected meeting records.', audience: 'Only authorized app members.', retention: 'Until you delete your saved records.', privacy_path: '/privacy', deletion_path: '/settings/data' };
    const connector = { name: 'calendar', kind: 'google_calendar', modes: ['oauth'], capabilities: ['calendar.read'], disclosure };
    expect(validateConnectors([connector], [])).toHaveProperty('connectors');
    for (const capabilities of [[], ['meet.read'], ['calendar.write'], ['calendar.read', 'calendar.read']]) {
      expect(validateConnectors([{ ...connector, capabilities }], [])).toHaveProperty('error');
    }
    for (const invalid of [{ ...disclosure, privacy_path: '//outside.test/privacy' }, { ...disclosure, deletion_path: 'https://outside.test/delete' }, { ...disclosure, audience: 'short' }, { ...disclosure, unexpected: 'field' }, { ...disclosure, retention: 'Newline\ninside disclosure' }]) {
      expect(validateConnectors([{ ...connector, disclosure: invalid }], [])).toHaveProperty('error');
    }
    expect(validateConnectors([{ name: 'github', kind: 'github', modes: ['app'], capabilities: ['calendar.read'] }], [])).toHaveProperty('error');
  });
  it('accepts one read-only Google OAuth connector alongside GitHub, with no PAT or hooks', () => {
    const google = { name: 'calendar', kind: 'google_calendar', modes: ['oauth'] };
    expect(validateConnectors([google, { name: 'github', kind: 'github', modes: ['pat'], pat_secret: 'GH_PAT' }], []))
      .toMatchObject({ connectors: [{ ...google, pat_secret: null, events: [], hook: null }, { kind: 'github' }] });
    for (const extra of [{ modes: ['pat'] }, { modes: ['oauth', 'app'] }, { pat_secret: 'TOKEN' }, { hook: 'gh' }, { events: ['push'] }]) {
      expect(validateConnectors([{ ...google, ...extra }], [ghHook])).toHaveProperty('error');
    }
    expect(validateConnectors([google, { ...google, name: 'second' }], [])).toHaveProperty('error');
  });
  it('treats an absent section as no connectors', () => {
    expect(validateConnectors(undefined, [])).toEqual({ connectors: [] });
    expect(validateConnectors(null, [])).toEqual({ connectors: [] });
  });

  it('accepts a github app connector with events and a github-app hook', () => {
    expect(validateConnectors([{ name: 'github', kind: 'github', modes: ['app'], events: ['push'], hook: 'gh' }], [ghHook]))
      .toEqual({ connectors: [{ name: 'github', kind: 'github', modes: ['app'], pat_secret: null, events: ['push'], hook: 'gh' }] });
  });

  it('accepts a pat connector that names its secret', () => {
    expect(validateConnectors([{ name: 'github', kind: 'github', modes: ['pat'], pat_secret: 'GH_PAT' }], []))
      .toMatchObject({ connectors: [{ modes: ['pat'], pat_secret: 'GH_PAT', events: [], hook: null }] });
  });

  it('refuses a non-array, unknown fields, other kinds and a second github connector', () => {
    expect(validateConnectors({}, [])).toEqual({ error: 'connectors must be an array of at most 3 connectors' });
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['app'], x: 1 }], [])).toEqual({ error: 'connectors[0]: unknown field "x"' });
    expect(validateConnectors([{ name: 'g', kind: 'gitlab', modes: ['app'] }], [])).toEqual({ error: 'connectors[0].kind must be "github" or "google_calendar"' });
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['app'] }, { name: 'h', kind: 'github', modes: ['app'] }], []))
      .toEqual({ error: 'connectors[1]: an app declares at most one github connector' });
  });

  it('checks modes and pat_secret together', () => {
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: [] }], [])).toEqual({ error: 'connectors[0].modes must be a non-empty list of app, pat' });
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['pat'] }], [])).toMatchObject({ error: expect.stringContaining('connectors[0].pat_secret must name an app secret') });
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['app'], pat_secret: 'GH_PAT' }], [])).toEqual({ error: 'connectors[0].pat_secret applies only with mode "pat"' });
  });

  it('requires events to ride a github-app hook', () => {
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['app'], events: ['push'] }], [ghHook])).toEqual({ error: 'connectors[0].hook is required with events' });
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['app'], events: ['push'], hook: 'other' }], [otherHook]))
      .toEqual({ error: 'connectors[0].hook must name a hook in this manifest with verify.kind "github-app"' });
    expect(validateConnectors([{ name: 'g', kind: 'github', modes: ['pat'], pat_secret: 'GH_PAT', events: ['push'], hook: 'gh' }], [ghHook]))
      .toEqual({ error: 'connectors[0].events are delivered by the GitHub App, so modes must include "app"' });
  });
});
