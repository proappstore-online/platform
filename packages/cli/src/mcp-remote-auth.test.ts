import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The broker's own sealing function, so these tests open exactly what production seals. Loaded by a
// computed path so the CLI's type program stays inside the CLI (the backend is a Workers package).
const BROKER = '../../backend/src/routes/mcp-broker.js';
const { seal } = await import(/* @vite-ignore */ BROKER) as {
  seal: (publicKey: string, value: unknown, id: string) => Promise<{ iv: string; ciphertext: string }>;
};
import {
  connect, generateMachineSecrets, openEnvelope, RemoteAuthError, type ConnectOptions, type RemoteAuthDeps, type StoredCredential,
} from './mcp-remote-auth.js';

// #356, synthetic: a fake broker that keeps the real broker's rules (proof hash, PKCE, generic 409,
// single redemption, receipt-gated `connected`) and seals with the broker's own `seal`; a fake phone;
// a fake MCP endpoint that records the authenticated read; a fake `pags`. No network, no real account,
// no real device. Real-device acceptance is ProAgentStore #1006.

const API = 'https://api.test';
const RESOURCE = 'https://mcp.test/mcp';
const OWNER_SESSION = 'owner-session-synthetic';
const OTHER_SESSION = 'other-session-synthetic';
const OWNERS: Record<string, string> = { [OWNER_SESSION]: 'gh:1', [OTHER_SESSION]: 'gh:2' };

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const sha = async (s: string) => new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

interface Req {
  id: string; owner: string; proofHash: string; challenge: string; publicKey: string; resource: string;
  status: string; expires: number; envelope: { iv: string; ephemeral_public_key: string; ciphertext: string } | null;
  attemptId: string | null; token: string | null; seen: boolean;
}

let dir: string;
let clock: number;
let lines: string[];
let requests: Map<string, Req>;
let creates: number;
let relays: { input: string; parsed: Record<string, unknown> }[];
let states: [string, string][];
let pagsVersion: string | null;
let relayExit: number[];
let failNetwork: { path: string; times: number } | null;
let onPoll: (r: Req, n: number) => Promise<void> | void;
let polls: number;
let mcpUp: boolean;

/** The phone: approve as `session`'s user. A user who is not the owner cannot approve (the broker refuses). */
async function approve(r: Req, session = OWNER_SESSION): Promise<boolean> {
  if (OWNERS[session] !== r.owner || r.status !== 'pending') return false;
  r.token = `mcp-token-${b64(webcrypto.getRandomValues(new Uint8Array(16)))}`;
  const sealed = await seal(r.publicKey, { access_token: r.token, token_type: 'Bearer', resource: r.resource, expires_in: 86_400 }, r.id);
  r.envelope = { iv: sealed.iv, ...JSON.parse(sealed.ciphertext) };
  r.status = 'approved_awaiting_machine';
  return true;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (failNetwork && url.endsWith(failNetwork.path) && failNetwork.times > 0) {
    failNetwork.times -= 1;
    throw new TypeError('fetch failed');
  }
  if (url === RESOURCE) {
    const bearer = new Headers(init?.headers).get('Authorization')?.slice(7);
    const r = [...requests.values()].find((x) => x.token && x.token === bearer);
    if (!mcpUp || !r) return new Response('unauthorized', { status: 401 });
    r.seen = true;
    return json(200, { jsonrpc: '2.0', id: 1, result: {} });
  }
  const path = url.slice(`${API}/v1/mcp/broker/v2`.length);
  const unavailable = () => json(409, { error: 'remote_auth_unavailable' });
  if (path === '/requests') {
    const owner = OWNERS[new Headers(init?.headers).get('Authorization')?.slice(7) ?? ''];
    if (!owner) return json(401, { error: 'unauthorized' });
    creates += 1;
    const id = `req_${b64(webcrypto.getRandomValues(new Uint8Array(32)))}`;
    requests.set(id, {
      id, owner, proofHash: String(body.machine_proof_hash), challenge: String(body.code_challenge), publicKey: String(body.machine_public_key),
      resource: String(body.resource), status: 'pending', expires: clock + 10 * 60_000, envelope: null, attemptId: null, token: null, seen: false,
    });
    return json(201, { request_id: id, status: 'pending', expires_at: clock + 10 * 60_000, approval_url: `${API}/v1/mcp/broker/v2/requests/${id}/approve`, status_url: `${API}/v1/mcp/broker/v2/requests/${id}/status` });
  }
  const r = requests.get(String(body.request_id));
  if (!r || Buffer.from(await sha(String(body.machine_proof))).toString('hex') !== r.proofHash) return unavailable();
  if (r.expires <= clock && ['pending', 'approving', 'approved_awaiting_machine'].includes(r.status)) r.status = 'expired';
  const pkceOk = async () => b64(await sha(String(body.code_verifier))) === r.challenge;
  if (path === '/requests/poll') {
    polls += 1;
    await onPoll(r, polls);
    return json(200, { status: r.status, retry_after_ms: 2000, expires_at: r.expires });
  }
  if (path === '/requests/redeem') {
    if (!(await pkceOk())) return unavailable();
    if (r.status === 'approved_awaiting_machine') { r.status = 'consumed'; r.attemptId = String(body.redeem_attempt_id); return json(200, { status: 'consumed', credential: r.envelope }); }
    if (r.status === 'consumed' && r.attemptId === body.redeem_attempt_id) return json(200, { status: 'consumed', credential: r.envelope });
    return unavailable();
  }
  if (path === '/requests/connected' || path === '/requests/failed') {
    if (!(await pkceOk()) || r.status !== 'consumed' || (path === '/requests/connected' && !r.seen)) return unavailable();
    r.status = path.endsWith('connected') ? 'connected' : 'failed';
    return json(200, { status: r.status });
  }
  return unavailable();
};

