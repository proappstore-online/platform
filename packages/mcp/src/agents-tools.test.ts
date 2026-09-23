import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agent_ticket_detail` (#152) — the messages read used to swallow a failed
 * response as `messages = []` and print "Messages (0)", so an outage or an
 * authorization failure looked like an empty conversation. The project and
 * ticket reads in the same handler already surface their failures; this pins
 * the messages read to the same behaviour.
 *
 * Same fake-McpServer strategy as `loop-tools.test.ts`: capture the handlers at
 * registration and invoke them directly.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

const tools = new Map<string, Handler>();
const fakeServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
    tools.set(name, handler);
  },
};

const agentsFetch = vi.fn();
const { registerAgentsTools } = await import('./agents-tools.js');
registerAgentsTools(
  fakeServer as never,
  () => ({ userId: 'u1', token: 'tok-1' }),
  null,
  'https://agents.test',
  { fetch: agentsFetch } as unknown as Fetcher,
);

const detail = (args: Record<string, unknown> = { app_id: 'crm', ticket_seq: 7 }) =>
  tools.get('agent_ticket_detail')!(args).then((r) => r.content[0]!.text);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ticketsResponse = () => json({ tickets: [{ id: 'a1b2', seq: 7, title: 'Fix the login copy', status: 'in_progress', assigneeRole: 'dev', iterations: 2, costSpentUsd: 0.5, stuckReason: null }] });

beforeEach(() => {
  agentsFetch.mockReset();
});

describe('agent_ticket_detail — messages read (#152)', () => {
  it('surfaces a 5xx messages response as an error, not an empty conversation', async () => {
    agentsFetch.mockResolvedValueOnce(ticketsResponse());
    agentsFetch.mockResolvedValueOnce(json({ error: 'durable object unavailable' }, 503));

    const text = await detail();
    expect(text).toContain('Error: 503');
    expect(text).toContain('durable object unavailable');
    expect(text).not.toContain('Messages (0)');
  });

  it('surfaces a 4xx messages response with its status and detail', async () => {
    agentsFetch.mockResolvedValueOnce(ticketsResponse());
    agentsFetch.mockResolvedValueOnce(json({ error: 'forbidden' }, 403));

    const text = await detail();
    expect(text).toContain('Error: 403');
    expect(text).toContain('forbidden');
    expect(text).not.toContain('Messages (0)');
  });

  it('surfaces a non-JSON error body rather than dropping it', async () => {
    agentsFetch.mockResolvedValueOnce(ticketsResponse());
    agentsFetch.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    const text = await detail();
    expect(text).toContain('Error: 502');
    expect(text).toContain('Bad Gateway');
  });

  it('still renders an empty conversation for a successful empty response', async () => {
    agentsFetch.mockResolvedValueOnce(ticketsResponse());
    agentsFetch.mockResolvedValueOnce(json({ messages: [] }));

    const text = await detail();
    expect(text).toContain('**#7 Fix the login copy**');
    expect(text).toContain('Messages (0)');
    expect(text).not.toContain('Error:');
  });

  it('renders messages on a successful response', async () => {
    agentsFetch.mockResolvedValueOnce(ticketsResponse());
    agentsFetch.mockResolvedValueOnce(json({ messages: [{ id: 'm1', author: 'dev', body: 'Shipped it.', createdAt: 0 }] }));

    const text = await detail();
    expect(text).toContain('Messages (1)');
    expect(text).toContain('**dev**:\nShipped it.');
  });

  it('still reports a failed tickets read as an error', async () => {
    agentsFetch.mockResolvedValueOnce(json({ error: 'nope' }, 500));

    const text = await detail();
    expect(text).toBe('Error: 500');
    expect(agentsFetch).toHaveBeenCalledTimes(1);
  });
});
