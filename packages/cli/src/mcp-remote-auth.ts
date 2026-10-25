import { mkdir, open, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

const crypto = webcrypto;

/**
 * PAS #356: the machine (client) half of remote MCP sign-in from a phone.
 *
 * Contracts, not invented here:
 *   - the PAS broker v2 (#355, docs/mcp-remote-auth-broker.md, backend/src/routes/mcp-broker.ts);
 *   - the PAGS relay (ProAgentStore #1005, its docs/remote-auth-relay.md): `pags remote-auth relay`
 *     takes the request's public details on stdin and pushes the owner a link to that one request.
 *
 * The machine keeps its proof, PKCE verifier and P-256 private key; only their hash, the challenge
 * and the public key leave it. The result is ECDH-encrypted to this machine. Nothing secret is ever
 * written to stdout/stderr, a URL, the relay or an error message.
 */

const BROKER_PREFIX = '/v1/mcp/broker/v2';
const BROKER_VERSION = '2026-10-10';
const MIN_PAGS_VERSION = '0.4.121';
/** Broker poll floor: the server answers an earlier poll with `429 slow_down`. */
const POLL_MS = 2_000;
const MAX_POLL_DELAY_MS = 30_000;
/** Consecutive network failures tolerated while waiting (≈ the request's 10-minute life at the backoff cap). */
const MAX_NETWORK_FAILURES = 20;
const MAX_REDEEM_ATTEMPTS = 5;
/** A lock older than this whose process is gone is stale. */
const LOCK_STALE_MS = 15 * 60_000;
/** A separate Codex server name by default, so an existing working entry is never touched. */
export const DEFAULT_SERVER_NAME = 'proappstore-remote';
export const DEFAULT_TOKEN_ENV = 'PAS_REMOTE_MCP_TOKEN';
const RELAY_STATES = ['pending', 'approving', 'approved_awaiting_machine', 'consumed', 'connected', 'denied', 'expired', 'cancelled', 'failed'] as const;
export type BrokerStatus = typeof RELAY_STATES[number];
const TERMINAL: ReadonlySet<BrokerStatus> = new Set(['connected', 'denied', 'expired', 'cancelled', 'failed']);

export type RemoteAuthErrorCode =
  | 'not_signed_in' | 'invalid_resource' | 'busy' | 'pags_missing' | 'old_cli' | 'relay_refused'
  | 'unavailable' | 'denied' | 'cancelled' | 'expired' | 'failed' | 'network' | 'health_check_failed' | 'no_credential';

/** A user-readable, actionable failure. Its message never carries secret material. */
export class RemoteAuthError extends Error {
  constructor(readonly code: RemoteAuthErrorCode, message: string) {
    super(message);
    this.name = 'RemoteAuthError';
  }
}

export interface Identity { id: string; label: string }

export interface RemoteAuthDeps {
  fetch: typeof fetch;
  /** Run `pags <args>`, `stdin` piped in. A missing binary rejects with an ENOENT error. */
  runPags: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** One line to the user (stdout). Never passed a secret. */
  out: (line: string) => void;
  /** Protected state directory, e.g. ~/.proappstore/mcp. */
  dir: string;
  pid: number;
  isAlive: (pid: number) => boolean;
}

// ── encoding & crypto (identical to the broker's) ───────────────────────────

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
function unb64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export interface MachineSecrets {
  /** Sent only to the broker's machine endpoints, never relayed or printed. */
  proof: string;
  verifier: string;
  privateKeyPkcs8: string;
  /** Public: sent when the request is created. */
  proofHash: string;
  challenge: string;
  publicKeySpki: string;
}

/** A fresh machine proof, PKCE S256 pair and P-256 key for one request. */
export async function generateMachineSecrets(): Promise<MachineSecrets> {
  const proof = b64(random(32));
  const verifier = b64(random(32));
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
  return {
    proof,
    verifier,
    privateKeyPkcs8: b64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)),
    proofHash: hex(await sha256(new TextEncoder().encode(proof))),
    challenge: b64(await sha256(new TextEncoder().encode(verifier))),
    publicKeySpki: b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey) as ArrayBuffer)),
  };
}

