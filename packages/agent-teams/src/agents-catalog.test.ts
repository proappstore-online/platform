import { describe, expect, it } from 'vitest';
import { buildAgentCatalog } from './agents-catalog.ts';
import { DEFAULT_PERSONAS, PO_PERSONA } from './memory.ts';
import type { RoleConfig } from './types.ts';

const rc = (over: Partial<RoleConfig> & { role: RoleConfig['role'] }): RoleConfig => ({
  runtime: 'cf-native',
  model: 'claude-sonnet-4-6',
  spineTools: ['read_file'],
  vendorTools: [],
  ...over,
});

const defaults: RoleConfig[] = [
  rc({ role: 'Architect', spineTools: ['write_file', 'read_docs'] }),
  rc({ role: 'BA' }),
  rc({ role: 'Dev' }),
  rc({ role: 'QA' }),
];

describe('buildAgentCatalog', () => {
  it('lists all five agents (PO + four build roles)', () => {
    const cat = buildAgentCatalog(defaults);
    expect(cat.map((a) => a.id)).toEqual(['PO', 'Architect', 'BA', 'Dev', 'QA']);
  });

  it('resolves seeded defaults when nothing is overridden', () => {
    const cat = buildAgentCatalog(defaults);
    const dev = cat.find((a) => a.id === 'Dev')!;
    expect(dev.identity).toBe(DEFAULT_PERSONAS.Dev);
    expect(dev.identitySource).toBe('default');
    expect(dev.systemPromptSource).toBe('default');
    expect(dev.systemPrompt).toContain('Developer');
    expect(dev.surface).toBe('build');
    expect(dev.editable.via).toContain('PUT');
  });

  it('reflects a custom persona + systemPromptOverride', () => {
    const cat = buildAgentCatalog([
      ...defaults.filter((d) => d.role !== 'Dev'),
      rc({ role: 'Dev', persona: 'You are a 10x dev.', systemPromptOverride: 'Just ship it.' }),
    ]);
    const dev = cat.find((a) => a.id === 'Dev')!;
    expect(dev.identity).toBe('You are a 10x dev.');
    expect(dev.identitySource).toBe('custom');
    expect(dev.systemPrompt).toBe('Just ship it.');
    expect(dev.systemPromptSource).toBe('custom');
  });

  it('treats a persona equal to the seeded default as "default", not "custom"', () => {
    // role_configs seeds DEFAULT_PERSONAS into the persona column at creation, so
    // a non-null persona that equals the default must still read as "default".
    const cat = buildAgentCatalog([
      ...defaults.filter((d) => d.role !== 'Dev'),
      rc({ role: 'Dev', persona: DEFAULT_PERSONAS.Dev }),
    ]);
    expect(cat.find((a) => a.id === 'Dev')!.identitySource).toBe('default');
  });

  it('surfaces the granted tools per role', () => {
    const cat = buildAgentCatalog(defaults);
    expect(cat.find((a) => a.id === 'Architect')!.tools).toEqual(['write_file', 'read_docs']);
    // chat agents have their own fixed tool sets
    expect(cat.find((a) => a.id === 'PO')!.tools).toContain('create_ticket');
  });

  it('surfaces vendor-native tools (e.g. the Architect web research) alongside spine tools', () => {
    const cat = buildAgentCatalog([
      ...defaults.filter((d) => d.role !== 'Architect'),
      rc({ role: 'Architect', spineTools: ['write_file', 'read_docs'], vendorTools: ['web_search', 'web_fetch'] }),
    ]);
    const tools = cat.find((a) => a.id === 'Architect')!.tools;
    expect(tools).toContain('web_search');
    expect(tools).toContain('web_fetch');
    expect(tools).toContain('write_file');
  });

  it('PO defaults to PO_PERSONA and is templated; honors an override', () => {
    const cat = buildAgentCatalog(defaults);
    const po = cat.find((a) => a.id === 'PO')!;
    expect(po.identity).toBe(PO_PERSONA);
    expect(po.identitySource).toBe('default');
    expect(po.systemPromptSource).toBe('templated');
    expect(po.surface).toBe('chat');
    expect(po.thread).toBe('build');

    const custom = buildAgentCatalog(defaults, { poPersona: 'You are a ruthless PO.' });
    const po2 = custom.find((a) => a.id === 'PO')!;
    expect(po2.identity).toBe('You are a ruthless PO.');
    expect(po2.identitySource).toBe('custom');
  });

  it('falls back to safe model/runtime defaults when a role row is absent', () => {
    const cat = buildAgentCatalog([]); // no role_configs at all
    const ba = cat.find((a) => a.id === 'BA')!;
    expect(ba.model).toBe('claude-sonnet-4-6');
    expect(ba.runtime).toBe('cf-native');
    expect(ba.tools).toEqual([]);
    expect(ba.identity).toBe(DEFAULT_PERSONAS.BA);
  });
});
