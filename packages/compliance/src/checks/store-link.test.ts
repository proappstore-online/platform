import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkStoreLink } from './store-link.js';

describe('checkStoreLink', () => {
  it('passes for an app referencing proappstore.online in src', async () => {
    const files = new Map([
      [
        'web/src/Footer.tsx',
        'export default () => <a href="https://proappstore.online">Catalog</a>;',
      ],
    ]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/proappstore\.online/);
  });

  it('warns when web/src/ has no proappstore.online link anywhere', async () => {
    // PAS apps must link back to the storefront so visitors can find
    // the rest of the catalog. An unrelated link doesn't count.
    const files = new Map([['web/src/About.tsx', 'const x = "https://example.com";']]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/proappstore\.online/);
  });

  it('warns when no store link anywhere in web/src/', async () => {
    const files = new Map([['web/src/App.tsx', 'export default () => <div>hi</div>;']]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('warn');
  });
});
