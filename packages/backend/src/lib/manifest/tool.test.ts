import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { agentReachableRiskyWrite, measureManifestCost, openUnscopedWrite, validateManifest } from './tool.js';

const query = (over: Record<string, unknown> = {}): ToolManifest => ({
  name: 'list_items',
  description: 'List items',
  operation: 'query',
  sql: 'SELECT * FROM items WHERE user_id = :__user_id',
  requires_auth: true,
  ...over,
}) as ToolManifest;

describe('validateManifest', () => {
  it('accepts a scoped query', () => {
    expect(validateManifest(query())).toBeNull();
  });

  it('requires a lowercase name, a description and an explicit requires_auth', () => {
    expect(validateManifest(query({ name: 'ListItems' }))).toBe('name must be lowercase alphanumeric with underscores');
    expect(validateManifest(query({ description: '' }))).toBe('description is required');
    expect(validateManifest(query({ requires_auth: undefined }))).toBe('requires_auth must be explicitly true or false');
  });

  it('reserves the api_ prefix for console endpoints', () => {
    expect(validateManifest(query({ name: 'api_items' }))).toMatch(/reserved for console-defined endpoints/);
    expect(validateManifest(query({ name: 'api_items' }), { source: 'console' })).toBeNull();
  });

  it('refuses SQL parameters that params does not declare', () => {
    expect(validateManifest(query({ sql: 'SELECT * FROM items WHERE id = :id' }))).toBe('SQL references :id but it is not declared in params');
  });

  it('accepts :__user_is_child as a server-owned param, and refuses it in a public query (#513)', () => {
    expect(validateManifest(query({ sql: 'SELECT * FROM items WHERE user_id = :__user_id AND :__user_is_child = 0' }))).toBeNull();
    const err = validateManifest(query({ requires_auth: false, sql: 'SELECT * FROM items WHERE :__user_is_child = 0 LIMIT 10' }));
    expect(err).toMatch(/:__user_is_child/);
  });

  it('holds public queries to a literal LIMIT and no :__user_id', () => {
    expect(validateManifest(query({ requires_auth: false, sql: 'SELECT * FROM items' }))).toBe('public query tools must include a literal LIMIT of 500 or less');
    expect(validateManifest(query({ requires_auth: false, sql: 'SELECT * FROM items LIMIT 501' }))).toBe('public query tools must use LIMIT 500 or less');
    expect(validateManifest(query({ requires_auth: false, sql: 'SELECT * FROM items LIMIT 10' }))).toBeNull();
  });

  it('keeps batch tools on statements and caps them at 25', () => {
    expect(validateManifest(query({ operation: 'batch', sql: 'SELECT 1' }))).toBe('batch tools use statements, not sql');
    expect(validateManifest(query({ operation: 'batch', sql: undefined, statements: [] }))).toBe('batch tools require a non-empty statements array');
  });

  it('requires a scheduled tool to be an authenticated execute with an unscoped reason', () => {
    const scheduled = {
      operation: 'execute',
      sql: 'DELETE FROM items WHERE created_at < :__now',
      schedule: { cron: '*/5 * * * *', params: {} },
    };
    expect(validateManifest(query(scheduled))).toBe('scheduled tools must declare a non-empty auth.caller_unscoped.reason');
    expect(validateManifest(query({ ...scheduled, auth: { caller_unscoped: { reason: 'reaper' } } }))).toBeNull();
    expect(validateManifest(query({ ...scheduled, auth: { caller_unscoped: { reason: 'reaper' } }, schedule: { cron: '*/7 * * * *', params: {} } })))
      .toMatch(/^schedule\.cron minutes must be multiples of 5/);
  });
});

describe('openUnscopedWrite', () => {
  const write = query({ operation: 'execute', sql: 'DELETE FROM items WHERE id = 1', auth: { caller_unscoped: { reason: 'r' } } });

  it('flags an unscoped write any signed-in user can run', () => {
    expect(openUnscopedWrite(write)).toBe(true);
  });

  it('does not flag a role-gated, worker-only or scoped write', () => {
    expect(openUnscopedWrite({ ...write, auth: { caller_unscoped: { reason: 'r' }, app_roles: ['admin'] } })).toBe(false);
    expect(openUnscopedWrite({ ...write, callers: ['worker'] })).toBe(false);
    expect(openUnscopedWrite(query({ operation: 'execute' }))).toBe(false);
  });
});

describe('measureManifestCost', () => {
  it('counts only the model-facing fields', () => {
    const lean = measureManifestCost([query()]);
    const heavy = measureManifestCost([query({ sql: `SELECT ${'x'.repeat(1000)} FROM items WHERE user_id = :__user_id` })]);
    expect(heavy.bytes).toBe(lean.bytes);
    expect(lean.estimatedTokens).toBe(Math.round(lean.bytes / 4));
  });
});

describe('owner_ui_only (#500)', () => {
  it('accepts true and false on an authenticated action, and nothing else', () => {
    expect(validateManifest(query({ owner_ui_only: true }))).toBeNull();
    expect(validateManifest(query({ owner_ui_only: false }))).toBeNull();
    expect(validateManifest(query({ owner_ui_only: 'yes' }))).toBe('owner_ui_only must be true or false');
    expect(validateManifest(query({ owner_ui_only: 1 }))).toBe('owner_ui_only must be true or false');
  });

  it('refuses it on a public action, which has no session to tell an assistant from the owner', () => {
    expect(validateManifest(query({ requires_auth: false, owner_ui_only: true, sql: 'SELECT * FROM items LIMIT 10' }))).toMatch(/cannot be owner_ui_only/);
    expect(validateManifest(query({ requires_auth: false, owner_ui_only: false, sql: 'SELECT * FROM items LIMIT 10' }))).toBeNull();
  });
});

describe('agentReachableRiskyWrite (#500)', () => {
  const write = (name: string, over: Record<string, unknown> = {}) => query({ name, operation: 'execute', sql: 'DELETE FROM items WHERE id = :id', ...over });

  it('flags a write named like a post, delete or lock that an assistant can run', () => {
    for (const name of ['post_transaction', 'delete_receipt', 'bulk_approve_import_batch', 'lock_year', 'lodge_return', 'finalise_year']) {
      expect(agentReachableRiskyWrite(write(name)), name).toBe(true);
    }
  });

  it('does not flag a read, an owner-UI-only action, a worker-only one, or an ordinary write', () => {
    expect(agentReachableRiskyWrite(query({ name: 'delete_preview' }))).toBe(false); // a query
    expect(agentReachableRiskyWrite(write('delete_receipt', { owner_ui_only: true }))).toBe(false);
    expect(agentReachableRiskyWrite(write('delete_receipt', { callers: ['worker'] }))).toBe(false);
    expect(agentReachableRiskyWrite(write('add_note'))).toBe(false);
    expect(agentReachableRiskyWrite(write('remove_member'))).toBe(false); // soft, reversible verbs are not flagged
    expect(agentReachableRiskyWrite(write('archive_record'))).toBe(false);
    expect(agentReachableRiskyWrite(write('undeleted_items'))).toBe(false); // the verb is a whole word
  });
});