export interface Envelope { iv: string; ephemeral_public_key: string; ciphertext: string }
export interface McpCredential { access_token: string; token_type: string; resource: string; expires_in: number }

/** Open the broker's sealed result: ECDH P-256 → SHA-256 → AES-GCM, the request id as associated data. */
export async function openEnvelope(envelope: Envelope, privateKeyPkcs8: string, requestId: string): Promise<McpCredential> {
  const privateKey = await crypto.subtle.importKey('pkcs8', unb64(privateKeyPkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ephemeral = await crypto.subtle.importKey('spki', unb64(envelope.ephemeral_public_key), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral } as webcrypto.EcdhKeyDeriveParams, privateKey, 256);
  const key = await crypto.subtle.importKey('raw', await sha256(new Uint8Array(bits)), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: new TextEncoder().encode(requestId) },
    key,
    unb64(envelope.ciphertext),
  );
  const value = JSON.parse(new TextDecoder().decode(plain)) as Partial<McpCredential>;
  if (typeof value.access_token !== 'string' || typeof value.resource !== 'string') throw new RemoteAuthError('failed', 'ProAppStore returned an unreadable result. Run the command again.');
  return { access_token: value.access_token, token_type: value.token_type ?? 'Bearer', resource: value.resource, expires_in: value.expires_in ?? 0 };
}

// ── resource & identities ───────────────────────────────────────────────────

const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const LABEL_RE = /^[\x20-\x7e]{1,120}$/;

/** Exactly `<origin>/mcp` or `<origin>/mcp/apps/:appId` — the only resources the broker accepts. */
export function mcpResource(origin: string, appId?: string): string {
  let o: URL;
  try { o = new URL(origin); } catch { throw new RemoteAuthError('invalid_resource', `PAS_MCP_ORIGIN is not a URL: ${origin}`); }
  if (o.protocol !== 'https:' && o.hostname !== 'localhost' && o.hostname !== '127.0.0.1') throw new RemoteAuthError('invalid_resource', 'the MCP origin must be https');
  if (appId === undefined) return `${o.origin}/mcp`;
  if (!/^[a-z][a-z0-9-]{0,57}$/.test(appId)) throw new RemoteAuthError('invalid_resource', `invalid app id "${appId}"`);
  return `${o.origin}/mcp/apps/${appId}`;
}

/** A broker-valid identity: the id restricted to [A-Za-z0-9._:-], the label to printable ASCII. */
export function identity(id: string, label: string): Identity {
  const safeId = id.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120) || 'machine';
  const safeLabel = label.replace(/[^\x20-\x7e]/g, '?').slice(0, 120) || safeId;
  if (!IDENTITY_RE.test(safeId) || !LABEL_RE.test(safeLabel)) throw new RemoteAuthError('invalid_resource', 'invalid agent or machine name');
  return { id: safeId, label: safeLabel };
}

// ── broker client ───────────────────────────────────────────────────────────

interface CreatedRequest { request_id: string; status: BrokerStatus; expires_at: number; approval_url: string; status_url: string }

