import { afterEach, describe, expect, it, vi } from 'vitest';
import { Actions } from './actions.js';

function auth(response: Response) {
  return {
    handleUnauthorized: vi.fn(),
    authenticatedFetch: vi.fn().mockResolvedValue(response),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Actions', () => {
  it('calls the app action endpoint with params', async () => {
    const a = auth(Response.json({ rows: [{ id: '1' }] }));
    const actions = new Actions('interns', 'https://api.proappstore.online', a);

    const result = await actions.call<{ rows: { id: string }[] }>('list_orgs', { limit: 5 });

    expect(result.rows[0]!.id).toBe('1');
    expect(a.authenticatedFetch).toHaveBeenCalledWith(
      'https://api.proappstore.online/v1/apps/interns/actions/list_orgs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ params: { limit: 5 } }),
      }),
    );
  });

  it('signs out on action 401', async () => {
    const a = auth(new Response('nope', { status: 401 }));
    const actions = new Actions('interns', 'https://api.proappstore.online', a);

    await expect(actions.call('list_orgs')).rejects.toThrow('Not signed in');
    expect(a.handleUnauthorized).toHaveBeenCalledOnce();
  });

  it('calls a public action without using authenticated fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [{ id: 'org-1' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const a = auth(Response.json({}));
    const actions = new Actions('interns', 'https://api.proappstore.online', a);

    const result = await actions.callPublic<{ rows: { id: string }[] }>('get_org_by_slug', { slug: 'chessideas' });

    expect(result.rows[0]!.id).toBe('org-1');
    expect(a.authenticatedFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.proappstore.online/v1/apps/interns/actions/get_org_by_slug',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ params: { slug: 'chessideas' } }),
      }),
    );
  });
});
