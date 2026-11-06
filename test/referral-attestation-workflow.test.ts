import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/app-deploy.yml', import.meta.url), 'utf8');
const attestation = workflow.slice(workflow.indexOf('      - name: Verify and attest referral readiness'));
const metadata = attestation.slice(attestation.indexOf('          import { existsSync, readFileSync }'), attestation.indexOf('          const { APP_ID, PAS_DEPLOY_ID'));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(web: boolean, hoisted = false, installed = true) {
  const root = mkdtempSync(join(tmpdir(), 'pas-referral-sdk-'));
  roots.push(root);
  const app = web ? join(root, 'web') : root;
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"type":"module"}');
  if (installed) {
    const sdk = join(hoisted ? root : app, 'node_modules/@proappstore/sdk');
    mkdirSync(join(sdk, 'dist'), { recursive: true });
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@proappstore/sdk', version: '1.16.104', type: 'module', exports: { '.': { import: './dist/index.js' } } }));
    writeFileSync(join(sdk, 'dist/index.js'), 'throw new Error("Metadata lookup must not import browser SDK code");');
  }
  return root;
}

describe('deployment referral attestation SDK metadata', () => {
  it.each([{ web: true, hoisted: false }, { web: false, hoisted: false }, { web: true, hoisted: true }])('reads an import-only SDK in $web web / $hoisted hoisted layout', ({ web, hoisted }) => {
    const root = fixture(web, hoisted);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', metadata + '\nconsole.log(JSON.stringify(sdk));'], { cwd: root, encoding: 'utf8' });
    expect(JSON.parse(result)).toMatchObject({ name: '@proappstore/sdk', version: '1.16.104' });
  });

  it('fails closed when the SDK is not installed', () => {
    const root = fixture(true, false, false);
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', metadata], { cwd: root, stdio: 'pipe' })).toThrow();
  });
});
