import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { CONSOLE_STEP_UP_AUDIENCE, PLATFORM_RP_ID, mediatedRelyingParty, passkeyRelyingParty } from './relying-party.js';

// #698, #699: one relying-party decision for every passkey route and step_up audience.
const probe = new Hono<{ Bindings: Env }>();
probe.get('/rp', (c) => {
  try {
    return c.json(passkeyRelyingParty(c));
  } catch (e) {
    if (e instanceof HttpError) return c.json({ refused: e.message }, 400);
    throw e;
  }
});
probe.get('/mediated', (c) => c.json({ rpId: mediatedRelyingParty(c) ?? null }));

const rp = async (headers: Record<string, string>) => (await probe.request('/rp', { headers })).json();
const mediated = async (headers: Record<string, string>) => ((await (await probe.request('/mediated', { headers })).json()) as { rpId: string | null }).rpId;

describe('passkeyRelyingParty (#698, #699)', () => {
  it('the Console uses the shared credential RP id, and its own step-up audience, on both Console hosts', async () => {
    expect(PLATFORM_RP_ID).toBe('proappstore.online');
    expect(CONSOLE_STEP_UP_AUDIENCE).toBe('proappstore.online');
    expect(await rp({ Origin: 'https://console.proappstore.online' }))
      .toEqual({ name: 'ProAppStore', id: 'proappstore.online', audience: 'proappstore.online', origin: 'https://console.proappstore.online' });
    expect(await rp({ Origin: 'https://proappstore.online' }))
      .toEqual({ name: 'ProAppStore', id: 'proappstore.online', audience: 'proappstore.online', origin: 'https://proappstore.online' });
  });

  it('a mediated app on the platform zone shares the credential RP id, but its audience and origin are its own hostname', async () => {
    expect(await rp({ 'X-PAS-App': 'stash', 'X-PAS-Host': 'Stash.proappstore.online' }))
      .toEqual({ name: 'ProAppStore', id: 'proappstore.online', audience: 'stash.proappstore.online', origin: 'https://stash.proappstore.online' });
  });

  it('an app on a custom domain keeps its own hostname as credential RP id and audience', async () => {
    expect(await rp({ 'X-PAS-App': 'shop', 'X-PAS-Host': 'shop.example.com' }))
      .toEqual({ name: 'shop', id: 'shop.example.com', audience: 'shop.example.com', origin: 'https://shop.example.com' });
    // A lookalike that merely ends in the platform name is not on the platform zone.
    expect(await rp({ 'X-PAS-App': 'shop', 'X-PAS-Host': 'evilproappstore.online' }))
      .toEqual({ name: 'shop', id: 'evilproappstore.online', audience: 'evilproappstore.online', origin: 'https://evilproappstore.online' });
  });

  it('refuses every other origin, and any request carrying host context for the Console', async () => {
    for (const headers of [
      {},
      { Origin: 'https://stash.proappstore.online' },
      { Origin: 'https://proappstore-console.pages.dev' },
      { Origin: 'http://proappstore.online' },
      { Origin: 'https://proappstore.online.evil.com' },
      { Origin: 'https://console.proappstore.online/' },
      // The cookie data plane: X-PAS-App without X-PAS-Host.
      { Origin: 'https://console.proappstore.online', 'X-PAS-App': 'stash' },
      { Origin: 'https://proappstore.online', 'X-PAS-Host': 'stash.proappstore.online' },
      // A mediated hostname the Console's relying party covers never becomes an app's.
      { 'X-PAS-App': 'stash', 'X-PAS-Host': 'proappstore.online' },
      { 'X-PAS-App': 'stash', 'X-PAS-Host': 'console.proappstore.online' },
      { 'X-PAS-App': 'stash', 'X-PAS-Host': 'not a host' },
    ]) {
      expect(await rp(headers), JSON.stringify(headers)).toEqual({ refused: 'passkeys are only available on an app origin or the console' });
    }
  });
});

describe('mediatedRelyingParty (#331, #698)', () => {
  it("is the host-asserted app hostname, never the Console's audience", async () => {
    expect(await mediated({ 'X-PAS-Host': 'demo.proappstore.online' })).toBe('demo.proappstore.online');
    expect(await mediated({ 'X-PAS-Host': 'shop.example.com' })).toBe('shop.example.com');
    expect(await mediated({})).toBeNull();
    expect(await mediated({ 'X-PAS-Host': 'proappstore.online' })).toBeNull();
    expect(await mediated({ 'X-PAS-Host': 'CONSOLE.proappstore.online' })).toBeNull();
    expect(await mediated({ 'X-PAS-Host': '-bad.example' })).toBeNull();
  });
});
