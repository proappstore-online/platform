import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import { measureManifestCost, openUnscopedWrite, validateManifest } from './tool.js';

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
