import { describe, it, expect } from 'vitest';
import { gatewayEnabled, providerBaseUrl, gatewayHeaders, resolveGateway } from './ai-gateway.ts';

describe('ai-gateway', () => {
  const ON = { AI_GATEWAY_ACCOUNT_ID: 'acct123', AI_GATEWAY_ID: 'gw456' };

  describe('gatewayEnabled', () => {
    it('is false when unconfigured', () => {
      expect(gatewayEnabled({})).toBe(false);
      expect(gatewayEnabled({ AI_GATEWAY_ACCOUNT_ID: 'acct123' })).toBe(false);
      expect(gatewayEnabled({ AI_GATEWAY_ID: 'gw456' })).toBe(false);
    });
    it('is true only when both account + gateway are set', () => {
      expect(gatewayEnabled(ON)).toBe(true);
    });
  });

  describe('providerBaseUrl', () => {
    it('falls back to the provider public API when off', () => {
      expect(providerBaseUrl({}, 'anthropic')).toBe('https://api.anthropic.com');
      expect(providerBaseUrl({}, 'openai')).toBe('https://api.openai.com/v1');
    });
    it('routes through the gateway when on', () => {
      expect(providerBaseUrl(ON, 'anthropic')).toBe('https://gateway.ai.cloudflare.com/v1/acct123/gw456/anthropic');
      expect(providerBaseUrl(ON, 'openai')).toBe('https://gateway.ai.cloudflare.com/v1/acct123/gw456/openai');
    });
    it('preserves the endpoint suffix the callers append', () => {
      // cf-native appends /v1/messages, openai-responses appends /responses —
      // these must resolve to valid URLs in both modes.
      expect(`${providerBaseUrl(ON, 'anthropic')}/v1/messages`)
        .toBe('https://gateway.ai.cloudflare.com/v1/acct123/gw456/anthropic/v1/messages');
      expect(`${providerBaseUrl({}, 'anthropic')}/v1/messages`)
        .toBe('https://api.anthropic.com/v1/messages');
      expect(`${providerBaseUrl(ON, 'openai')}/responses`)
        .toBe('https://gateway.ai.cloudflare.com/v1/acct123/gw456/openai/responses');
      expect(`${providerBaseUrl({}, 'openai')}/responses`)
        .toBe('https://api.openai.com/v1/responses');
    });
  });

  describe('gatewayHeaders', () => {
    it('is empty without a token', () => {
      expect(gatewayHeaders({})).toEqual({});
      expect(gatewayHeaders(ON)).toEqual({});
    });
    it('carries cf-aig-authorization for an authenticated gateway', () => {
      expect(gatewayHeaders({ ...ON, AI_GATEWAY_TOKEN: 'sek' }))
        .toEqual({ 'cf-aig-authorization': 'Bearer sek' });
    });
  });

  describe('resolveGateway', () => {
    it('bundles base url + headers for a provider', () => {
      expect(resolveGateway({ ...ON, AI_GATEWAY_TOKEN: 'sek' }, 'anthropic')).toMatchObject({
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw456/anthropic',
        headers: { 'cf-aig-authorization': 'Bearer sek' },
      });
    });
  });
});

// #22 — outage fallback, strict mode, the shared Anthropic helper, and the
// guarantee that no other module talks to a provider host directly.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAnthropicMessages, anthropicHeaders, directBaseUrl, gatewayFallbackAllowed, isGatewayOutage } from './ai-gateway.ts';

