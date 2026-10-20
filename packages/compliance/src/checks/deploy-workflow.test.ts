import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapFileSource } from '../lib/file-source.js';
import { checkDeployWorkflow } from './deploy-workflow.js';

const CALLER = readFileSync(new URL('../../../admin/src/__fixtures__/canonical-deploy.yml', import.meta.url), 'utf8');
const KB = readFileSync(new URL('../../../admin/src/__fixtures__/canonical-kb.yml', import.meta.url), 'utf8');
const run = (files: Record<string, string>) => checkDeployWorkflow(mapFileSource(new Map(Object.entries(files))));

describe('checkDeployWorkflow (#427)', () => {
  it('passes the canonical thin caller beside the canonical KB workflow', async () => {
    expect(await run({ '.github/workflows/deploy.yml': CALLER, '.github/workflows/kb.yml': KB })).toMatchObject({ status: 'pass' });
  });

  it('warns on a copied pipeline and on a missing deploy.yml', async () => {
    expect(await run({ '.github/workflows/deploy.yml': 'name: Deploy to R2\njobs:\n  deploy:\n    steps: []\n' }))
      .toMatchObject({ status: 'warn', detail: expect.stringMatching(/copied pipeline/) });
    expect(await run({})).toMatchObject({ status: 'warn', detail: expect.stringMatching(/no \.github\/workflows\/deploy\.yml/) });
  });

  it('flags [SECURITY] each workflow that deploys a Cloudflare script or reads a platform credential (#264)', async () => {
    const r = await run({
      '.github/workflows/deploy.yml': `${CALLER}\n  extra:\n    steps:\n      - run: npx wrangler deploy --name pas-data-doordrop\n        env:\n          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`,
      '.github/workflows/kb.yml': 'x-internal-token: ${{ secrets.INTERNAL_TOKEN }}\n',
    });
    expect(r.status).toBe('warn');
    for (const what of ['deploy.yml runs wrangler', 'deploy.yml names a platform-managed Worker (pas-data-', 'deploy.yml reads a platform credential (secrets.CLOUDFLARE_API_TOKEN)', 'kb.yml reads a platform credential (secrets.INTERNAL_TOKEN)']) {
      expect(r.detail).toContain(what);
    }
    expect(r.detail).not.toMatch(/copied pipeline/);
  });

  it('accepts any released tag and inputs', async () => {
    const withInputs = CALLER.replace('    secrets: inherit', '    with:\n      e2e: web\n    secrets: inherit').replace('@app-deploy-v1', '@app-deploy-v2');
    expect((await run({ '.github/workflows/deploy.yml': withInputs })).status).toBe('pass');
  });
});
