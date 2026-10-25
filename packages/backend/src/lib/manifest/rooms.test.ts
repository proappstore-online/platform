import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { validateRooms } from './rooms.js';

const authorize = {
  name: 'can_join', description: 'Can join', operation: 'query', requires_auth: true,
  sql: 'SELECT 1 FROM members WHERE room = :room AND user_id = :__user_id',
  params: { room: { type: 'string' }, key: { type: 'string', optional: true } },
} as unknown as ToolManifest;

describe('validateRooms', () => {
  it('treats an absent section as no rules', () => {
    expect(validateRooms(undefined, [])).toEqual({ rules: [] });
    expect(validateRooms(null, [])).toEqual({ rules: [] });
  });

  it('accepts a rule naming a user-callable query', () => {
    expect(validateRooms([{ pattern: 'chat:*', authorize: 'can_join' }], [authorize])).toEqual({ rules: [{ prefix: 'chat:', authorize: 'can_join' }] });
  });

  it('refuses a non-array, unknown fields, bad patterns and the platform\'s user: prefix', () => {
    expect(validateRooms({}, [authorize])).toMatchObject({ error: expect.stringContaining('rooms must be an array of at most') });
    expect(validateRooms([{ pattern: 'chat:*', authorize: 'can_join', x: 1 }], [authorize])).toEqual({ error: 'rooms[0]: unknown field "x"' });
    expect(validateRooms([{ pattern: 'chat', authorize: 'can_join' }], [authorize])).toMatchObject({ error: expect.stringContaining('rooms[0].pattern must be a lowercase prefix') });
    expect(validateRooms([{ pattern: 'user:*', authorize: 'can_join' }], [authorize])).toMatchObject({ error: expect.stringContaining('"user:*" is the platform\'s own') });
  });

  it('refuses a repeated pattern', () => {
    expect(validateRooms([{ pattern: 'chat:*', authorize: 'can_join' }, { pattern: 'chat:*', authorize: 'can_join' }], [authorize]))
      .toEqual({ error: 'rooms[1]: duplicate pattern "chat:*"' });
  });

  it('refuses an authorize action that cannot run as the joining user', () => {
    const rule = [{ pattern: 'chat:*', authorize: 'can_join' }];
    expect(validateRooms(rule, [])).toEqual({ error: 'rooms[0].authorize must name an action in this manifest' });
    expect(validateRooms(rule, [{ ...authorize, operation: 'execute' } as ToolManifest])).toMatchObject({ error: expect.stringContaining('must be a query action') });
    expect(validateRooms(rule, [{ ...authorize, requires_auth: false } as ToolManifest])).toMatchObject({ error: expect.stringContaining('must require sign-in') });
    expect(validateRooms(rule, [{ ...authorize, callers: ['worker'] } as ToolManifest])).toEqual({ error: 'rooms[0].authorize "can_join" must list "user" in its callers' });
    expect(validateRooms(rule, [{ ...authorize, step_up: true } as ToolManifest])).toMatchObject({ error: expect.stringContaining('cannot be scheduled or require step_up') });
    expect(validateRooms(rule, [{ ...authorize, params: { ...authorize.params, other: { type: 'string' } } } as ToolManifest]))
      .toEqual({ error: 'rooms[0].authorize "can_join": param "other" is required, but a join passes only "room" and "key"' });
  });
});
