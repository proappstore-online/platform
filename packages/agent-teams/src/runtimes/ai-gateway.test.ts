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
      expect(resolveGateway({ ...ON, AI_GATEWAY_TOKEN: 'sek' }, 'anthropic')).toEqual({
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct123/gw456/anthropic',
        headers: { 'cf-aig-authorization': 'Bearer sek' },
      });
    });
  });
});
