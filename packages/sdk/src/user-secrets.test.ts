import { describe, expect, it, vi } from 'vitest';
import { UserSecrets } from './user-secrets.js';

function setup(response: Response) {
  const auth = { handleUnauthorized: vi.fn(), authenticatedFetch: vi.fn(async () => response) };
  return { auth, secrets: new UserSecrets('my app', 'https://api.example', auth) };
}

describe('UserSecrets (#587)', () => {
  it('set PUTs the value to the app-scoped name', async () => {
    const { auth, secrets } = setup(new Response(null, { status: 204 }));
    await secrets.set('OPENAI_KEY', 'sk-1');
    expect(auth.authenticatedFetch).toHaveBeenCalledWith('https://api.example/v1/apps/my%20app/user-secrets/OPENAI_KEY', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'sk-1' }),
    });
  });

  it('delete and list', async () => {
    const del = setup(new Response(null, { status: 204 }));
    await del.secrets.delete('OPENAI_KEY');
    expect(del.auth.authenticatedFetch).toHaveBeenCalledWith('https://api.example/v1/apps/my%20app/user-secrets/OPENAI_KEY', { method: 'DELETE' });
    const rows = [{ name: 'OPENAI_KEY', updatedAt: 1, lastUsedAt: null }];
    const list = setup(Response.json({ secrets: rows }));
    expect(await list.secrets.list()).toEqual(rows);
    expect(list.auth.authenticatedFetch).toHaveBeenCalledWith('https://api.example/v1/apps/my%20app/user-secrets', undefined);
  });

  it('signs out on 401 and throws with the status otherwise', async () => {
    const unauth = setup(new Response(null, { status: 401 }));
    await expect(unauth.secrets.list()).rejects.toThrow('Not signed in.');
    expect(unauth.auth.handleUnauthorized).toHaveBeenCalled();
    const refused = setup(Response.json({ error: 'not declared' }, { status: 400 }));
    await expect(refused.secrets.set('X', 'v')).rejects.toThrow(/400/);
  });
});
