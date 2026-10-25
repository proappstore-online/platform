import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { validateVisibility } from './visibility.js';

const publicAction = { name: 'list_posts', requires_auth: false } as ToolManifest;

describe('validateVisibility', () => {
  it('treats an absent visibility as the default', () => {
    expect(validateVisibility(undefined, [])).toEqual({ visibility: null });
    expect(validateVisibility(null, [])).toEqual({ visibility: null });
  });

  it('accepts public and private modes with roles', () => {
    expect(validateVisibility({ mode: 'public' }, [publicAction])).toEqual({ visibility: { mode: 'public', roles: [] } });
    expect(validateVisibility({ mode: 'private', roles: ['staff'] }, [])).toEqual({ visibility: { mode: 'private', roles: ['staff'] } });
  });

  it('refuses a bad mode or shape', () => {
    expect(validateVisibility([], [])).toEqual({ error: 'visibility must be an object' });
    expect(validateVisibility({ mode: 'secret' }, [])).toEqual({ error: "visibility.mode must be 'public' or 'private'" });
  });

  it("refuses 'member', repeated roles and malformed roles", () => {
    expect(validateVisibility({ mode: 'private', roles: ['member'] }, [])).toEqual({ error: "visibility.roles cannot include 'member' (every signed-in user holds it)" });
    expect(validateVisibility({ mode: 'private', roles: ['a', 'a'] }, [])).toEqual({ error: 'visibility.roles must not repeat a role' });
    expect(validateVisibility({ mode: 'private', roles: ['A'] }, [])).toMatchObject({ error: expect.stringContaining('visibility.roles entries') });
  });

  it('refuses a private app that registers a public action', () => {
    expect(validateVisibility({ mode: 'private' }, [publicAction]))
      .toEqual({ error: 'visibility: a private app cannot register public action "list_posts" (requires_auth false)' });
  });
});
