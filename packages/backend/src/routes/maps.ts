import { Hono, type Context } from 'hono';
import { requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

/**
 * Maps API — geocoding, routing, reverse geocoding proxied through the platform.
 * Uses Nominatim (OpenStreetMap) + OSRM — free, no API key needed.
 * Auth required. Rate-limited: 100 requests per user per hour.
 * Successful answers are edge-cached (#222): Nominatim's usage policy requires
 * caching, and every PAS app shares one upstream identity.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'ProAppStore-Platform/1.0 (https://proappstore.online)';
const MAPS_RATE_LIMIT = 100; // per user per hour
const MAPS_RATE_WINDOW = 3600; // seconds

/** Edge-cache TTLs (#222). Places and addresses change slowly; roads a little faster. */
export const MAPS_CACHE_TTL = { geocode: 7 * 24 * 3600, reverse: 7 * 24 * 3600, route: 24 * 3600 } as const;

export const mapsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Serve `produce()` from the Workers Cache API, keyed on the upstream URL only:
 * answers are not user-specific, so one user's lookup serves the next. Only a
 * 200 is stored. A missing or failing cache falls through to upstream — the
 * cache saves requests, it never fails one.
 */
async function edgeCached(
  c: Context<{ Bindings: Env }>,
  kind: keyof typeof MAPS_CACHE_TTL,
  upstreamUrl: string,
  produce: () => Promise<Response>,
): Promise<Response> {
  const cache = typeof caches === 'undefined' ? undefined : caches.default;
  let key: Request | undefined;
  if (cache) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(upstreamUrl));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      key = new Request(`${new URL(c.req.url).origin}/__maps-cache/${kind}/${hash}`);
      const hit = await cache.match(key);
      // Re-wrapped: a cache match has immutable headers, and CORS middleware appends to them.
      if (hit) return new Response(hit.body, hit);
    } catch (err) {
      console.error(`[maps] cache read failed kind=${kind}`, err instanceof Error ? err.message : err);
    }
  }

  const res = await produce();
  if (res.status !== 200 || !cache || !key) return res;
  const stored = new Response(await res.text(), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${MAPS_CACHE_TTL[kind]}` },
  });
  const put = cache.put(key, stored.clone()).catch((err: unknown) => {
    console.error(`[maps] cache write failed kind=${kind}`, err instanceof Error ? err.message : err);
  });
  try { c.executionCtx.waitUntil(put); } catch { await put; }
  return stored;
}

/** Rate-limit check for maps endpoints. Returns true if over limit. */
async function isRateLimited(db: D1Database, userId: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000) - MAPS_RATE_WINDOW;
  try {
    const row = await db.prepare(
      'SELECT COUNT(*) as n FROM maps_usage WHERE user_id = ? AND ts > ?',
    ).bind(userId, windowStart).first<{ n: number }>();
    return (row?.n ?? 0) >= MAPS_RATE_LIMIT;
  } catch {
    return false; // table might not exist yet
  }
}

async function logMapsUsage(db: D1Database, userId: string): Promise<void> {
  try {
    await db.prepare(
      'INSERT INTO maps_usage (user_id, ts) VALUES (?, ?)',
    ).bind(userId, Math.floor(Date.now() / 1000)).run();
  } catch {
    // table might not exist yet — non-blocking
  }
}

/** Geocode: address string -> lat/lng */
mapsRoutes.get('/maps/geocode', async (c) => {
  const user = await requireUser(c);
  if (await isRateLimited(c.env.DB, user.id)) {
    return c.json({ error: 'rate limit: 100 maps requests per hour' }, 429);
  }
  await logMapsUsage(c.env.DB, user.id);
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q parameter required' }, 400);

  const limit = Math.min(parseInt(c.req.query('limit') || '5'), 10);

  const url = new URL('/search', NOMINATIM_BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');

  return edgeCached(c, 'geocode', url.toString(), async () => {
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
});

/**
 * Driving route between two points. Proxied to OSRM's public demo server
 * (no API key needed). Returns GeoJSON LineString geometry plus distance
 * and duration. Apps draw the geometry as the trip path on a map.
 */
mapsRoutes.get('/maps/route', async (c) => {
  const user = await requireUser(c);
  if (await isRateLimited(c.env.DB, user.id)) {
    return c.json({ error: 'rate limit: 100 maps requests per hour' }, 429);
  }
  await logMapsUsage(c.env.DB, user.id);

  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !to) return c.json({ error: 'from and to required as "lat,lng"' }, 400);

  const parseCoord = (s: string): [number, number] | null => {
    const [latStr, lngStr] = s.split(',');
    const lat = parseFloat(latStr ?? '');
    const lng = parseFloat(lngStr ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return [lat, lng];
  };
  const fromCoord = parseCoord(from);
  const toCoord = parseCoord(to);
  if (!fromCoord || !toCoord) return c.json({ error: 'invalid coordinates' }, 400);

  const [fromLat, fromLng] = fromCoord;
  const [toLat, toLng] = toCoord;
  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}`,
  );
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');

  return edgeCached(c, 'route', url.toString(), async () => {
    const response = await fetch(url.toString(), { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      return c.json({ error: `OSRM error: ${response.status}` }, 502);
    }

    const data = (await response.json()) as {
      code: string;
      routes?: Array<{
        geometry: { type: 'LineString'; coordinates: [number, number][] };
        distance: number;
        duration: number;
      }>;
    };

    if (data.code !== 'Ok' || !data.routes?.[0]) {
      return c.json({ error: 'No route found' }, 404);
    }

    const route = data.routes[0];
    return c.json({
      geometry: route.geometry,
      distanceMeters: route.distance,
      durationSeconds: route.duration,
    });
  });
});

/** Reverse geocode: lat/lng -> address */
mapsRoutes.get('/maps/reverse', async (c) => {
  const user = await requireUser(c);
  if (await isRateLimited(c.env.DB, user.id)) {
    return c.json({ error: 'rate limit: 100 maps requests per hour' }, 429);
  }
  await logMapsUsage(c.env.DB, user.id);

  const lat = c.req.query('lat');
  const lng = c.req.query('lng');
  if (!lat || !lng) return c.json({ error: 'lat and lng parameters required' }, 400);

  const url = new URL('/reverse', NOMINATIM_BASE);
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lng);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');

  return edgeCached(c, 'reverse', url.toString(), async () => {
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
});
