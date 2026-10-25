import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function tmp(pkg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

/**
 * #435: the Build step's fail-closed gate (#204) must not depend on jq. On a runner without jq
 * `if jq -e ...` is false, so a bundle with a build script silently got a bare `vite build`.
 */
const WORKFLOW = readFileSync(new URL('../../../.github/workflows/app-deploy.yml', import.meta.url), 'utf8');

const step = (name: string): string => {
  const start = WORKFLOW.indexOf(`- name: ${name}\n`);
  expect(start, `step "${name}" exists`).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf('\n      - ', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
};

describe('app-deploy.yml Build gate (#435)', () => {
  it('decides gated vs fallback build with node, not jq', () => {
    const build = step('Build');
    expect(build).toContain(`node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"`);
    expect(build).not.toMatch(/\bjq\b.*scripts\.build/);
    expect(build).toContain('pnpm build');
    expect(build).toContain('npx vite build');
  });

  it('installs jq on self-hosted macOS before Build, failing loudly', () => {
    const ensure = step('Ensure jq on self-hosted macOS');
    expect(ensure).toContain("if: runner.os == 'macOS'");
    expect(ensure).toContain('brew install jq');
    expect(ensure).toContain('::error::');
    expect(WORKFLOW.indexOf('- name: Ensure jq on self-hosted macOS')).toBeLessThan(WORKFLOW.indexOf('- name: Build\n'));
  });

  it('the node gate really tells a build script from none', () => {
    const gate = (pkg: unknown) => {
      try { execFileSync('node', ['-e', "process.exit(require('./package.json').scripts?.build ? 0 : 1)"], { cwd: tmp(pkg) }); return 0; }
      catch (e) { return (e as { status: number }).status; }
    };
    expect(gate({ scripts: { build: 'tsc && vite build' } })).toBe(0);
    expect(gate({ scripts: { dev: 'vite' } })).toBe(1);
    expect(gate({})).toBe(1);
  });
});

/**
 * #462: the e2e job mints its test session keylessly (GitHub OIDC → /v1/auth/exchange/oidc) and
 * fails LOUDLY when the repo has no grant — never a silent skip of the signed-in specs.
 */
describe('app-deploy.yml e2e session mint (#462)', () => {
  const MINT = 'Mint the e2e session (keyless — GitHub OIDC → platform session grant)';

  /** The step's `run:` block, dedented — what the runner executes. */
  const script = (): string => {
    const body = step(MINT).split('run: |\n')[1];
    expect(body, 'mint step has a run block').toBeTruthy();
    return body!.split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
  };

  it('runs after the browser install and before Playwright, and the job may request an OIDC token', () => {
    expect(WORKFLOW.indexOf(`- name: ${MINT}`)).toBeGreaterThan(WORKFLOW.indexOf('- name: Install Playwright browser'));
    expect(WORKFLOW.indexOf(`- name: ${MINT}`)).toBeLessThan(WORKFLOW.indexOf('- name: Run E2E'));
    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read\n {2}id-token: write\n/m);
  });

  it('hands Playwright the minted token, not the stored secret (which would override it)', () => {
    const run = step('Run E2E');
    expect(run).not.toContain('PAS_E2E_SESSION_TOKEN');
    expect(run).not.toContain('E2E_SESSION_TOKEN:');
    expect(step(MINT)).toContain('>> "$GITHUB_ENV"');
  });

  it('does not depend on jq (#435)', () => {
    const code = script().split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/\bjq\b/);
  });

  describe('executed against a fake curl', () => {
    function run(env: Record<string, string>) {
      const dir = mkdtempSync(join(tmpdir(), 'mint-'));
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'curl'), `#!/bin/bash
echo "$*" >> "${dir}/curl.log"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done
case "$url" in
  *audience=*) printf '%s' "$FAKE_OIDC" ;;
  *exchange/oidc) printf '%s' "$FAKE_BODY" > "$out"; printf '%s' "$FAKE_CODE" ;;
esac
`, { mode: 0o755 });
      writeFileSync(join(dir, 'step.sh'), script());
      const githubEnv = join(dir, 'github_env');
      writeFileSync(githubEnv, '');
      const r = spawnSync('bash', [join(dir, 'step.sh')], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_ENV: githubEnv,
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.invalid/?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
          FAKE_OIDC: '{"value":"oidc-jwt"}', FAKE_CODE: '200', FAKE_BODY: '{"sessionToken":"sess-123"}',
          ...env,
        },
      });
      const calls = (() => { try { return readFileSync(join(dir, 'curl.log'), 'utf8'); } catch { return ''; } })();
      return { code: r.status, out: r.stdout + r.stderr, githubEnv: readFileSync(githubEnv, 'utf8'), calls };
    }

    it('exports E2E_SESSION_TOKEN (masked first) when the exchange succeeds', () => {
      const r = run({});
      expect(r.code).toBe(0);
      expect(r.githubEnv).toBe('E2E_SESSION_TOKEN=sess-123\n');
      expect(r.out).toContain('::add-mask::sess-123');
      expect(r.calls).toContain('audience=https://api.proappstore.online');
      expect(r.calls).toContain('https://api.proappstore.online/v1/auth/exchange/oidc');
      expect(r.calls).toContain('Authorization: Bearer oidc-jwt');
    });

    it('fails loudly, saying the repo has no oidc-session grant, on a 403', () => {
      const r = run({ FAKE_CODE: '403', FAKE_BODY: '{"error":"no e2e session grant for proappstore-online/x"}' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('::error::this repo has no oidc-session grant (HTTP 403: no e2e session grant for proappstore-online/x)');
      expect(r.out).toContain('PAS_E2E_SESSION_TOKEN');
      expect(r.githubEnv).toBe('');
    });

    it('fails loudly on any other exchange failure, with the status', () => {
      const r = run({ FAKE_CODE: '500', FAKE_BODY: '{"error":"boom"}' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('::error::the e2e session exchange failed (HTTP 500): boom');
      expect(r.githubEnv).toBe('');
    });

    it('fails when a 200 carries no session token', () => {
      const r = run({ FAKE_BODY: '{}' });
      expect(r.code).toBe(1);
      expect(r.githubEnv).toBe('');
    });

    it('fails loudly when GitHub gives no OIDC token, or the job has no id-token permission', () => {
      const none = run({ FAKE_OIDC: '{}' });
      expect(none.code).toBe(1);
      expect(none.out).toContain('::error::could not obtain a GitHub OIDC token');
      const noPerm = run({ ACTIONS_ID_TOKEN_REQUEST_URL: '' });
      expect(noPerm.code).toBe(1);
      expect(noPerm.out).toContain("id-token: write");
      expect(noPerm.calls).toBe('');
    });

    it('uses a stored PAS_E2E_SESSION_TOKEN as the documented fallback, without any exchange', () => {
      const r = run({ PAS_E2E_SESSION_TOKEN: 'stored-token' });
      expect(r.code).toBe(0);
      expect(r.githubEnv).toBe('E2E_SESSION_TOKEN=stored-token\n');
      expect(r.out).toContain('::add-mask::stored-token');
      expect(r.calls).toBe('');
    });
  });
});
