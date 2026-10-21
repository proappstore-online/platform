import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Validator, type Schema } from '@cfworker/json-schema';
import { MCP_SHARED_TOOL_COUNT } from './tool-count.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
// Vendored verbatim from the manifest's official, dated $schema URL so CI does
// not depend on network access or a moving registry definition.
const validator = new Validator(read('./__fixtures__/mcp-registry-2025-12-11.schema.json') as Schema, '7');
const worker = read('../server.json');
const npm = read('../../mcp-registry/server.json');

describe('published MCP registry manifests', () => {
  it.each([['worker', worker], ['npm wrapper', npm]])('%s conforms to the official registry schema', (_name, manifest) => {
    const result = validator.validate(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(manifest).not.toHaveProperty('remoteEndpoints');
    expect(manifest.remotes).toEqual([{ type: 'streamable-http', url: 'https://mcp.proappstore.online/mcp' }]);
  });

  it('both discovery surfaces describe the complete general PAS tool catalogue', () => {
    expect(worker.version).toBe(read('../package.json').version);
    expect(worker.tools).toHaveLength(MCP_SHARED_TOOL_COUNT);
    expect(npm.tools).toEqual(worker.tools);
    expect(new Set(worker.tools.map((tool: { name: string }) => tool.name)).size).toBe(MCP_SHARED_TOOL_COUNT);
    expect(npm.packages[0].version).toBe(read('../../mcp-registry/package.json').version);
  });
});
