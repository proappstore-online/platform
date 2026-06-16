import { describe, expect, it } from 'vitest';
import { verifySignature, parsePush, shouldBuild, buildJobFrom } from './webhook.ts';

const SECRET = 'whsec_test';

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifySignature', () => {
  const body = '{"hello":"world"}';

  it('accepts a correct sha256 HMAC over the raw body', async () => {
    expect(await verifySignature(body, await sign(body, SECRET), SECRET)).toBe(true);
  });
  it('rejects a tampered body', async () => {
    const good = await sign(body, SECRET);
    expect(await verifySignature(body + ' ', good, SECRET)).toBe(false);
  });
  it('rejects the wrong secret', async () => {
    expect(await verifySignature(body, await sign(body, 'other'), SECRET)).toBe(false);
  });
  it('rejects a missing/garbage header', async () => {
    expect(await verifySignature(body, null, SECRET)).toBe(false);
    expect(await verifySignature(body, 'nope', SECRET)).toBe(false);
    expect(await verifySignature(body, 'sha1=abc', SECRET)).toBe(false);
  });
  it('rejects an empty secret (misconfig fails closed)', async () => {
    // Can't HMAC with a zero-length key; the point is verifySignature refuses
    // outright when the secret is empty, regardless of the header.
    expect(await verifySignature(body, 'sha256=' + 'ab'.repeat(32), '')).toBe(false);
  });
});

const pushPayload = (over: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main',
  after: 'a'.repeat(40),
  deleted: false,
  repository: { full_name: 'proappstore-online/clean-up', default_branch: 'main' },
  installation: { id: 42 },
  ...over,
});

describe('parsePush', () => {
  it('extracts repo/name/ref/sha/branch/installation', () => {
    expect(parsePush(pushPayload())).toEqual({
      repo: 'proappstore-online/clean-up',
      name: 'clean-up',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      defaultBranch: 'main',
      deleted: false,
      installationId: 42,
    });
  });
  it('returns null for non-push / malformed bodies', () => {
    expect(parsePush(null)).toBeNull();
    expect(parsePush({})).toBeNull();
    expect(parsePush({ ref: 'refs/heads/main' })).toBeNull(); // no repository
  });
  it('tolerates a missing installation (external/unbound)', () => {
    expect(parsePush(pushPayload({ installation: undefined }))?.installationId).toBeNull();
  });
});

describe('shouldBuild', () => {
  const base = parsePush(pushPayload())!;
  it('builds a real commit on the default branch', () => {
    expect(shouldBuild(base)).toBe(true);
  });
  it('skips non-default branches', () => {
    expect(shouldBuild({ ...base, ref: 'refs/heads/feature' })).toBe(false);
  });
  it('skips tags', () => {
    expect(shouldBuild({ ...base, ref: 'refs/tags/v1' })).toBe(false);
  });
  it('skips branch deletes (zero sha / deleted flag)', () => {
    expect(shouldBuild({ ...base, deleted: true })).toBe(false);
    expect(shouldBuild({ ...base, sha: '0'.repeat(40) })).toBe(false);
  });
  it('honors a non-main default branch', () => {
    const master = parsePush(pushPayload({ ref: 'refs/heads/master', repository: { full_name: 'o/r', default_branch: 'master' } }))!;
    expect(shouldBuild(master)).toBe(true);
  });
});

describe('buildJobFrom', () => {
  it('uses the repo name as the appId', () => {
    expect(buildJobFrom(parsePush(pushPayload())!)).toEqual({
      repo: 'proappstore-online/clean-up',
      sha: 'a'.repeat(40),
      appId: 'clean-up',
      installationId: 42,
    });
  });
});