function deps(over: Partial<RemoteAuthDeps> = {}): RemoteAuthDeps {
  return {
    fetch: fakeFetch,
    runPags: async (args, stdin) => {
      if (args[0] === '--version') {
        if (pagsVersion === null) throw Object.assign(new Error('spawn pags ENOENT'), { code: 'ENOENT' });
        return { code: 0, stdout: `${pagsVersion}\n`, stderr: '' };
      }
      if (args[0] === 'remote-auth' && args[1] === 'relay') {
        const exit = relayExit.shift() ?? 0;
        if (exit !== 0) return { code: exit, stdout: '', stderr: 'refused' };
        const parsed = JSON.parse(stdin ?? '') as Record<string, unknown>;
        const duplicate = relays.some((x) => x.parsed.request_id === parsed.request_id);
        relays.push({ input: stdin ?? '', parsed });
        return { code: 0, stdout: `${JSON.stringify({ id: `rar_${String(parsed.request_id).slice(4, 12)}`, url: 'https://pags.test/console/remote-auth/rar_x', state: 'pending', duplicate })}\n`, stderr: '' };
      }
      if (args[0] === 'remote-auth' && args[1] === 'state') { states.push([args[2]!, args[3]!]); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 2, stdout: '', stderr: 'unknown' };
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    out: (line) => { lines.push(line); },
    dir,
    pid: 4242,
    isAlive: () => false,
    ...over,
  };
}

function opts(over: Partial<ConnectOptions> = {}): ConnectOptions {
  return {
    apiBase: API, bearer: OWNER_SESSION, resource: RESOURCE, name: 'proappstore-remote',
    agent: { id: 'codex', label: 'Codex' }, machine: { id: 'mac-42', label: 'Remote Mac' }, relay: true, clientVersion: '0.0.0-test',
    ...over,
  };
}

const stored = async () => JSON.parse(await readFile(join(dir, 'proappstore-remote.json'), 'utf8')) as StoredCredential;
const attemptFile = () => readFile(join(dir, 'proappstore-remote.attempt.json'), 'utf8').then((s) => JSON.parse(s) as Record<string, unknown>, () => null);
async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(RemoteAuthError);
  expect((e as RemoteAuthError).code).toBe(code);
  return e as RemoteAuthError;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pas-mcp-auth-'));
  clock = 1_800_000_000_000;
  lines = [];
  requests = new Map();
  creates = 0;
  relays = [];
  states = [];
  pagsVersion = '0.4.121';
  relayExit = [];
  failNetwork = null;
  polls = 0;
  mcpUp = true;
  // The phone approves on each request's second poll.
  const perRequest = new Map<string, number>();
  onPoll = async (r) => {
    const n = (perRequest.get(r.id) ?? 0) + 1;
    perRequest.set(r.id, n);
    if (n === 2) await approve(r);
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the phone-approved happy path (#356)', () => {
  it('relays, waits, redeems, proves the credential with an MCP read, installs it 0600, then reports connected', async () => {
    const result = await connect(deps(), opts());
    const r = requests.get(result.requestId)!;
    expect(r.status).toBe('connected');
    expect(r.seen).toBe(true);
    const cred = await stored();
    expect(cred).toMatchObject({ resource: RESOURCE, token_type: 'Bearer', access_token: r.token });
    expect((await stat(join(dir, 'proappstore-remote.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await attemptFile()).toBeNull();
    // The relay carried only the documented public fields; the page saw every state, connected last.
    expect(Object.keys(relays[0]!.parsed).sort()).toEqual(['agent', 'approval_url', 'expires_at', 'machine', 'request_id', 'resource', 'scopes']);
    expect(states.map(([, s]) => s)).toEqual(['approved_awaiting_machine', 'consumed', 'connected']);
    expect(lines.join('\n')).toContain(`${API}/v1/mcp/broker/v2/requests/${result.requestId}/approve`);
  });

  it('never puts a secret on stdout, in the relay, in a URL or in an error', async () => {
    const leaks: string[] = [];
    let secrets: string[] = [];
    const watched = deps({
      fetch: async (input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (body.machine_proof) secrets.push(String(body.machine_proof), String(body.code_verifier ?? ''));
        leaks.push(String(input));
        return fakeFetch(input, init);
      },
    });
    const result = await connect(watched, opts());
    secrets = [...secrets.filter(Boolean), requests.get(result.requestId)!.token!];
    const attempt = await connect(deps(), opts({ bearer: null })).catch((e: Error) => e.message);
    const observable = [lines.join('\n'), relays.map((x) => x.input).join('\n'), states.flat().join(' '), leaks.join('\n'), String(attempt)].join('\n');
    for (const s of secrets) expect(observable).not.toContain(s);
  });
});

describe('the owner says no, or nobody answers', () => {
  it.each([['denied'], ['cancelled']] as const)('%s at ProAppStore: a readable error, the page told, nothing installed', async (status) => {
    onPoll = (r) => { r.status = status; };
    const e = await expectCode(connect(deps(), opts()), status);
    expect(e.message).toMatch(/Nothing changed on this machine/);
    expect(states.at(-1)![1]).toBe(status);
    await expect(stored()).rejects.toThrow();
    expect(await attemptFile()).toBeNull();
  });

  it('expires when nobody approves before the deadline', async () => {
    onPoll = () => undefined;
    await expectCode(connect(deps(), opts()), 'expired');
    expect(states.at(-1)![1]).toBe('expired');
    expect(await attemptFile()).toBeNull();
  });

  it('wrong owner: a different account cannot approve this machine, so it never connects', async () => {
    onPoll = async (r) => { expect(await approve(r, OTHER_SESSION)).toBe(false); };
    await expectCode(connect(deps(), opts()), 'expired');
    await expect(stored()).rejects.toThrow();
  });

  it('no PAS session on this machine: a clear error before any request is made', async () => {
    const e = await expectCode(connect(deps(), opts({ bearer: null })), 'not_signed_in');
    expect(e.message).toMatch(/pas login/);
    expect(creates).toBe(0);
  });
});

describe('wrong machine, wrong request, double redemption', () => {
  async function plantAttempt(over: Record<string, unknown>) {
    const secrets = await generateMachineSecrets();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proappstore-remote.attempt.json'), JSON.stringify({
      request_id: `req_${'A'.repeat(43)}`, resource: RESOURCE, approval_url: `${API}/x`, expires_at: clock + 60_000,
      agent: { id: 'codex', label: 'Codex' }, machine: { id: 'mac-42', label: 'Remote Mac' }, rar_id: 'rar_x', reported: 'pending',
      secrets, redeem_attempt_id: null, ...over,
    }), { mode: 0o600 });
  }

  it('wrong machine: another machine\'s proof is refused with the generic answer, and the attempt is dropped', async () => {
    const theirs = await connect(deps(), opts({ name: 'other-machine' }));
    expect(requests.get(theirs.requestId)!.status).toBe('connected');
    await plantAttempt({ request_id: theirs.requestId });
    const e = await expectCode(connect(deps(), opts()), 'unavailable');
    expect(e.message).toMatch(/belongs to another machine/);
    expect(await attemptFile()).toBeNull();
  });

  it('wrong request: an unknown request id is refused the same way', async () => {
    await plantAttempt({});
    await expectCode(connect(deps(), opts()), 'unavailable');
  });

  it('a lost redeem answer is recovered with the same attempt id: one redemption, one credential', async () => {
    // The first redeem reaches the broker and is consumed, but its answer is lost on the way back.
    const realFetch = fakeFetch;
    let lostOnce = false;
    const result = await connect(deps({
      fetch: async (input, init) => {
        if (String(input).endsWith('/requests/redeem') && !lostOnce) {
          lostOnce = true;
          await realFetch(input, init);
          throw new TypeError('fetch failed');
        }
        return realFetch(input, init);
      },
    }), opts());
    const r = requests.get(result.requestId)!;
    expect(lostOnce).toBe(true);
    expect(r.status).toBe('connected');
    expect((await stored()).access_token).toBe(r.token);
  });

  it('a second machine redeeming with a different attempt id is refused (double redemption)', async () => {
    const result = await connect(deps(), opts());
    const r = requests.get(result.requestId)!;
    r.status = 'consumed'; // as if a replay arrived right after redemption
    const res = await fakeFetch(`${API}/v1/mcp/broker/v2/requests/redeem`, { method: 'POST', body: JSON.stringify({ request_id: r.id, machine_proof: 'x'.repeat(43), code_verifier: 'y'.repeat(43), redeem_attempt_id: 'z'.repeat(43) }) });
    expect(res.status).toBe(409);
  });
});

describe('one attempt at a time; restarts resume', () => {
  it('a live lock refuses a concurrent start; a dead process\'s lock is taken over', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proappstore-remote.lock'), JSON.stringify({ pid: 99, started: clock }));
    const e = await expectCode(connect(deps({ isAlive: () => true }), opts()), 'busy');
    expect(e.message).toMatch(/already running \(process 99\)/);
    expect(creates).toBe(0);
    await connect(deps({ isAlive: () => false }), opts());
    expect(creates).toBe(1);
  });

  it('a machine that goes offline and comes back resumes the same request: no second request, no second push', async () => {
    onPoll = () => undefined;
    failNetwork = { path: '/requests/poll', times: 1_000 };
    await expectCode(connect(deps(), opts()), 'network');
    expect(await attemptFile()).not.toBeNull();
    // Back online, the owner approves.
    failNetwork = null;
    onPoll = async (r, n) => { if (n === 1) await approve(r); };
    const result = await connect(deps(), opts());
    expect(result.resumed).toBe(true);
    expect(creates).toBe(1);
    expect(relays).toHaveLength(1);
    expect(requests.get(result.requestId)!.status).toBe('connected');
  });

  it('a brief network loss while waiting is retried with backoff, not fatal', async () => {
    failNetwork = { path: '/requests/poll', times: 3 };
    onPoll = async (r) => { await approve(r); };
    const sleeps: number[] = [];
    await connect(deps({ sleep: async (ms) => { sleeps.push(ms); clock += ms; } }), opts());
    expect(sleeps.slice(0, 4)).toEqual([2000, 4000, 8000, 16000]);
  });
});

describe('the previous connection survives until the new one works', () => {
  it('a credential that fails its MCP read is not installed, the old one is kept, and the broker is told "failed"', async () => {
    await connect(deps(), opts());
    const before = await stored();
    mcpUp = false;
    const e = await expectCode(connect(deps(), opts()), 'health_check_failed');
    expect(e.message).toMatch(/previous connection is unchanged/);
    expect(await stored()).toEqual(before);
    expect([...requests.values()].at(-1)!.status).toBe('failed');
    expect(states.at(-1)![1]).toBe('failed');
  });

  it('a successful reconnect replaces the credential', async () => {
    await connect(deps(), opts());
    const before = await stored();
    await connect(deps(), opts());
    expect((await stored()).access_token).not.toBe(before.access_token);
  });
});

describe('the ProAgentStore CLI', () => {
  it('older than 0.4.121 is refused with an update message; a missing one says how to proceed', async () => {
    pagsVersion = '0.4.120';
    expect((await expectCode(connect(deps(), opts()), 'old_cli')).message).toMatch(/0\.4\.121/);
    pagsVersion = null;
    expect((await expectCode(connect(deps(), opts()), 'pags_missing')).message).toMatch(/--no-relay/);
    expect(creates).toBe(0);
  });

  it('--no-relay works without pags: the approval link is printed, nothing is relayed', async () => {
    pagsVersion = null;
    await connect(deps(), opts({ relay: false }));
    expect(relays).toHaveLength(0);
    expect(lines.some((l) => l.includes('/approve'))).toBe(true);
  });
});

describe('the broker\'s envelope (contract)', () => {
  it('opens exactly what the broker\'s own seal produces, and nothing sealed for another request', async () => {
    const secrets = await generateMachineSecrets();
    const sealed = await seal(secrets.publicKeySpki, { access_token: 't', token_type: 'Bearer', resource: RESOURCE, expires_in: 60 }, 'req_one');
    const envelope = { iv: sealed.iv, ...JSON.parse(sealed.ciphertext) } as { iv: string; ephemeral_public_key: string; ciphertext: string };
    expect(await openEnvelope(envelope, secrets.privateKeyPkcs8, 'req_one')).toEqual({ access_token: 't', token_type: 'Bearer', resource: RESOURCE, expires_in: 60 });
    await expect(openEnvelope(envelope, secrets.privateKeyPkcs8, 'req_two')).rejects.toThrow();
    const other = await generateMachineSecrets();
    await expect(openEnvelope(envelope, other.privateKeyPkcs8, 'req_one')).rejects.toThrow();
  });
});
