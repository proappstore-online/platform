import { describe, it, expect, vi } from 'vitest';
import { insertActivity, updateActivityMeta, readActivity, costSummary, costDetail } from './activity-log.ts';

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
  it('returns an id and timestamp', () => {
    const sql = mockSql();
    const result = insertActivity(sql, { type: 'test', detail: 'hello' });
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeGreaterThan(0);
    expect(sql.exec).toHaveBeenCalled();
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
