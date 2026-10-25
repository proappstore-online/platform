import { describe, expect, it } from 'vitest';
import { validateConnectors } from './connectors.js';
import type { HookDef } from './hooks.js';

const ghHook = { name: 'gh', verify: { kind: 'github-app' }, to: 'worker' } as unknown as HookDef;
const otherHook = { name: 'other', verify: { kind: 'hmac' }, to: 'worker' } as unknown as HookDef;

describe('validateConnectors', () => {
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
    expect(validateConnectors([{ name: 'g', kind: 'gitlab', modes: ['app'] }], [])).toEqual({ error: 'connectors[0].kind must be "github"' });
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
