import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PlayRelease } from '../scripts/android-play-release.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { client_email: 'pas-publisher@example.invalid', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
// Play's real track list: internal testing is reported as `qa`, closed tracks carry Console-chosen names (#664).
const PLAY_TRACKS = ['production', 'qa', 'beta', 'closed-testers'];
function fixture({ uploaded = 12, verified = true, failUpload = false, staged = false, tracks = PLAY_TRACKS } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let edits = 0;
  let publishedStatus = 'completed';
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('oauth2.googleapis.com')) return reply({ access_token: 'test-token' });
    if (url.endsWith('/edits') && init.method === 'POST') return reply({ id: `edit-${++edits}` });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/tracks')) return reply({ tracks: tracks.map((track, i) => ({ track, releases: i < 2 ? [{ versionCodes: [i ? '9' : '3'] }] : [] })) });
    if (url.endsWith('/bundles')) return reply({ bundles: [{ versionCode: 11 }] });
    if (url.endsWith('/apks')) return reply({ apks: [{ versionCode: 7 }] });
    if (url.includes('uploadType')) return reply({ versionCode: uploaded }, failUpload ? 403 : 200);
    if (/\/tracks\/[a-z0-9:_-]+$/.test(url) && init.method === 'PUT') publishedStatus = JSON.parse(init.body as string).releases[0].status;
    if (/\/tracks\/[a-z0-9:_-]+$/.test(url) && init.method === 'GET') return reply({ releases: edits > 1 ? [{ versionCodes: [verified ? '12' : '8'], status: publishedStatus }] : staged ? [{ versionCodes: ['8'], status: 'inProgress' }] : [] });
    return reply({});
  };
  return { client: new PlayRelease(credentials, { fetcher }), calls };
}

