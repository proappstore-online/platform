import { afterEach, describe, expect, it, vi } from 'vitest';
import { Maps } from './maps.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Maps', () => {
  it('sends legacy bearer auth for geocode requests', async () => {
    const fetchMock = vi.fn(async () => Response.json({ results: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const maps = new Maps('https://api.proappstore.online', { token: 'tok_map' });
    await maps.geocode('Melbourne', 3);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.proappstore.online/v1/maps/geocode?q=Melbourne&limit=3');
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe('Bearer tok_map');
  });

  it('uses authenticatedFetch for platform-cookie geocode requests', async () => {
    const authenticatedFetch = vi.fn(async () => Response.json({ results: [] }));
    const maps = new Maps('https://api.proappstore.online', {
      token: null,
      usesPlatformCookie: true,
      authenticatedFetch,
    });

    await maps.geocode('Melbourne', 2);

    expect(authenticatedFetch).toHaveBeenCalledOnce();
    const [url, init] = authenticatedFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.proappstore.online/v1/maps/geocode?q=Melbourne&limit=2');
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBeNull();
  });

  it('uses authenticatedFetch for platform-cookie route and reverse geocode requests', async () => {
    const authenticatedFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        geometry: { type: 'LineString', coordinates: [[144.96, -37.81], [145, -37.8]] },
        distanceMeters: 100,
        durationSeconds: 30,
      }))
      .mockResolvedValueOnce(Response.json({
        lat: -37.81,
        lng: 144.96,
        displayName: 'Melbourne',
        address: {},
      }));
    const maps = new Maps('https://api.proappstore.online', {
      token: null,
      usesPlatformCookie: true,
      authenticatedFetch,
    });

    await maps.route({ lat: -37.81, lng: 144.96 }, { lat: -37.8, lng: 145 });
    await maps.reverseGeocode(-37.81, 144.96);

    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(String(authenticatedFetch.mock.calls[0]![0])).toBe(
      'https://api.proappstore.online/v1/maps/route?from=-37.81%2C144.96&to=-37.8%2C145',
    );
    expect(String(authenticatedFetch.mock.calls[1]![0])).toBe(
      'https://api.proappstore.online/v1/maps/reverse?lat=-37.81&lng=144.96',
    );
  });
});
