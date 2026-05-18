interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  meta: { changes: number; duration: number };
}

export interface ExecuteResult {
  meta: { changes: number; duration: number; last_row_id: number };
}

export interface Migration {
  /** Unique name, e.g. "0001_init" or "0002_add_photos". Run in array order. */
  name: string;
  /** SQL statements separated by semicolons. */
  sql: string;
}

export interface MigrateResult {
  /** Migrations that were applied this call. */
  applied: string[];
  /** Migrations that were already applied previously. */
  already: string[];
}

export class Database {
  constructor(
    private readonly appId: string,
    private readonly dataApiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Run a SELECT or other query that returns rows. */
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.req<QueryResult<T>>('/query', { sql, params });
  }

  /** Run an INSERT, UPDATE, DELETE, or DDL statement. */
  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    return this.req<ExecuteResult>('/execute', { sql, params });
  }

  /** Run multiple statements in a single D1 batch (transactional). */
  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<{ rows: unknown[]; meta: { changes: number; last_row_id: number } }[]> {
    const result = await this.req<{ results: { rows: unknown[]; meta: { changes: number; last_row_id: number } }[] }>('/batch', { statements });
    return result.results;
  }

  /**
   * Run named migrations. Each migration runs once — the data-worker tracks
   * which have been applied in a `_migrations` table. Idempotent: safe to
   * call on every app load.
   *
   * @example
   * await app.db.migrate([
   *   { name: '0001_init', sql: 'CREATE TABLE events (id TEXT PRIMARY KEY, ...)' },
   *   { name: '0002_photos', sql: 'ALTER TABLE events ADD COLUMN photo_url TEXT' },
   * ])
   */
  async migrate(migrations: Migration[]): Promise<MigrateResult> {
    return this.req<MigrateResult>('/migrate', { migrations });
  }

  /** List all user-created tables in the database. */
  async tables(): Promise<string[]> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const response = await fetch(`${this.dataApiBase}/tables`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) throw new Error(`db.tables failed: ${response.status}`);
    return (await response.json()) as string[];
  }

  private async req<T>(path: string, body: unknown): Promise<T> {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const response = await fetch(`${this.dataApiBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`db${path} failed: ${response.status} ${text}`);
    }
    return (await response.json()) as T;
  }
}
