import { describe, it, expect, vi } from 'vitest';
import { insertActivity, updateActivityMeta, readActivity, costSummary, costDetail, activityFromBroadcast } from './activity-log.ts';

// Minimal SqlStorage mock for testing the pure SQL functions.
function mockSql() {
  const activityLog: Record<string, unknown>[] = [];

  return {
    exec: vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.startsWith('INSERT INTO activity_log')) {
        activityLog.push({ id: params[0], ticket_id: params[1], type: params[2], detail: params[3], created_at: params[4], meta: params[5] });
      } else if (sql.startsWith('UPDATE activity_log')) {
        const row = activityLog.find(r => r.id === params[1]);
        if (row) row.meta = params[0];
      } else if (sql.startsWith('DELETE FROM activity_log')) {
        activityLog.length = 0;
      } else if (sql.includes('FROM activity_log')) {
        return { toArray: () => [...activityLog].reverse().slice(0, 500) };
      } else if (sql.includes('FROM project')) {
        return { toArray: () => [{ cost_cap_monthly_usd: 50, cost_spent_monthly_usd: 10, cost_month: new Date().toISOString().slice(0, 7) }] };
      } else if (sql.includes('SUM(cost_usd)') && sql.includes('GROUP BY role')) {
        return { toArray: () => [{ role: 'Dev', total: 5, tokens_in: 1000, tokens_out: 500 }] };
      } else if (sql.includes('SUM(cost_usd)') && sql.includes('GROUP BY ticket_id, role')) {
        return { toArray: () => [{ ticket_id: 't1', role: 'Dev', total: 5, tokens_in: 1000, tokens_out: 500 }] };
      } else if (sql.includes('GROUP BY ticket_id') && sql.includes('ORDER BY total')) {
        return { toArray: () => [{ ticket_id: 't1', total: 5 }] };
      } else if (sql.includes('LEFT JOIN tickets')) {
        return { toArray: () => [{ ticket_id: 't1', title: 'Test ticket', total: 5 }] };
      } else if (sql.includes('COALESCE(SUM')) {
        return { toArray: () => [{ total: 5 }] };
      } else if (sql.includes('FROM cost_ledger ORDER BY')) {
        return { toArray: () => [{ ticket_id: 't1', role: 'Dev', cost_usd: 5, tokens_in: 1000, tokens_out: 500, model: 'claude-sonnet', created_at: Date.now() }] };
      }
      return { toArray: () => [] };
    }),
  } as unknown as SqlStorage;
}

describe('insertActivity', () => {
  it('returns an id and timestamp and passes correct args to SQL', () => {
    const sql = mockSql();
    const result = insertActivity(sql, { type: 'test', detail: 'hello world', ticketId: 'tk1', meta: '{"x":1}' });
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeGreaterThan(0);
    // Verify the SQL was called with the right positional args
    const mock = sql.exec as unknown as ReturnType<typeof vi.fn>;
    const call = mock.mock.calls[0]!;
    expect(call[0]).toContain('INSERT INTO activity_log');
    expect(call[1]).toBe(result.id);       // id
    expect(call[2]).toBe('tk1');           // ticket_id
    expect(call[3]).toBe('test');          // type
    expect(call[4]).toBe('hello world');   // detail (capped at 1000)
    expect(call[6]).toBe('{"x":1}');       // meta
  });

  it('caps detail at 1000 chars and meta at 20000 chars', () => {
    const sql = mockSql();
    insertActivity(sql, { type: 'x', detail: 'a'.repeat(2000), meta: 'b'.repeat(30000) });
    const call = (sql.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((call[4] as string).length).toBe(1000);
    expect((call[6] as string).length).toBe(20000);
  });
});

describe('readActivity', () => {
  it('returns camelCased rows in oldest-first order', () => {
    const sql = mockSql();
    // Insert two entries
    insertActivity(sql, { type: 'a', detail: 'first', ticketId: 't1' });
    insertActivity(sql, { type: 'b', detail: 'second' });
    const rows = readActivity(sql);
    // Mock returns reversed (simulating DESC), readActivity reverses back → insertion order
    expect(rows.length).toBe(2);
    expect(rows[0]!.type).toBe('a');    // first inserted = oldest
    expect(rows[0]!.ticketId).toBe('t1');  // camelCase mapping
    expect(rows[0]!.createdAt).toBeGreaterThan(0);
    expect(rows[1]!.type).toBe('b');    // second inserted = newest
  });
});

describe('costSummary', () => {
  it('returns cap, spent, and breakdowns', () => {
    const result = costSummary(mockSql());
    expect(result.cap).toBe(50);
    expect(result.spent).toBe(10);
    expect(result.byRole).toHaveLength(1);
    expect(result.topTickets).toHaveLength(1);
  });

  it('returns spent=0 when cost_month is stale (previous month)', () => {
    const sql = {
      exec: vi.fn((q: string) => {
        if (q.includes('FROM project')) {
          return { toArray: () => [{ cost_cap_monthly_usd: 50, cost_spent_monthly_usd: 99, cost_month: '2020-01' }] };
        }
        return { toArray: () => [] };
      }),
    } as unknown as SqlStorage;
    const result = costSummary(sql);
    expect(result.spent).toBe(0); // stale month → 0, not 99
    expect(result.cap).toBe(50);
  });
});

describe('costDetail', () => {
  it('returns totalUsd, byRole, byTicket, and ledger', () => {
    const result = costDetail(mockSql());
    expect(result.totalUsd).toBe(5);
    expect(result.byRole).toHaveLength(1);
    expect(result.byRole[0]!.role).toBe('Dev');
    expect(result.byTicket).toHaveLength(1);
    expect(result.byTicket[0]!.title).toBe('Test ticket');
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]!.model).toBe('claude-sonnet');
  });
});

