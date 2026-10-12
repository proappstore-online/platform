import { describe, expect, it } from 'vitest';
import {
  assertRelaySafe, checkPagsVersion, identity, mcpResource, relayToAgent, RemoteAuthError, reportRelayState,
  type RelayDetails, type RemoteAuthDeps,
} from './mcp-remote-auth.js';

// #356: the PAGS relay contract (ProAgentStore docs/remote-auth-relay.md) as this client keeps it:
// only the documented public fields leave the machine; exit 2 is a refusal, 1 is retried with the
// same JSON; state reports are best effort.

const DETAILS: RelayDetails = {
  request_id: `req_${'a'.repeat(43)}`,
  agent: { id: 'codex', label: 'Codex' },
  machine: { id: 'mac-42', label: 'Remote Mac' },
  resource: 'https://mcp.proappstore.online/mcp',
  scopes: [],
  approval_url: `https://api.proappstore.online/v1/mcp/broker/v2/requests/req_${'a'.repeat(43)}/approve`,
  expires_at: 1_800_000_600_000,
};

function pags(exits: number[], calls: { args: string[]; stdin?: string }[] = []): RemoteAuthDeps {
  return {
    fetch: (async () => { throw new Error('no network in relay tests'); }) as typeof fetch,
    runPags: async (args, stdin) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      const code = exits.shift() ?? 0;
      return { code, stdout: code === 0 ? '{"id":"rar_1","url":"https://pags.test/console/remote-auth/rar_1","state":"pending","duplicate":false}\n' : '', stderr: '' };
    },
    sleep: async () => undefined,
    now: () => 0,
    out: () => undefined,
    dir: '/nonexistent',
    pid: 1,
    isAlive: () => false,
  };
}

describe('what may be relayed', () => {
  it('accepts exactly the documented public fields', () => {
    expect(() => assertRelaySafe(DETAILS)).not.toThrow();
  });

  it.each([
    ['a top-level secret', { ...DETAILS, machine_proof: 'x' }],
    ['a nested secret', { ...DETAILS, machine: { ...DETAILS.machine, private_key: 'x' } }],
    ['a verifier', { ...DETAILS, code_verifier: 'x' }],
    ['a token deep in an array', { ...DETAILS, scopes: [{ token: 'x' }] }],
  ])('refuses %s before anything leaves the machine', (_what, details) => {
    const calls: { args: string[] }[] = [];
    expect(() => assertRelaySafe(details)).toThrow(RemoteAuthError);
    return expect(relayToAgent(pags([], calls), details as unknown as RelayDetails)).rejects.toMatchObject({ code: 'relay_refused' }).then(() => expect(calls).toEqual([]));
  });

  it('refuses an approval URL carrying parameters', () => {
    expect(() => assertRelaySafe({ ...DETAILS, approval_url: `${DETAILS.approval_url}?code=x` })).toThrow(/parameters/);
    expect(() => assertRelaySafe({ ...DETAILS, approval_url: 'http://api.proappstore.online/x' })).toThrow(/parameters/);
  });
});

describe('relaying', () => {
  it('sends the request once on stdin and returns the PAGS request', async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    expect(await relayToAgent(pags([0], calls), DETAILS)).toMatchObject({ id: 'rar_1', duplicate: false });
    expect(calls).toEqual([{ args: ['remote-auth', 'relay'], stdin: JSON.stringify(DETAILS) }]);
  });

  it('retries a transport failure (exit 1) with the identical JSON, so PAGS treats it as the same request', async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    await relayToAgent(pags([1, 1, 0], calls), DETAILS);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.stdin)).size).toBe(1);
  });

  it('gives up after three transport failures, and never retries a refusal (exit 2)', async () => {
    await expect(relayToAgent(pags([1, 1, 1]), DETAILS)).rejects.toMatchObject({ code: 'network' });
    const calls: { args: string[] }[] = [];
    await expect(relayToAgent(pags([2], calls), DETAILS)).rejects.toMatchObject({ code: 'relay_refused' });
    expect(calls).toHaveLength(1);
  });

  it('reports a state as `pags remote-auth state <id> <state>`, and a failed report is not fatal', async () => {
    const calls: { args: string[] }[] = [];
    expect(await reportRelayState(pags([0], calls), 'rar_1', 'approved_awaiting_machine')).toBe(true);
    expect(calls[0]!.args).toEqual(['remote-auth', 'state', 'rar_1', 'approved_awaiting_machine']);
    expect(await reportRelayState(pags([1]), 'rar_1', 'connected')).toBe(false);
    const broken = { ...pags([]), runPags: async () => { throw new Error('gone'); } };
    expect(await reportRelayState(broken, 'rar_1', 'connected')).toBe(false);
  });
});

describe('preflight', () => {
  it.each([['0.4.121', true], ['pags 0.4.130', true], ['0.5.0', true], ['1.0.0', true], ['0.4.120', false], ['0.3.999', false]])('pags %s supported: %s', async (version, ok) => {
    const deps = { ...pags([]), runPags: async () => ({ code: 0, stdout: version, stderr: '' }) };
    if (ok) await expect(checkPagsVersion(deps)).resolves.toBeTruthy();
    else await expect(checkPagsVersion(deps)).rejects.toMatchObject({ code: 'old_cli' });
  });

  it('the resource is exactly /mcp or /mcp/apps/:appId on an https origin', () => {
    expect(mcpResource('https://mcp.proappstore.online/')).toBe('https://mcp.proappstore.online/mcp');
    expect(mcpResource('https://mcp.proappstore.online', 'stash')).toBe('https://mcp.proappstore.online/mcp/apps/stash');
    expect(() => mcpResource('https://mcp.proappstore.online', 'Bad/App')).toThrow(RemoteAuthError);
    expect(() => mcpResource('http://mcp.proappstore.online')).toThrow(/https/);
  });

  it('agent and machine names are made broker-safe', () => {
    expect(identity('Serge\'s MacBook Pro', 'Serge’s MacBook Pro')).toEqual({ id: 'Serge-s-MacBook-Pro', label: 'Serge?s MacBook Pro' });
  });
});
