// Pure, testable GitHub webhook logic for the PAS build orchestrator
// (ADR-006, Phase 2). No bindings, no I/O beyond Web Crypto — so the
// security-critical parts (signature verification, "should we build this push")
// are unit-tested deterministically.

const enc = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Constant-time hex compare — avoids leaking the secret via timing. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify GitHub's `X-Hub-Signature-256: sha256=<hmac>` over the RAW request
 * body. MUST be called on the exact bytes received (re-serializing JSON would
 * change the HMAC). Returns false on any malformed/missing input — never throws.
 */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header || !header.startsWith('sha256=') || !secret) return false;
  const expected = header.slice('sha256='.length);
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return timingSafeEqualHex(toHex(new Uint8Array(mac)), expected);
}

export interface ParsedPush {
  repo: string; // owner/name
  name: string; // repo name (= appId)
  ref: string; // refs/heads/<branch>
  sha: string; // head commit (after)
  defaultBranch: string;
  deleted: boolean;
  installationId: number | null;
}

const ZERO_SHA = '0'.repeat(40);

/**
 * Extract the fields we need from a GitHub `push` webhook payload. Returns null
 * if the shape isn't a push we understand (defensive against other event types
 * and malformed bodies).
 */
export function parsePush(payload: unknown): ParsedPush | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const repoObj = p.repository as Record<string, unknown> | undefined;
  const fullName = repoObj?.full_name;
  const ref = p.ref;
  const after = p.after;
  if (typeof fullName !== 'string' || typeof ref !== 'string' || typeof after !== 'string') {
    return null;
  }
  const name = fullName.includes('/') ? fullName.slice(fullName.indexOf('/') + 1) : fullName;
  const inst = p.installation as Record<string, unknown> | undefined;
  return {
    repo: fullName,
    name,
    ref,
    sha: after,
    defaultBranch: typeof repoObj?.default_branch === 'string' ? repoObj.default_branch : 'main',
    deleted: p.deleted === true,
    installationId: typeof inst?.id === 'number' ? inst.id : null,
  };
}

/**
 * Build only real commits pushed to the repo's default branch. Skips branch/tag
 * deletes (after == 0000…), non-default branches, tags, and zero shas.
 */
export function shouldBuild(p: ParsedPush): boolean {
  if (p.deleted) return false;
  if (p.sha === ZERO_SHA || !/^[0-9a-f]{40}$/.test(p.sha)) return false;
  return p.ref === `refs/heads/${p.defaultBranch}`;
}

export interface BuildJob {
  repo: string; // owner/name
  sha: string;
  appId: string; // == repo name
  installationId: number | null;
}

export function buildJobFrom(p: ParsedPush): BuildJob {
  return { repo: p.repo, sha: p.sha, appId: p.name, installationId: p.installationId };
}
