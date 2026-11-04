import { fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { googleJson } from '../../../backend/src/lib/google-calendar-common';

beforeEach(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });

// Exercise real workerd Request/fetch construction: Node mocks accept redirect:
// 'error', which Workers rejects before contacting the OAuth provider.
describe('Google Calendar provider transport on workerd', () => {
  it('sends an OAuth form and reads a provider response', async () => {
    fetchMock.get('https://oauth2.googleapis.com').intercept({
      path: '/token', method: 'POST', body: 'grant_type=authorization_code&code=synthetic',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    }).reply(200, { access_token: 'synthetic-access' });
    await expect(googleJson('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'synthetic' }),
    })).resolves.toEqual({ access_token: 'synthetic-access' });
    fetchMock.assertNoPendingInterceptors();
  });

  it('refuses redirects without forwarding credentials to the destination', async () => {
    fetchMock.get('https://openidconnect.googleapis.com').intercept({ path: '/v1/userinfo' })
      .reply(302, '', { headers: { location: 'https://unexpected.example/steal' } });
    // Only the original Google request is permitted; the mock network rejects
    // any other destination. Consuming this interceptor proves fetch was sent.
    await expect(googleJson('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer synthetic-access' },
    })).rejects.toThrow('google_unavailable');
    fetchMock.assertNoPendingInterceptors();
  });
});
