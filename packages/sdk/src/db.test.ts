import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Database } from './db.js';

interface AuthLike {
  token: string | null;
  handleUnauthorized: () => void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

function fakeAuth(token: string | null): AuthLike {
  const auth: AuthLike = {
    token,
    handleUnauthorized: vi.fn(),
    async authenticatedFetch(input: string | URL, init: RequestInit = {}) {
      if (!auth.token) throw new Error('Not signed in.');
      const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${auth.token}` };
      return fetch(input, { ...init, headers });
    },
  };
  return auth;
}

describe('Database', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('query', () => {
    it('sends POST /query with sql and params, returns rows', async () => {
      const auth = fakeAuth('tok_abc');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      const payload = { rows: [{ id: 1, name: 'Alice' }], meta: { changes: 0, duration: 5 } };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));

      const result = await db.query('SELECT * FROM users WHERE id = ?', [1]);

      expect(mockFetch).toHaveBeenCalledWith('https://data-myapp.proappstore.online/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT * FROM users WHERE id = ?', params: [1] }),
      });
      expect(result).toEqual(payload);
    });

    it('sends POST /query without params when omitted', async () => {
      const auth = fakeAuth('tok_abc');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ rows: [], meta: { changes: 0, duration: 1 } }), { status: 200 }));

      await db.query('SELECT 1');

      expect(mockFetch).toHaveBeenCalledWith('https://data-myapp.proappstore.online/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'SELECT 1', params: undefined }),
      });
    });
  });

  describe('execute', () => {
    it('sends POST /execute with sql and params', async () => {
      const auth = fakeAuth('tok_xyz');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      const payload = { meta: { changes: 1, duration: 3, last_row_id: 42 } };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));

      const result = await db.execute('INSERT INTO users (name) VALUES (?)', ['Bob']);

      expect(mockFetch).toHaveBeenCalledWith('https://data-myapp.proappstore.online/execute', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_xyz', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'INSERT INTO users (name) VALUES (?)', params: ['Bob'] }),
      });
      expect(result).toEqual(payload);
    });
  });

  describe('batch', () => {
    it('sends POST /batch with statements array', async () => {
      const auth = fakeAuth('tok_batch');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      const serverResponse = {
        results: [
          { rows: [], meta: { changes: 1, last_row_id: 1 } },
          { rows: [], meta: { changes: 1, last_row_id: 2 } },
        ],
      };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(serverResponse), { status: 200 }));

      const statements = [
        { sql: 'INSERT INTO t (x) VALUES (?)', params: [1] },
        { sql: 'INSERT INTO t (x) VALUES (?)', params: [2] },
      ];
      const result = await db.batch(statements);

      expect(mockFetch).toHaveBeenCalledWith('https://data-myapp.proappstore.online/batch', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok_batch', 'Content-Type': 'application/json' },
        body: JSON.stringify({ statements }),
      });
      expect(result).toEqual(serverResponse.results);
    });
  });

  describe('tables', () => {
    it('sends GET /tables and returns table names', async () => {
      const auth = fakeAuth('tok_tables');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(['users', 'posts']), { status: 200 }));

      const result = await db.tables();

      expect(mockFetch).toHaveBeenCalledWith('https://data-myapp.proappstore.online/tables', {
        headers: { Authorization: 'Bearer tok_tables' },
      });
      expect(result).toEqual(['users', 'posts']);
    });
  });

  describe('auth errors', () => {
    it('throws "Not signed in" when no token (query)', async () => {
      const auth = fakeAuth(null);
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);

      await expect(db.query('SELECT 1')).rejects.toThrow('Not signed in.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws "Not signed in" when no token (execute)', async () => {
      const auth = fakeAuth(null);
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);

      await expect(db.execute('DELETE FROM t')).rejects.toThrow('Not signed in.');
    });

    it('throws "Not signed in" when no token (batch)', async () => {
      const auth = fakeAuth(null);
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);

      await expect(db.batch([{ sql: 'SELECT 1' }])).rejects.toThrow('Not signed in.');
    });

    it('throws "Not signed in" when no token (tables)', async () => {
      const auth = fakeAuth(null);
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);

      await expect(db.tables()).rejects.toThrow('Not signed in.');
    });

    it('calls handleUnauthorized on 401 from query', async () => {
      const auth = fakeAuth('tok_expired');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

      await expect(db.query('SELECT 1')).rejects.toThrow('Not signed in.');
      expect(auth.handleUnauthorized).toHaveBeenCalled();
    });

    it('calls handleUnauthorized on 401 from tables', async () => {
      const auth = fakeAuth('tok_expired');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

      await expect(db.tables()).rejects.toThrow('Not signed in.');
      expect(auth.handleUnauthorized).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response from query', async () => {
      const auth = fakeAuth('tok_abc');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('bad sql', { status: 400 }));

      await expect(db.query('INVALID SQL')).rejects.toThrow('db/query failed: 400 bad sql');
    });

    it('throws on non-ok response from tables', async () => {
      const auth = fakeAuth('tok_abc');
      const db = new Database('myapp', 'https://data-myapp.proappstore.online', auth);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await expect(db.tables()).rejects.toThrow('db.tables failed: 500');
    });
  });
});
