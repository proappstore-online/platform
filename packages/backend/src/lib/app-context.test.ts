import { describe, expect, it } from 'vitest';
import {
  APP_CONTEXT_HEADER,
  APP_HOST_HEADER,
  HOST_SESSION_INVALIDATION_HEADER,
  HOST_SESSION_INVALIDATION_ID_HEADER,
  withoutHostContext,
} from './app-context.js';

// #315: what the default fetch export does to every request that is not the host's.
describe('withoutHostContext', () => {
  it('drops every host-only context header in any case, and keeps everything else', async () => {
    const req = new Request('https://api.test/v1/apps/a/logs', {
      method: 'POST',
      headers: {
        'x-pas-app': 'b',
        'X-PAS-Host': 'b.proappstore.online',
        [HOST_SESSION_INVALIDATION_HEADER]: 'api_401',
        [HOST_SESSION_INVALIDATION_ID_HEADER]: 'a'.repeat(32),
        Authorization: 'Bearer t',
        'Content-Type': 'application/json',
      },
      body: '{"entries":[]}',
    });
    const out = withoutHostContext(req);
    expect(out.headers.has(APP_CONTEXT_HEADER)).toBe(false);
    expect(out.headers.has(APP_HOST_HEADER)).toBe(false);
    expect(out.headers.has(HOST_SESSION_INVALIDATION_HEADER)).toBe(false);
    expect(out.headers.has(HOST_SESSION_INVALIDATION_ID_HEADER)).toBe(false);
    expect(out.headers.get('Authorization')).toBe('Bearer t');
    expect(out.method).toBe('POST');
    expect(out.url).toBe('https://api.test/v1/apps/a/logs');
    expect(await out.text()).toBe('{"entries":[]}');
  });

  it('returns the request itself when it carries neither header', () => {
    const req = new Request('https://api.test/health');
    expect(withoutHostContext(req)).toBe(req);
  });
});