async function brokerCall<T>(deps: RemoteAuthDeps, apiBase: string, path: string, body: unknown, bearer?: string): Promise<{ status: number; data: T | null; retryAfterMs?: number }> {
  let res: Response;
  try {
    res = await deps.fetch(`${apiBase}${BROKER_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RemoteAuthError('network', 'Could not reach ProAppStore. Check the connection; the command retries on its own while the request is open.');
  }
  const data = await res.json().catch(() => null) as (T & { retry_after_ms?: number }) | null;
  return { status: res.status, data, ...(typeof data?.retry_after_ms === 'number' ? { retryAfterMs: data.retry_after_ms } : {}) };
}

/** The broker answers wrong owner / machine / request, replay and stale state with one generic 409, on purpose. */
function brokerRefusal(status: number): RemoteAuthError {
  if (status === 401) return new RemoteAuthError('not_signed_in', 'Your ProAppStore session is not valid. Run `pas login` on this machine, then try again.');
  if (status === 400) return new RemoteAuthError('failed', 'ProAppStore refused the request as malformed. Update the ProAppStore CLI and try again.');
  if (status === 503) return new RemoteAuthError('failed', 'Remote sign-in is unavailable on ProAppStore right now. Try again later.');
  return new RemoteAuthError('unavailable', 'ProAppStore no longer accepts this sign-in request: it was denied, cancelled, expired or already used, or belongs to another machine. Start a new one.');
}

// ── PAGS relay ──────────────────────────────────────────────────────────────

export interface RelayDetails { request_id: string; agent: Identity; machine: Identity; resource: string; scopes: []; approval_url: string; expires_at: number }
export interface RelayResult { id: string; url: string; state: string; duplicate: boolean }

const RELAY_KEYS = new Set(['request_id', 'agent', 'machine', 'resource', 'scopes', 'approval_url', 'expires_at', 'id', 'label']);

/** Only the documented public fields, at any depth, and an approval URL with no query: anything else is refused before it leaves the machine. */
export function assertRelaySafe(value: unknown, path = ''): void {
  if (Array.isArray(value)) { value.forEach((v, i) => assertRelaySafe(v, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (!RELAY_KEYS.has(key)) throw new RemoteAuthError('relay_refused', `refusing to relay an undocumented field "${path}${key}"`);
      assertRelaySafe(v, `${path}${key}.`);
    }
  }
  if (path === '' && value && typeof value === 'object') {
    const url = new URL((value as RelayDetails).approval_url);
    if (url.protocol !== 'https:' || url.search || url.hash) throw new RemoteAuthError('relay_refused', 'refusing to relay an approval URL with parameters');
  }
}

function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The `pags` CLI must exist and be at least 0.4.121 (the first with `remote-auth`). */
export async function checkPagsVersion(deps: RemoteAuthDeps): Promise<string> {
  let result: Awaited<ReturnType<RemoteAuthDeps['runPags']>>;
  try {
    result = await deps.runPags(['--version']);
  } catch {
    throw new RemoteAuthError('pags_missing', `The ProAgentStore CLI (\`pags\`) was not found. Install or update it to ${MIN_PAGS_VERSION} or later and sign in with \`pags login\`, or pass --no-relay to open the approval link yourself.`);
  }
  const version = parseVersion(result.stdout);
  const min = parseVersion(MIN_PAGS_VERSION)!;
  if (!version || result.code !== 0) throw new RemoteAuthError('old_cli', `Could not read the \`pags\` version. Update the ProAgentStore CLI to ${MIN_PAGS_VERSION} or later.`);
  const older = version[0] !== min[0] ? version[0] < min[0] : version[1] !== min[1] ? version[1] < min[1] : version[2] < min[2];
  if (older) throw new RemoteAuthError('old_cli', `\`pags\` ${version.join('.')} has no \`remote-auth\` command. Update the ProAgentStore CLI to ${MIN_PAGS_VERSION} or later.`);
  return version.join('.');
}

/** `pags remote-auth relay`: exit 2 is a refused input; 1 is transport, retried with the same JSON (a duplicate, no second push). */
export async function relayToAgent(deps: RemoteAuthDeps, details: RelayDetails): Promise<RelayResult> {
  assertRelaySafe(details);
  const input = JSON.stringify(details);
  for (let attempt = 1; ; attempt += 1) {
    const r = await deps.runPags(['remote-auth', 'relay'], input);
    if (r.code === 0) {
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as RelayResult;
      if (typeof parsed.id !== 'string' || typeof parsed.url !== 'string') throw new RemoteAuthError('failed', '`pags remote-auth relay` returned an unexpected answer. Update the ProAgentStore CLI.');
      return parsed;
    }
    if (r.code === 2) throw new RemoteAuthError('relay_refused', 'ProAgentStore refused to relay this request. Update both CLIs and try again.');
    if (attempt >= 3) throw new RemoteAuthError('network', 'Could not reach ProAgentStore to send the approval notification. Use the approval link printed above, or try again.');
    await deps.sleep(POLL_MS * attempt);
  }
}

/** `pags remote-auth state <rar_id> <state>`. Best effort: the page is a view; the broker is authoritative. */
export async function reportRelayState(deps: RemoteAuthDeps, rarId: string, state: BrokerStatus): Promise<boolean> {
  try {
    return (await deps.runPags(['remote-auth', 'state', rarId, state])).code === 0;
  } catch {
    return false;
  }
}

// ── MCP read & local credential store ───────────────────────────────────────

/** A harmless authenticated MCP read (JSON-RPC `initialize`); the MCP worker records it as the broker's connected receipt. */
async function performMcpHealthCheck(deps: RemoteAuthDeps, resource: string, token: string, clientVersion: string): Promise<boolean> {
  try {
    const res = await deps.fetch(resource, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pas-cli-remote-auth', version: clientVersion } },
      }),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

export interface StoredCredential { version: 1; resource: string; token_type: string; access_token: string; expires_at: number; installed_at: number }

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
function file(deps: RemoteAuthDeps, name: string, suffix: string): string {
  if (!NAME_RE.test(name)) throw new RemoteAuthError('invalid_resource', `invalid connection name "${name}"`);
  return join(deps.dir, `${name}${suffix}`);
}

async function ensureDir(deps: RemoteAuthDeps): Promise<void> {
  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  await chmod(deps.dir, 0o700).catch(() => undefined);
}

/** Write a 0600 file atomically: a fresh temp file, then rename. The previous file stays intact until the rename. */
async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${b64(random(6))}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/** Replace the stored credential only now that it is known to work. */
async function installMcpCredential(deps: RemoteAuthDeps, name: string, credential: McpCredential): Promise<void> {
  await ensureDir(deps);
  const now = deps.now();
  await writeAtomic(file(deps, name, '.json'), {
    version: 1, resource: credential.resource, token_type: credential.token_type, access_token: credential.access_token,
    expires_at: now + credential.expires_in * 1000, installed_at: now,
  } satisfies StoredCredential);
}

export async function readCredential(deps: RemoteAuthDeps, name: string): Promise<StoredCredential | null> {
  return readJson<StoredCredential>(file(deps, name, '.json'));
}

/** Local only: forget this machine's stored credential and any open attempt. No global logout. */
export async function disconnect(deps: RemoteAuthDeps, name: string): Promise<boolean> {
  const existed = (await readCredential(deps, name)) !== null;
  await rm(file(deps, name, '.json'), { force: true });
  await rm(file(deps, name, '.attempt.json'), { force: true });
  return existed;
}

// ── one attempt at a time ───────────────────────────────────────────────────

async function acquireLock(deps: RemoteAuthDeps, name: string): Promise<() => Promise<void>> {
  await ensureDir(deps);
  const path = file(deps, name, '.lock');
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: deps.pid, started: deps.now() }));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await readJson<{ pid: number; started: number }>(path);
      if (held && deps.isAlive(held.pid) && deps.now() - held.started < LOCK_STALE_MS) {
        throw new RemoteAuthError('busy', `Another sign-in for "${name}" is already running (process ${held.pid}). Wait for it, or stop it and run the command again.`);
      }
      await rm(path, { force: true }); // stale: its process is gone
    }
  }
  throw new RemoteAuthError('busy', `Another sign-in for "${name}" is already running.`);
}

