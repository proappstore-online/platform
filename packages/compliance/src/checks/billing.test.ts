import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkBilling } from './billing.js';

const tool = { name: 'can_buy', operation: 'query', callers: ['billing'], requires_auth: true, params: { product: { type: 'string' }, subjects_json: { type: 'string' } } };
const product = { key: 'term', name: 'Term', amount: 1000, currency: 'aud' };
const run = (manifest?: unknown) => checkBilling(mapFileSource(new Map(manifest === undefined ? [] : [['mcp.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest)]])));

describe('checkBilling (#507)', () => {
  it('passes without an mcp.json, with invalid JSON, or when the app sells nothing', async () => {
    for (const m of [undefined, '{nope', { tools: [] }]) expect((await run(m)).status).toBe('pass');
  });
  it('passes a valid billing section', async () => {
    const r = await run({ tools: [tool], billing: { authorize_action: 'can_buy', products: [product] } });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('1 product');
  });
  it('fails an invalid one with the registration error and a suggestion', async () => {
    const r = await run({ tools: [{ ...tool, callers: ['user'] }], billing: { authorize_action: 'can_buy', products: [product] } });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('must list "billing"');
    expect(r.suggestions?.length).toBeGreaterThan(0);
  });
});