describe('activityFromBroadcast (#6)', () => {
  it('turns state-changing broadcasts into audit rows', () => {
    expect(activityFromBroadcast({ type: 'transition', ticketId: 't1', from: 'inbox', to: 'ba-refining', auto: true }))
      .toEqual({ type: 'transition', detail: 'inbox → ba-refining · auto', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'transition', ticketId: 't1', from: 'deploying', to: 'dev-active', trigger: 'system', reason: 'deploy-failed' }))
      .toEqual({ type: 'transition', detail: 'deploying → dev-active · deploy-failed', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'transition', ticketId: 't1', from: 'qa-active', to: 'deploying', trigger: 'QA' }))
      .toEqual({ type: 'transition', detail: 'qa-active → deploying · QA', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'transition', ticketId: 't1', to: 'needs-input', reason: 'agent-blocked', role: 'Dev' }))
      .toEqual({ type: 'transition', detail: '? → needs-input · agent-blocked', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'ticket-transition', ticketId: 't1', from: 'inbox', to: 'cancelled', trigger: 'po' }))
      .toEqual({ type: 'transition', detail: 'inbox → cancelled · po', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'agent-run-ended', ticketId: 't1', role: 'Dev' })).toEqual({ type: 'agent', detail: 'Dev finished', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'agent-run-ended', ticketId: 't1', role: 'Dev', error: 'boom' })).toEqual({ type: 'agent', detail: 'Dev failed: boom', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'ticket-created', ticket: { id: 't9', title: 'Login page' } })).toEqual({ type: 'ticket', detail: 'Created: Login page', ticketId: 't9' });
    expect(activityFromBroadcast({ type: 'ticket-updated', ticketId: 't1' })).toEqual({ type: 'ticket', detail: 'Updated', ticketId: 't1' });
    expect(activityFromBroadcast({ type: 'ticket-failed', ticketId: 't1', reason: 'iteration_cap' })).toEqual({ type: 'ticket', detail: 'Failed: iteration_cap', ticketId: 't1' });
  });

  it('ignores UI signals, chat, and events whose site logs a richer row itself — and the activity events it produces', () => {
    for (const e of [
      { type: 'activity', entry: {} }, { type: 'activity-meta' }, { type: 'activity-cleared' },
      { type: 'agent-text', role: 'Dev', ticketId: 't1', text: 'x' }, { type: 'agent-heartbeat', role: 'Dev' },
      { type: 'agent-run-started', ticketId: 't1', role: 'Dev' }, { type: 'agent-run-ended', role: 'PO' },
      { type: 'agent-tool-call', ticketId: 't1', name: 'read_file' }, { type: 'agent-tool-result', ticketId: 't1', ok: true },
      { type: 'chat', role: 'po', body: 'hi' }, { type: 'chat-start' }, { type: 'chat-done' }, { type: 'chat-cleared' },
      { type: 'files-synced', count: 3 }, { type: 'play-state', status: 'running' }, { type: 'memory-updated' },
      { type: 'ticket-deleted', ticketId: 't1' }, { type: 'cost-cap-reached' }, { type: 'project-created' }, { type: 'message' },
      { type: 'transition', ticketId: 't1' }, { type: 'ticket-created', ticket: {} }, { type: 'ticket-updated' },
    ]) expect(activityFromBroadcast(e), JSON.stringify(e)).toBeNull();
  });
});
