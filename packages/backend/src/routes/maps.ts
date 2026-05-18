import { Hono } from 'hono';
import type { Env } from '../types.js';

/**
 * Maps API — geocoding + reverse geocoding proxied through the platform.
 * Uses Nominatim (OpenStreetMap) — free, no API key needed.
 * Platform proxies to avoid rate limits on individual apps.
 * No auth required for reads (public data).
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'ProAppStore-Platform/1.0 (https://proappstore.online)';

export const mapsRoutes = new Hono<{ Bindings: Env }>();

/** Geocode: address string -> lat/lng */
mapsRoutes.get('/maps/geocode', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q parameter required' }, 400);

  const limit = Math.min(parseInt(c.req.query('limit') || '5'), 10);

  const url = new URL('/search', NOMINATIM_BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    return c.json({ error: `Nominatim error: ${response.status}` }, 502);
  }

  const data = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    address: Record<string, string>;
    type: string;
    importance: number;
  }>;

  const results = data.map((r) => ({
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    displayName: r.display_name,
    address: r.address,
    type: r.type,
    importance: r.importance,
  }));

  return c.json({ results });
});

/** Reverse geocode: lat/lng -> address */
mapsRoutes.get('/maps/reverse', async (c) => {
  const lat = c.req.query('lat');
  const lng = c.req.query('lng');
  if (!lat || !lng) return c.json({ error: 'lat and lng parameters required' }, 400);

  const url = new URL('/reverse', NOMINATIM_BASE);
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lng);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    return c.json({ error: `Nominatim error: ${response.status}` }, 502);
  }

  const r = (await response.json()) as {
    lat: string;
    lon: string;
    display_name: string;
    address: Record<string, string>;
  };

  return c.json({
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    displayName: r.display_name,
    address: r.address,
  });
});
