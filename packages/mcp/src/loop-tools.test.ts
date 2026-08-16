import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * `update_ticket` (#137) — a backlog ticket could be filed and read over MCP but
 * never edited, so correcting one word meant filing a corrected ticket and
 * cancelling the first.
 *
 * The behaviour worth pinning is the PATCH BODY. The DO patches on
 * `!== undefined` (project-do.ts `updateTicket`), so a field that the caller
 * omitted must not appear in the body at all — send it as `undefined`, or worse
 * as `""`, and the edit silently overwrites the value it was supposed to leave
 * alone. That is invisible in the response, which returns the ticket either way.
 *
 * Same fake-McpServer strategy as `project-tools.test.ts`: capture the handlers
 * at registration and invoke them directly.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

const tools = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
    tools.set(name, handler);
  },
};

const agentsFetch = vi.fn();
const env = {
  AGENTS_BASE: 'https://agents.test',
  AGENTS: { fetch: agentsFetch } as unknown as Fetcher,
};

const { registerLoopTools } = await import('./loop-tools.js');
registerLoopTools(fakeServer as never, env as never, () => 'conn-token');

const update = () => tools.get('update_ticket')!;

/** The DO answers a PATCH with the ticket itself, not a `{ ticket }` envelope. */
const ticketResponse = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ id: 'a1b2', seq: 7, title: 'Fix the login copy', ...over }), { status: 200 });

/** The body the tool actually PUT on the wire. */
function sentBody(): Record<string, unknown> {
  const [, init] = agentsFetch.mock.calls.at(-1)!;
  return JSON.parse((init as RequestInit).body as string);
}

beforeEach(() => {
  agentsFetch.mockReset();
  agentsFetch.mockResolvedValue(ticketResponse());
});

describe('update_ticket (#137)', () => {
  it('is registered', () => {
    expect(tools.has('update_ticket')).toBe(true);
  });

  it('sends ONLY the field it was given, so the other is left alone', async () => {
    await update()({ slug: 'my-app', id: 'a1b2c3', title: 'Fix the login copy' });

    expect(sentBody()).toEqual({ title: 'Fix the login copy' });
    // Not merely absent-valued — absent. `rawIdea: undefined` would serialise
    // away here but reads as a deliberate omission at the call site, and the
    // next person to touch this would not know which was intended.
    expect('rawIdea' in sentBody()).toBe(false);
  });

  it('sends only rawIdea when only rawIdea is given', async () => {
    await update()({ slug: 'my-app', id: 'a1b2c3', rawIdea: 'Rewrite the empty state.' });

    expect(sentBody()).toEqual({ rawIdea: 'Rewrite the empty state.' });
    expect('title' in sentBody()).toBe(false);
  });

  it('sends both when both are given', async () => {
    await update()({ slug: 'my-app', id: 'a1b2c3', title: 'T', rawIdea: 'R' });

    expect(sentBody()).toEqual({ title: 'T', rawIdea: 'R' });
  });

  it('treats an empty string as a real edit, not as absent', async () => {
    await update()({ slug: 'my-app', id: 'a1b2c3', rawIdea: '' });

    // The DO checks `!== undefined`, so "" clears the field. That has to survive
    // the tool rather than being helpfully dropped.
    expect(sentBody()).toEqual({ rawIdea: '' });
  });

  it('refuses an edit with no fields WITHOUT calling the API', async () => {
    const res = await update()({ slug: 'my-app', id: 'a1b2c3' });

    expect(agentsFetch).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toContain('Nothing to update');
  });

  it('PATCHes the ticket route for the right project', async () => {
    await update()({ slug: 'my-app', id: 'a1b2c3', title: 'T' });

    const [url, init] = agentsFetch.mock.calls.at(-1)!;
    expect(url).toBe('https://agents.test/v1/projects/my-app/tickets/a1b2c3');
    expect((init as RequestInit).method).toBe('PATCH');
  });

  it('reports the seq and title the API answered with', async () => {
    agentsFetch.mockResolvedValue(ticketResponse({ seq: 12, title: 'Renamed by the API' }));

    const res = await update()({ slug: 'my-app', id: 'a1b2c3', title: 'What I sent' });

    // The API's copy wins in the summary: it is what was actually stored.
    expect(res.content[0]!.text).toContain('#12');
    expect(res.content[0]!.text).toContain('Renamed by the API');
  });

  it('surfaces an unknown ticket as the error it is, not as success', async () => {
    agentsFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'ticket_not_found' }), { status: 404 }),
    );

    const res = await update()({ slug: 'my-app', id: 'deadbeef', title: 'T' });

    expect(res.content[0]!.text).toContain('404');
    expect(res.content[0]!.text).not.toMatch(/updated/i);
  });
});
