import { describe, expect, it } from 'vitest';
import type { ToolManifest } from './action-sql.js';
import { ROOM_ID, ruleFor, workerRoomPublish, MAX_ROOM_EVENT_BYTES } from './room-access.js';
import { WorkerCallError } from './app-worker-calls.js';
import { validateRooms } from '../routes/tools.js';
import type { Env } from '../types.js';

// #351: the `rooms` manifest section, rule matching, and the publish input checks that run before any D1 or room work.

const member: ToolManifest = {
  name: 'can_join_campaign', description: 'Is the caller on this campaign', operation: 'query', requires_auth: true,
  sql: 'SELECT 1 AS ok FROM campaign_members WHERE campaign_id = :key AND user_id = :__user_id LIMIT 1',
  params: { key: { type: 'string' } },
} as ToolManifest;

describe('validateRooms (#351)', () => {
  it('accepts prefix patterns bound to a user-callable query, and none at all', () => {
    expect(validateRooms(undefined, [member])).toEqual({ rules: [] });
    expect(validateRooms([{ pattern: 'chat:*', authorize: 'can_join_campaign' }, { pattern: 'doors:*', authorize: 'can_join_campaign' }], [member]))
      .toEqual({ rules: [{ prefix: 'chat:', authorize: 'can_join_campaign' }, { prefix: 'doors:', authorize: 'can_join_campaign' }] });
  });

  it.each([
    [[{ pattern: 'user:*', authorize: 'can_join_campaign' }], "is the platform's own"],
    [[{ pattern: 'chat', authorize: 'can_join_campaign' }], 'must be a lowercase prefix'],
    [[{ pattern: 'Chat:*', authorize: 'can_join_campaign' }], 'must be a lowercase prefix'],
    [[{ pattern: 'chat:*', authorize: 'nope' }], 'must name an action in this manifest'],
    [[{ pattern: 'chat:*', authorize: 'can_join_campaign' }, { pattern: 'chat:*', authorize: 'can_join_campaign' }], 'duplicate pattern'],
    [[{ pattern: 'chat:*', authorize: 'can_join_campaign', extra: 1 }], 'unknown field "extra"'],
    [Array.from({ length: 21 }, (_, i) => ({ pattern: `r${i}:*`, authorize: 'can_join_campaign' })), 'at most 20'],
  ])('refuses %j', (rooms, error) => {
    expect(validateRooms(rooms, [member])).toEqual({ error: expect.stringContaining(error) });
  });

  it.each([
    [{ operation: 'execute' }, 'must be a query action'],
    [{ requires_auth: false }, 'must require sign-in'],
    [{ callers: ['worker'] }, 'must list "user" in its callers'],
    [{ step_up: true }, 'cannot be scheduled or require step_up'],
    [{ params: { campaign: { type: 'string' } } }, 'param "campaign" is required'],
  ])('refuses an authorize action with %j', (patch, error) => {
    expect(validateRooms([{ pattern: 'chat:*', authorize: 'can_join_campaign' }], [{ ...member, ...patch } as ToolManifest]))
      .toEqual({ error: expect.stringContaining(error) });
  });
});

describe('ruleFor (#351)', () => {
  const rules = [{ prefix: 'chat:', authorize: 'a' }, { prefix: 'chat:vip:', authorize: 'b' }];
  it('picks the longest matching prefix; no match means an open room', () => {
    expect(ruleFor(rules, 'chat:c1')?.authorize).toBe('a');
    expect(ruleFor(rules, 'chat:vip:c1')?.authorize).toBe('b');
    expect(ruleFor(rules, 'lobby')).toBeNull();
    expect(ruleFor(rules, 'xchat:c1')).toBeNull();
  });
});

describe('workerRoomPublish input checks (#351)', () => {
  // Every refusal here happens before D1 or the room are touched: an env without them proves it.
  const env = {} as Env;
  const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof WorkerCallError ? e.code : String(e)));

  it('refuses room ids outside the room id grammar', async () => {
    for (const room of ['', ' lobby', 'a/b', 'x'.repeat(129), 7, null]) expect(await code(workerRoomPublish(env, 't', room, {})), String(room)).toBe('InvalidRoom');
    expect(ROOM_ID.test('notifications:gh:12')).toBe(true);
    expect(ROOM_ID.test('user:google:abc@x.y')).toBe(true);
  });

  it('refuses data that is not JSON, and data over the size cap', async () => {
    expect(await code(workerRoomPublish(env, 't', 'chat:c1', undefined))).toBe('BadRequest');
    expect(await code(workerRoomPublish(env, 't', 'chat:c1', () => 1))).toBe('BadRequest');
    expect(await code(workerRoomPublish(env, 't', 'chat:c1', { big: 1n }))).toBe('BadRequest');
    expect(await code(workerRoomPublish(env, 't', 'chat:c1', { s: 'x'.repeat(MAX_ROOM_EVENT_BYTES) }))).toBe('PayloadTooLarge');
  });
});