/** Saved so a restarted machine resumes the same request rather than starting another. 0600; removed when the attempt ends. */
interface Attempt {
  request_id: string; resource: string; approval_url: string; expires_at: number;
  agent: Identity; machine: Identity; rar_id: string | null; reported: BrokerStatus | null;
  secrets: MachineSecrets; redeem_attempt_id: string | null;
}

// ── the flow ────────────────────────────────────────────────────────────────

export interface ConnectOptions {
  apiBase: string;
  /** The owner's PAS session from `pas login`, used only to create the request. */
  bearer: string | null;
  resource: string;
  name: string;
  agent: Identity;
  machine: Identity;
  relay: boolean;
  clientVersion: string;
}

export interface ConnectResult { requestId: string; resource: string; name: string; resumed: boolean }

/**
 * Create (or resume) one request, relay it, wait for the owner, redeem, prove the credential with an
 * authenticated MCP read, install it, and only then report `connected`. The previous credential is
 * replaced only after the read succeeded.
 */
export async function connect(deps: RemoteAuthDeps, opts: ConnectOptions): Promise<ConnectResult> {
  if (opts.relay) await checkPagsVersion(deps);
  const release = await acquireLock(deps, opts.name);
  try {
    return await run(deps, opts);
  } finally {
    await release();
  }
}

