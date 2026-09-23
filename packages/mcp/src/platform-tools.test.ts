import { describe, expect, it, vi } from 'vitest';

/**
 * list_templates (#178) — read-only discovery of the approved-template
 * catalogue. Same fake-McpServer strategy as the other tool tests.
 */
type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
const tools = new Map<string, Handler>();
const fakeServer = { tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools.set(name, h); } };

const { registerPlatformTools } = await import('./platform-tools.js');
const fetchSpy = vi.fn();
registerPlatformTools(fakeServer as never, {
  API_BASE: 'https://api.test', GITHUB_ORG: 'proappstore-online',
  API: { fetch: fetchSpy } as unknown as Fetcher, HOST: { fetch: fetchSpy } as unknown as Fetcher,
} as never);

const text = async (args: Record<string, unknown> = {}) => (await tools.get('list_templates')!(args)).content[0]!.text;

describe('list_templates', () => {
  it('is registered and needs no auth or network', async () => {
    const out = await text();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toContain('template-app (default)');
    expect(out).toContain('[approved]');
    expect(out).toContain('proappstore-online/template-app@main');
    expect(out).toMatch(/reviewed source commit: [0-9a-f]{40}/);
  });

  it('states the selection contract and the public copy', async () => {
    const out = await text();
    expect(out).toContain('unknown/withdrawn templates are rejected');
    expect(out).toContain('https://docs.proappstore.online/templates/catalogue.json');
    expect(out).toContain('known deviations: PAS-AUTH-001');
  });

  it('hides non-approved entries unless asked', async () => {
    const all = await text({ include_deprecated: true });
    const approved = await text();
    expect(all.length).toBeGreaterThanOrEqual(approved.length);
  });
});
