/**
 * The registry manifest (#114) must name exactly the tools the shared endpoint
 * registers — every `server.tool('name', …)` in the source, no more, no fewer —
 * and its count must be the pinned shared-tool count. A tool added or renamed
 * without touching server.json fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_SHARED_TOOL_COUNT } from './tool-count.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../server.json', import.meta.url)), 'utf8')) as {
  $schema: string; name: string; version: string; remotes: { type: string; url: string }[]; tools: { name: string; description: string }[];
  _meta: Record<string, { safety: { confirm_required: string[]; dry_run_supported: string[] }; tool_groups: Record<string, string[]> }>;
};

function registeredTools(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = readFileSync(`${dir}/${file}`, 'utf8');
    for (const m of src.matchAll(/server\.tool\(\s*['"]([a-z_]+)['"]/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

describe('server.json', () => {
  it('lists exactly the tools the shared endpoint registers, in the pinned count', () => {
    const listed = manifest.tools.map((t) => t.name).sort();
    expect(listed).toEqual(registeredTools());
    expect(listed).toHaveLength(MCP_SHARED_TOOL_COUNT);
    expect(new Set(listed).size).toBe(listed.length);
    for (const t of manifest.tools) expect(t.description.length, t.name).toBeGreaterThan(10);
  });

  it('points at the live endpoint with the server version and the registry schema', () => {
    expect(manifest.$schema).toMatch(/modelcontextprotocol\.io\/schemas\/.*server\.schema\.json$/);
    expect(manifest.name).toBe('io.github.proappstore-online/platform');
    expect(manifest.remotes).toEqual([{ type: 'streamable-http', url: 'https://mcp.proappstore.online/mcp' }]);
    const indexSrc = readFileSync(`${dir}/index.ts`, 'utf8');
    expect(indexSrc).toContain(`version: "${manifest.version}"`);
  });

  it('safety metadata names real tools and every group member is a listed tool', () => {
    const listed = new Set(manifest.tools.map((t) => t.name));
    const meta = manifest._meta['io.github.proappstore-online/platform']!;
    for (const n of [...meta.safety.confirm_required, ...meta.safety.dry_run_supported]) expect(listed.has(n), n).toBe(true);
    const grouped = Object.values(meta.tool_groups).flat().sort();
    expect(grouped).toEqual([...listed].sort());
  });
});