describe('PAS Android release pipeline', () => {
  it('parses every multiline workflow shell step before CI runs it', () => {
    const workflow = readFileSync('.github/workflows/android.yml', 'utf8');
    const scripts = [...workflow.matchAll(/^        run: \|\n((?:          .*\n?)+)/gm)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, script] of scripts) {
      expect(() => execFileSync('bash', ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] })).not.toThrow();
    }
  });
  it('chooses above all tracks and uploaded bundles, and preserves a higher local floor', async () => {
    expect(await fixture().client.nextCode(2)).toBe(12);
    expect(await fixture().client.nextCode(20)).toBe(20);
  });
  it('uploads, validates, commits and verifies using a fresh edit', async () => {
    const { client, calls } = fixture();
    expect(await client.publish(new Uint8Array([1]), 12, 'production', 'completed')).toMatchObject({ verified: true, packageName: 'online.proappstore.app' });
    const paths = calls.map(c => new URL(c.url).pathname);
    expect(paths.findIndex(p => p.endsWith(':validate'))).toBeLessThan(paths.findIndex(p => p.endsWith(':commit')));
    expect(paths.some(p => p.endsWith('/edits/edit-2/tracks/production'))).toBe(true);
    expect(calls.filter(c => c.init.method === 'DELETE')).toHaveLength(2);
    expect(calls.every(c => c.init.redirect === 'error')).toBe(true);
    const tokenRequest = calls[0].init.body as URLSearchParams;
    const payload = JSON.parse(Buffer.from(tokenRequest.get('assertion')!.split('.')[1], 'base64url').toString());
    expect(payload.scope).toBe('https://www.googleapis.com/auth/androidpublisher');
  });
  it('refuses mismatched uploaded versions before changing a track', async () => {
    const { client, calls } = fixture({ uploaded: 13 });
    await expect(client.publish(new Uint8Array([1]), 12, 'production', 'completed')).rejects.toThrow('differs');
    expect(calls.some(c => c.init.method === 'PUT')).toBe(false);
    expect(calls.at(-1)!.init.method).toBe('DELETE');
  });
  it('keeps an initial internal upload in draft status', async () => {
    const { client, calls } = fixture({ tracks: ['production', 'internal'] });
    expect(await client.publish(new Uint8Array([1]), 12, 'internal', 'draft')).toMatchObject({ track: 'internal', status: 'draft', verified: true });
    expect(JSON.parse(calls.find(c => c.init.method === 'PUT')!.init.body as string).releases[0].status).toBe('draft');
  });
  it('fails on missing post-commit evidence instead of reporting a release', async () => {
    await expect(fixture({ verified: false }).client.publish(new Uint8Array([1]), 12, 'production', 'completed')).rejects.toThrow('verification failed');
  });
  it('discards failed uploads and never commits them', async () => {
    const { client, calls } = fixture({ failUpload: true });
    await expect(client.publish(new Uint8Array([1]), 12, 'production', 'completed')).rejects.toThrow('HTTP 403');
    expect(calls.some(c => c.url.endsWith(':commit'))).toBe(false);
    expect(calls.at(-1)!.init.method).toBe('DELETE');
  });
  it('does not overwrite an active staged rollout', async () => {
    const { client, calls } = fixture({ staged: true });
    await expect(client.publish(new Uint8Array([1]), 12, 'production', 'completed')).rejects.toThrow('staged rollout');
    expect(calls.some(c => c.url.includes('uploadType'))).toBe(false);
  });
  it('refuses untrusted token endpoints, invalid codes and unsupported tracks', async () => {
    expect(() => new PlayRelease({ ...credentials, token_uri: 'https://untrusted.invalid' })).toThrow('credential');
    await expect(fixture().client.nextCode(2_100_000_001)).rejects.toThrow('version code');
    await expect(fixture().client.publish(new Uint8Array([1]), 12, '../edits', 'completed')).rejects.toThrow('track');
    await expect(fixture().client.publish(new Uint8Array([1]), 12, 'production', 'inProgress')).rejects.toThrow('status');
  });
  it('publishes to a closed track named in Play Console', async () => {
    const { client, calls } = fixture();
    expect(await client.publish(new Uint8Array([1]), 12, 'closed-testers', 'completed')).toMatchObject({ track: 'closed-testers', verified: true });
    expect(calls.some(c => c.init.method === 'PUT' && new URL(c.url).pathname.endsWith('/tracks/closed-testers'))).toBe(true);
  });
  it('refuses a track Play does not have, naming the tracks that exist, before uploading', async () => {
    const { client, calls } = fixture();
    await expect(client.publish(new Uint8Array([1]), 12, 'nope', 'completed')).rejects.toThrow('production, qa, beta, closed-testers');
    expect(calls.some(c => c.url.includes('uploadType'))).toBe(false);
    expect(calls.at(-1)!.init.method).toBe('DELETE');
  });
  it('never defaults automatic publishing to production', () => {
    const workflow = readFileSync('.github/workflows/android.yml', 'utf8');
    expect(workflow).toContain("vars.ANDROID_PLAY_TRACK || 'internal'");
    expect(workflow).not.toMatch(/ANDROID_PLAY_TRACK \|\| 'production'/);
    // Production is manual only: a push with ANDROID_PLAY_TRACK=production fails before building.
    expect(workflow).toContain("if: env.PUBLISH_PLAY == 'true' && github.event_name != 'workflow_dispatch' && env.PLAY_TRACK == 'production'");
    expect(workflow.indexOf('Automatic publishing never targets production')).toBeLessThan(workflow.indexOf('Publish and verify Google Play track'));
    expect(workflow).toMatch(/track:\n\s+description: .*\n\s+type: string\n\s+default: internal/);
  });
  it('keeps publishing credentials out of pull requests and uses the runner router', () => {
    const workflow = readFileSync('.github/workflows/android.yml', 'utf8');
    expect(workflow).toContain("github.event_name != 'pull_request'");
    expect(workflow).toContain('needs: [router, build]');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toMatch(/runs-on:\s*(ubuntu|self-hosted)/);
    const build = workflow.split('\n  release:')[0];
    expect(build).not.toContain('secrets.ANDROID_UPLOAD');
  });
});
