import { describe, expect, it, vi } from 'vitest';
import { listAuditEvents } from './safety.js';

describe('recent MCP audit events', () => {
  it('selects newest events across all KV pages before fetching their values', async () => {
    const prefix = 'audit:gh:1:';
    const names = Array.from({ length: 1002 }, (_, i) => `${prefix}${String(i).padStart(4, '0')}:event`);
    const list = vi.fn(async ({ prefix: requestedPrefix, cursor, limit }: { prefix: string; cursor?: string; limit: number }) => {
      expect(requestedPrefix).toBe(prefix);
      const offset = Number(cursor ?? 0);
      const keys = names.slice(offset, offset + limit).map(name => ({ name }));
      const next = offset + keys.length;
      return { keys, list_complete: next >= names.length, cursor: String(next) };
    });
    const get = vi.fn(async (name: string) => JSON.stringify({ key: name }));
    const env = { OAUTH_KV: { list, get } as unknown as KVNamespace };

    const rows = await listAuditEvents({ env, subject: 'gh:1' }, 2);

    expect(rows).toEqual([{ key: names[1001] }, { key: names[1000] }]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('follows a cursor even when an intermediate KV page is empty', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ keys: [], list_complete: false, cursor: 'next' })
      .mockResolvedValueOnce({ keys: [{ name: 'audit:u:latest' }], list_complete: true });
    const get = vi.fn().mockResolvedValue('{"tool":"provision_pas_app"}');
    const env = { OAUTH_KV: { list, get } as unknown as KVNamespace };

    expect(await listAuditEvents({ env, subject: 'u' }, 1)).toEqual([{ tool: 'provision_pas_app' }]);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }));
  });
});
