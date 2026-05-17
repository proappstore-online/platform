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