describe('ai-gateway fallback (#22)', () => {
  const GW = { AI_GATEWAY_ACCOUNT_ID: 'acct', AI_GATEWAY_ID: 'gw', AI_GATEWAY_TOKEN: 'gw-tok' };
  const okBody = { id: 'msg', content: [{ type: 'text', text: 'hi' }] };
  const capture = (answers: (Response | Error)[]) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return a;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('classifies outages: network error and edge statuses, never a relayed provider answer', () => {
    for (const s of [null, 502, 503, 504, 520, 522, 530]) expect(isGatewayOutage(s), String(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 429, 500, 531]) expect(isGatewayOutage(s), String(s)).toBe(false);
    expect(directBaseUrl('anthropic')).toBe('https://api.anthropic.com');
    expect(directBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(gatewayFallbackAllowed({})).toBe(true);
    expect(gatewayFallbackAllowed({ AI_GATEWAY_STRICT: '1' })).toBe(false);
    expect(gatewayFallbackAllowed({ AI_GATEWAY_STRICT: 'true' })).toBe(false);
  });

  it('resolveGateway carries the fallback target only when routing via the gateway and not strict', () => {
    expect(resolveGateway(GW, 'anthropic').fallbackBaseUrl).toBe('https://api.anthropic.com');
    expect(resolveGateway({ ...GW, AI_GATEWAY_STRICT: '1' }, 'anthropic').fallbackBaseUrl).toBeNull();
    expect(resolveGateway({}, 'openai').fallbackBaseUrl).toBeNull();
  });

  it('the gateway token goes to the gateway only; the BYO key goes everywhere; extra headers pass through', () => {
    expect(anthropicHeaders(GW, 'sk-byo', 'gateway', { 'anthropic-beta': 'x' })).toEqual({ 'cf-aig-authorization': 'Bearer gw-tok', 'x-api-key': 'sk-byo', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'anthropic-beta': 'x' });
    expect(anthropicHeaders(GW, 'sk-byo', 'gateway-fallback')).not.toHaveProperty('cf-aig-authorization');
    expect(anthropicHeaders(GW, 'sk-byo', 'direct')).not.toHaveProperty('cf-aig-authorization');
  });

  it('fetchAnthropicMessages: gateway when configured, direct when not', async () => {
    const gw = capture([new Response(JSON.stringify(okBody), { status: 200 })]);
    const viaGw = await fetchAnthropicMessages(GW, { apiKey: 'sk-byo', body: { model: 'm' }, fetchImpl: gw.fetchImpl });
    expect(viaGw.route).toBe('gateway');
    expect(gw.calls[0]).toEqual({ url: 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages', headers: expect.objectContaining({ 'cf-aig-authorization': 'Bearer gw-tok', 'x-api-key': 'sk-byo' }) });
    const direct = capture([new Response(JSON.stringify(okBody), { status: 200 })]);
    const viaDirect = await fetchAnthropicMessages({}, { apiKey: 'sk-byo', body: { model: 'm' }, fetchImpl: direct.fetchImpl });
    expect(viaDirect.route).toBe('direct');
    expect(direct.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(direct.calls[0]!.headers).not.toHaveProperty('cf-aig-authorization');
  });

  it('falls back to the direct API once on a gateway outage (503 or network error), dropping the gateway token', async () => {
    for (const first of [new Response('bad gateway', { status: 503 }), new TypeError('fetch failed')]) {
      const c = capture([first, new Response(JSON.stringify(okBody), { status: 200 })]);
      const r = await fetchAnthropicMessages(GW, { apiKey: 'sk-byo', body: { model: 'm' }, fetchImpl: c.fetchImpl });
      expect(r.route).toBe('gateway-fallback');
      expect(r.res.status).toBe(200);
      expect(c.calls.map((x) => x.url)).toEqual(['https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages', 'https://api.anthropic.com/v1/messages']);
      expect(c.calls[1]!.headers).not.toHaveProperty('cf-aig-authorization');
      expect(c.calls[1]!.headers['x-api-key']).toBe('sk-byo');
    }
  });

  it('a relayed provider answer (401, 429, 500) is returned as-is — no second call', async () => {
    for (const status of [401, 429, 500]) {
      const c = capture([new Response(JSON.stringify({ error: { message: 'no' } }), { status })]);
      const r = await fetchAnthropicMessages(GW, { apiKey: 'sk-byo', body: {}, fetchImpl: c.fetchImpl });
      expect(r.route).toBe('gateway');
      expect(r.res.status).toBe(status);
      expect(c.calls).toHaveLength(1);
    }
  });

  it('strict routing surfaces the outage instead of falling back', async () => {
    const c = capture([new Response('', { status: 503 })]);
    const r = await fetchAnthropicMessages({ ...GW, AI_GATEWAY_STRICT: '1' }, { apiKey: 'sk-byo', body: {}, fetchImpl: c.fetchImpl });
    expect(c.calls).toHaveLength(1);
    expect(r.res.status).toBe(503);
    expect(((await r.res.json()) as { error: { message: string } }).error.message).toContain('strict routing forbids the direct fallback');
  });

  it('no module outside this one names a provider host — every LLM call routes through here', () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('ai-gateway.ts')) continue;
        const src = readFileSync(p, 'utf8');
        if (/api\.anthropic\.com|api\.openai\.com/.test(src)) offenders.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    // The two runtimes name the direct host only as the default when no gateway config was threaded (prepare()).
    expect(offenders.sort()).toEqual(['runtimes/cf-native.ts', 'runtimes/openai-responses.ts']);
    for (const f of offenders) {
      const src = readFileSync(join(root, f), 'utf8');
      const hits = src.match(/https:\/\/api\.(anthropic|openai)\.com[^'"`]*/g) ?? [];
      expect(hits, f).toHaveLength(1); // exactly the prepare() default, nothing else
      expect(src).toContain('ctx.gateway?.baseUrl ??');
    }
  });
});
