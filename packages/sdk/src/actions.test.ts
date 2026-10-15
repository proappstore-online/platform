import { afterEach, describe, expect, it, vi } from 'vitest';
import { Actions, ActionError } from './actions.js';

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
      expect.objectContaining({ operation: 'action.list_orgs', traceId: expect.stringMatching(/^[0-9a-f]{32}$/), spanId: expect.stringMatching(/^[0-9a-f]{16}$/) }),
    );
  });

  it('signs out on action 401', async () => {
    const a = auth(new Response('nope', { status: 401 }));
    const actions = new Actions('interns', 'https://api.proappstore.online', a);

    await expect(actions.call('list_orgs')).rejects.toThrow('Not signed in');
    expect(a.handleUnauthorized).toHaveBeenCalledOnce();
  });

  // #106 client half: a failed action leaves a record via the logger Actions was
  // constructed with. The logger surface is `capture` (Logs), not `log` — an
  // optional param means a mismatch here fails silently rather than at compile time.
  it('reports failed actions to the logger without leaking params', async () => {
    const logger = { capture: vi.fn() };
    const a = auth(new Response('boom', { status: 500 }));
    const actions = new Actions('interns', 'https://api.proappstore.online', a, logger);

    await expect(actions.call('list_orgs', { secret: 'hunter2' })).rejects.toThrow('failed');
    expect(logger.capture).toHaveBeenCalledWith(
      'error',
      'action',
      'action list_orgs failed',
      { action: 'list_orgs', status: 500 },
      expect.objectContaining({ operation: 'action.list_orgs', result: 'error' }),
    );
    expect(JSON.stringify(logger.capture.mock.calls)).not.toContain('hunter2');
  });

  it('reports an unauthorized action to the logger', async () => {
    const logger = { capture: vi.fn() };
    const a = auth(new Response('nope', { status: 401 }));
    const actions = new Actions('interns', 'https://api.proappstore.online', a, logger);

    await expect(actions.call('list_orgs')).rejects.toThrow('Not signed in');
    expect(logger.capture).toHaveBeenCalledWith(
      'error',
      'action',
      'action list_orgs unauthorized',
      { action: 'list_orgs', status: 401 },
      expect.objectContaining({ operation: 'action.list_orgs', result: 'error', errorCode: 'unauthorized' }),
    );
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

  // #299: a refusal is a typed ActionError; the message is unchanged.
  it('a refusal rejects with an ActionError carrying the server code and body', async () => {
    const a = auth(Response.json({ error: 'requires app role' }, { status: 403 }));
    const err = await new Actions('interns', 'https://api.proappstore.online', a).call('admin_x').catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.message).toBe('actions.admin_x failed: 403 {"error":"requires app role"}');
    expect(err).toMatchObject({ action: 'admin_x', status: 403, code: 'requires app role', forbidden: true });
    const plain = await new Actions('interns', 'https://api.proappstore.online', auth(new Response('boom', { status: 500 }))).call('x').catch((e) => e);
    expect(plain).toMatchObject({ status: 500, code: null, body: null, forbidden: false });
  });

  // #344: `forbidden` means a missing role, not every 403.
  it('forbidden is true only for role refusals, not for other 403s', () => {
    const err = (status: number, body: unknown) => new ActionError('x', status, JSON.stringify(body));
    expect(err(403, { error: 'requires app role' }).forbidden).toBe(true);
    expect(err(403, { error: 'requires platform role' }).forbidden).toBe(true);
    for (const code of ['this app is private', 'action x runs only from the app worker', 'token is read-only', 'step_up_required']) {
      expect(err(403, { error: code }).forbidden, code).toBe(false);
    }
    expect(err(401, { error: 'requires app role' }).forbidden).toBe(false);
  });

  // #390: every call has its own trace; failures carry it to the log and the error.
  it('a failed call carries its trace id and duration on the ActionError and the log entry, with the server error code', async () => {
    const logger = { capture: vi.fn() };
    const a = auth(Response.json({ error: 'action not found', errorCode: 'not_found', traceId: 'ignored' }, { status: 404 }));
    const err = await new Actions('interns', 'https://api.proappstore.online', a, logger).call('save_lead', { email: 'x@y.z' }).catch((e) => e);
    const sent = a.authenticatedFetch.mock.calls[0]![2] as { traceId: string; spanId: string };
    expect(err).toBeInstanceOf(ActionError);
    expect(err.traceId).toBe(sent.traceId);
    expect(err.durationMs).toEqual(expect.any(Number));
    const context = logger.capture.mock.calls[0]![4];
    expect(context).toEqual({ traceId: sent.traceId, spanId: sent.spanId, operation: 'action.save_lead', result: 'error', durationMs: err.durationMs, errorCode: 'not_found' });
    expect(JSON.stringify(logger.capture.mock.calls)).not.toContain('x@y.z');
  });

  it('concurrent calls get distinct traces and spans', async () => {
    const a = auth(Response.json({}));
    a.authenticatedFetch.mockImplementation(async () => Response.json({}));
    const actions = new Actions('interns', 'https://api.proappstore.online', a);
    await Promise.all([actions.call('a'), actions.call('b'), actions.call('c')]);
    const ctxs = a.authenticatedFetch.mock.calls.map((c) => c[2] as { traceId: string; spanId: string; operation: string });
    expect(ctxs.map((c) => c.operation)).toEqual(['action.a', 'action.b', 'action.c']);
    expect(new Set(ctxs.map((c) => c.traceId)).size).toBe(3);
    expect(new Set(ctxs.map((c) => c.spanId)).size).toBe(3);
  });

  it('a signed-out public call sends a traceparent, and its failure is logged with that trace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'not signed in', errorCode: 'unauthorized' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = { capture: vi.fn() };
    const err = await new Actions('interns', 'https://api.proappstore.online', auth(Response.json({})), logger).callPublic('lookup').catch((e) => e);
    const header = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers.traceparent!;
    const [, traceId, spanId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(header)!;
    expect(err).toMatchObject({ status: 401, traceId });
    expect(logger.capture.mock.calls[0]![4]).toMatchObject({ traceId, spanId, errorCode: 'unauthorized' });
  });
});