async function run(deps: RemoteAuthDeps, opts: ConnectOptions): Promise<ConnectResult> {
  const attemptPath = file(deps, opts.name, '.attempt.json');
  let attempt = await readJson<Attempt>(attemptPath);
  if (attempt && (attempt.expires_at <= deps.now() || attempt.resource !== opts.resource)) {
    if (attempt.rar_id && attempt.expires_at <= deps.now()) await reportRelayState(deps, attempt.rar_id, 'expired');
    await rm(attemptPath, { force: true });
    attempt = null;
  }
  const resumed = attempt !== null;
  const save = async () => { await writeAtomic(attemptPath, attempt); };

  if (!attempt) {
    if (!opts.bearer) throw new RemoteAuthError('not_signed_in', 'This machine has no ProAppStore session. Run `pas login` here first: the request is created with your own account.');
    const secrets = await generateMachineSecrets();
    const created = await brokerCall<CreatedRequest>(deps, opts.apiBase, '/requests', {
      agent: opts.agent, machine: opts.machine, resource: opts.resource, scopes: [],
      code_challenge: secrets.challenge, machine_proof_hash: secrets.proofHash, machine_public_key: secrets.publicKeySpki,
    }, opts.bearer);
    if (created.status !== 201 || !created.data) throw brokerRefusal(created.status);
    attempt = {
      request_id: created.data.request_id, resource: opts.resource, approval_url: created.data.approval_url,
      expires_at: created.data.expires_at, agent: opts.agent, machine: opts.machine, rar_id: null, reported: null,
      secrets, redeem_attempt_id: null,
    };
    await ensureDir(deps);
    await save();
  } else {
    deps.out('Resuming the sign-in request this machine already started.');
  }

  if (opts.relay && !attempt.rar_id) {
    const relayed = await relayToAgent(deps, {
      request_id: attempt.request_id, agent: attempt.agent, machine: attempt.machine, resource: attempt.resource,
      scopes: [], approval_url: attempt.approval_url, expires_at: attempt.expires_at,
    });
    attempt.rar_id = relayed.id;
    attempt.reported = 'pending';
    await save();
    deps.out(`A ProAgentStore notification is on its way to your phone${relayed.duplicate ? ' (already sent)' : ''}: ${relayed.url}`);
  }
  deps.out(`Approve this machine at ProAppStore: ${attempt.approval_url}`);
  deps.out(`Waiting for approval until ${new Date(attempt.expires_at).toISOString()} (Ctrl-C to stop; run the command again to resume).`);

  const report = async (state: BrokerStatus) => {
    if (!attempt!.rar_id || attempt!.reported === state) return;
    if (await reportRelayState(deps, attempt!.rar_id, state)) {
      attempt!.reported = state;
      if (!TERMINAL.has(state)) await save();
    }
  };
  const finish = async (state: BrokerStatus) => {
    await report(state);
    await rm(attemptPath, { force: true });
  };

  // Wait for the owner.
  let delay = POLL_MS;
  let networkFailures = 0;
  let status: BrokerStatus = 'pending';
  while (status !== 'approved_awaiting_machine' && status !== 'consumed') {
    if (deps.now() >= attempt.expires_at) {
      await finish('expired');
      throw new RemoteAuthError('expired', 'The sign-in request expired before it was approved. Run the command again for a new one.');
    }
    await deps.sleep(delay);
    let polled: Awaited<ReturnType<typeof brokerCall<{ status: BrokerStatus; retry_after_ms?: number }>>>;
    try {
      polled = await brokerCall(deps, opts.apiBase, '/requests/poll', { request_id: attempt.request_id, machine_proof: attempt.secrets.proof });
    } catch (e) {
      if (!(e instanceof RemoteAuthError) || e.code !== 'network') throw e;
      networkFailures += 1;
      if (networkFailures >= MAX_NETWORK_FAILURES) throw new RemoteAuthError('network', 'Lost the connection to ProAppStore. Run the command again when online: it resumes the same request.');
      delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
      continue;
    }
    if (polled.status === 429) {
      delay = Math.min(Math.max(polled.retryAfterMs ?? POLL_MS, delay * 2), MAX_POLL_DELAY_MS);
      continue;
    }
    if (polled.status !== 200 || !polled.data) {
      await finish('failed');
      throw brokerRefusal(polled.status);
    }
    networkFailures = 0;
    delay = Math.max(POLL_MS, polled.retryAfterMs ?? POLL_MS);
    status = polled.data.status;
    if (TERMINAL.has(status)) {
      await finish(status);
      if (status === 'denied') throw new RemoteAuthError('denied', 'The sign-in was denied at ProAppStore. Nothing changed on this machine.');
      if (status === 'cancelled') throw new RemoteAuthError('cancelled', 'The sign-in was cancelled at ProAppStore. Nothing changed on this machine.');
      if (status === 'expired') throw new RemoteAuthError('expired', 'The sign-in request expired. Run the command again for a new one.');
      throw new RemoteAuthError('failed', 'The sign-in did not complete at ProAppStore. Run the command again.');
    }
    await report(status);
  }

  // Redeem: one attempt id, kept across retries and restarts, so a lost answer is recovered, never minted twice.
  attempt.redeem_attempt_id ??= b64(random(32));
  await save();
  let envelope: Envelope | null = null;
  for (let tries = 1; !envelope; tries += 1) {
    try {
      const redeemed = await brokerCall<{ credential: Envelope }>(deps, opts.apiBase, '/requests/redeem', {
        request_id: attempt.request_id, machine_proof: attempt.secrets.proof,
        code_verifier: attempt.secrets.verifier, redeem_attempt_id: attempt.redeem_attempt_id,
      });
      if (redeemed.status !== 200 || !redeemed.data?.credential) {
        await finish('failed');
        throw brokerRefusal(redeemed.status);
      }
      envelope = redeemed.data.credential;
    } catch (e) {
      if (!(e instanceof RemoteAuthError) || e.code !== 'network' || tries >= MAX_REDEEM_ATTEMPTS) throw e;
      await deps.sleep(POLL_MS * tries);
    }
  }
  await report('consumed');
  const credential = await openEnvelope(envelope, attempt.secrets.privateKeyPkcs8, attempt.request_id);
  if (credential.resource !== attempt.resource) {
    await reportBrokerFailed(deps, opts, attempt);
    await finish('failed');
    throw new RemoteAuthError('failed', 'ProAppStore returned a credential for a different service. Nothing changed on this machine.');
  }

  // Prove it before it replaces anything.
  if (!(await performMcpHealthCheck(deps, credential.resource, credential.access_token, opts.clientVersion))) {
    await reportBrokerFailed(deps, opts, attempt);
    await finish('failed');
    throw new RemoteAuthError('health_check_failed', 'The new connection could not make an authenticated ProAppStore MCP call. Your previous connection is unchanged. Run the command again.');
  }
  await installMcpCredential(deps, opts.name, credential);

  let acknowledged = false;
  for (let tries = 1; tries <= 3 && !acknowledged; tries += 1) {
    try {
      const done = await brokerCall(deps, opts.apiBase, '/requests/connected', {
        request_id: attempt.request_id, machine_proof: attempt.secrets.proof, code_verifier: attempt.secrets.verifier,
      });
      acknowledged = done.status === 200;
      if (!acknowledged) break;
    } catch {
      await deps.sleep(POLL_MS * tries);
    }
  }
  await finish('connected');
  if (!acknowledged) deps.out('Connected, but ProAppStore did not acknowledge it yet; the request page may not say "connected".');
  return { requestId: attempt.request_id, resource: credential.resource, name: opts.name, resumed };
}

async function reportBrokerFailed(deps: RemoteAuthDeps, opts: ConnectOptions, attempt: Attempt): Promise<void> {
  await brokerCall(deps, opts.apiBase, '/requests/failed', {
    request_id: attempt.request_id, machine_proof: attempt.secrets.proof, code_verifier: attempt.secrets.verifier,
  }).catch(() => undefined);
}
