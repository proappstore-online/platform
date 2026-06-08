import type { Database, ExecuteResult } from './db.js';

/**
 * TenantScope — safe-by-default helpers for multi-tenant tables.
 *
 * Every multi-tenant table in your app must have a `tenant_id` column.
 * The helpers here auto-inject `tenant_id` on inserts and auto-scope
 * reads/writes by `tenant_id` — so you can't accidentally leak a row
 * across tenants by forgetting a `WHERE` clause.
 *
 * Where this lives architecturally: a thin wrapper around `app.db`.
 * It does NOT replace `db.query` / `db.execute` — those are still raw.
 * Use the scope helpers for normal CRUD; drop down to `db.query` when
 * you need joins, aggregates, or anything beyond single-table operations.
 *
 * @example
 *   const tx = app.db.tenant('studio-123');
 *
 *   await tx.insert('clients', { id: 'c-1', name: 'Alice' });
 *   const alice = await tx.find('clients', { id: 'c-1' });
 *   await tx.update('clients', { id: 'c-1' }, { name: 'Alicia' });
 *   await tx.delete('clients', { id: 'c-1' });
 *
 *   // Raw escape hatch — tenant_id available as tx.tenantId; bind it yourself.
 *   const rows = await tx.db.query(
 *     'SELECT * FROM clients WHERE name LIKE ? AND tenant_id = ?',
 *     ['A%', tx.tenantId],
 *   );
 */
export class TenantScope {
  constructor(
    /** The Database instance this scope wraps. Exposed for raw escape-hatch queries. */
    readonly db: Database,
    /** The tenant_id all scope operations bind to. */
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error('TenantScope requires a non-empty tenantId.');
  }

  /** Find a single row matching the filter (tenant_id automatically appended). Returns null when nothing matches. */
  async find<T = Record<string, unknown>>(
    table: string,
    filter: Record<string, unknown> = {},
  ): Promise<T | null> {
    assertIdent(table);
    const { whereSql, params } = whereClause(filter, this.tenantId);
    const sql = `SELECT * FROM ${table} ${whereSql} LIMIT 1`;
    const result = await this.db.query<T>(sql, params);
    return result.rows[0] ?? null;
  }

  /** Find all rows matching the filter (tenant_id automatically appended). */
  async findMany<T = Record<string, unknown>>(
    table: string,
    filter: Record<string, unknown> = {},
  ): Promise<T[]> {
    assertIdent(table);
    const { whereSql, params } = whereClause(filter, this.tenantId);
    const sql = `SELECT * FROM ${table} ${whereSql}`;
    const result = await this.db.query<T>(sql, params);
    return result.rows;
  }

  /** Insert a row. `tenant_id` is set automatically — don't include it in `values`. */
  async insert(table: string, values: Record<string, unknown>): Promise<ExecuteResult> {
    assertIdent(table);
    if ('tenant_id' in values) {
      throw new Error('Do not pass tenant_id to TenantScope.insert — it is set automatically.');
    }
    const fullValues = { ...values, tenant_id: this.tenantId };
    const cols = Object.keys(fullValues);
    for (const c of cols) assertIdent(c);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
    return this.db.execute(sql, Object.values(fullValues));
  }

  /** Update rows matching `filter`. `tenant_id` is auto-appended to the WHERE. */
  async update(
    table: string,
    filter: Record<string, unknown>,
    values: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    assertIdent(table);
    if ('tenant_id' in values) {
      throw new Error('Do not pass tenant_id to TenantScope.update — it is preserved automatically.');
    }
    const setCols = Object.keys(values);
    if (setCols.length === 0) throw new Error('TenantScope.update requires at least one column to set.');
    for (const c of setCols) assertIdent(c);
    const setSql = setCols.map((c) => `${c} = ?`).join(', ');
    const { whereSql, params: whereParams } = whereClause(filter, this.tenantId);
    const sql = `UPDATE ${table} SET ${setSql} ${whereSql}`;
    return this.db.execute(sql, [...Object.values(values), ...whereParams]);
  }

  /** Delete rows matching `filter`. `tenant_id` is auto-appended. */
  async delete(table: string, filter: Record<string, unknown>): Promise<ExecuteResult> {
    assertIdent(table);
    const { whereSql, params } = whereClause(filter, this.tenantId);
    const sql = `DELETE FROM ${table} ${whereSql}`;
    return this.db.execute(sql, params);
  }

  /** Count rows matching `filter` (or all in the tenant). */
  async count(table: string, filter: Record<string, unknown> = {}): Promise<number> {
    assertIdent(table);
    const { whereSql, params } = whereClause(filter, this.tenantId);
    const sql = `SELECT COUNT(*) AS n FROM ${table} ${whereSql}`;
    const result = await this.db.query<{ n: number }>(sql, params);
    return Number(result.rows[0]?.n ?? 0);
  }
}

/** Build a WHERE clause from an equality filter plus the auto-injected tenant_id. */
function whereClause(
  filter: Record<string, unknown>,
  tenantId: string,
): { whereSql: string; params: unknown[] } {
  const keys = Object.keys(filter);
  for (const k of keys) assertIdent(k);
  const conds = keys.map((k) => `${k} = ?`);
  conds.push('tenant_id = ?');
  const params = [...keys.map((k) => filter[k]), tenantId];
  return { whereSql: `WHERE ${conds.join(' AND ')}`, params };
}

/**
 * Identifiers (table + column names) cannot be parameterized in SQL, so we
 * interpolate them directly. Reject anything that isn't a safe SQL identifier
 * to keep this from becoming an SQL-injection vector.
 *
 * Allowed: ASCII letter or underscore, followed by letters/digits/underscores.
 * Reject anything with quotes, spaces, semicolons, dashes, dots, etc.
 */
function assertIdent(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
}
