import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/**
 * #237: an AI with only MCP access learns to wrap the app in ProShell with
 * real nav items, where navigation comes from, and which UI components exist.
 */
describe('sdk_reference — the app frame and the components (#237)', () => {
  const ref = async (args: Record<string, unknown> = {}) => (await tools.get('sdk_reference')!(args)).content[0]!.text;

  it('leads the default (all) output with the shell, then the components, before any data API', async () => {
    const all = await ref();
    expect(all).toBe(await ref({ feature: 'all' }));
    const shell = all.indexOf('## Start here: ProShell is the app frame');
    const components = all.indexOf('## UI components — what exists');
    expect(shell).toBeGreaterThan(-1);
    expect(components).toBeGreaterThan(shell);
    expect(all.indexOf('## Auth')).toBeGreaterThan(components);
  });

  it("'shell' is a complete minimal app whose first step is <ProShell app={app} nav={…}>", async () => {
    const shell = await ref({ feature: 'shell' });
    expect(shell).toContain("import { initPro, ProShell, PageHeader, useDocumentTitle, Button, EmptyState, useToast } from '@proappstore/sdk'");
    expect(shell).toContain('<ProShell app={app} appName="My App" nav={NAV}>');
    expect(shell).toMatch(/const NAV = \[\n  \{ label: 'Home', href: '\/'/);
    expect(shell).toContain('<PageHeader title="Cases"');
    // the app frame comes before any screen code
    expect(shell.indexOf('<ProShell app={app}')).toBeLessThan(shell.indexOf('function Home()'));
  });

  it("'shell' answers 'how do I add navigation?', including routers and custom chrome", async () => {
    const shell = await ref({ feature: 'shell' });
    expect(shell).toContain('### How do I add navigation?');
    expect(shell).toContain('Pass the screens as `nav`');
    expect(shell).toContain('<nav aria-label="Main">');
    expect(shell).toContain('onNavigate={navigate}');
    expect(shell).toContain('renderNav=');
    expect(shell).toContain('renderTopbar=');
    expect(shell).toContain('Never: navigation inside a page, or a second navbar under the shell.');
    for (const builtIn of ['Error boundary', 'Suspense', 'useToast', 'useOnline()', 'skip link']) expect(shell).toContain(builtIn);
  });

  it("'components' lists every component and hook @proappstore/sdk/ui exports", async () => {
    const components = await ref({ feature: 'components' });
    const ui = readFileSync(resolve(__dirname, '../../sdk/src/ui.tsx'), 'utf8');
    const exported = [...ui.matchAll(/^export \{([^}]+)\} from/gm)].flatMap((m) => m[1]!.split(',').map((n) => n.trim()).filter(Boolean));
    expect(exported.length).toBeGreaterThan(20);
    for (const name of exported) expect(components, `components must list ${name}`).toContain(`\`${name}`);
  });

  it('the ui section imports the full component set and points to shell and components', async () => {
    const ui = await ref({ feature: 'ui' });
    for (const name of ['NavBar', 'PageHeader', 'useDocumentTitle', 'useToast', 'Button', 'Card', 'Input', 'Modal', 'Spinner', 'EmptyState', 'Tabs']) expect(ui).toContain(name);
    expect(ui).toContain("sdk_reference({ feature: 'shell' })");
  });
});

describe('platform_guide — current build guidance appended (#237)', () => {
  it('appends ProShell-with-nav build instructions that supersede older guidance in skills.md', async () => {
    const guide = vi.fn(async () => new Response('# skills.md\nUse the default ProShell for simple apps.', { status: 200 }));
    vi.stubGlobal('fetch', guide);
    try {
      const out = (await tools.get('platform_guide')!({})).content[0]!.text;
      expect(guide).toHaveBeenCalledWith('https://proappstore.online/skills.md');
      const appended = out.slice(out.indexOf('supersedes any older ProShell'));
      expect(appended).toContain('## Next — build the app on ProShell');
      expect(appended).toMatch(/<ProShell app=\{app\}[^>]*\bnav=\{/);
      expect(appended).toContain('<nav aria-label="Main">');
      expect(appended).toContain("sdk_reference({ feature: 'components' })");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
