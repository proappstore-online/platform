/**
 * Maps — geocoding, reverse geocoding, and map embed helpers.
 * Backed by Nominatim (OpenStreetMap) proxied through the PAS API.
 * No Google API keys needed.
 */

export interface GeoResult {
  lat: number;
  lng: number;
  displayName: string;
  address: Record<string, string>;
  type: string;
  importance: number;
}

export interface ReverseResult {
  lat: number;
  lng: number;
  displayName: string;
  address: Record<string, string>;
}

export interface RouteResult {
  /** GeoJSON LineString — coordinates are [lng, lat] pairs (GeoJSON order). */
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distanceMeters: number;
  durationSeconds: number;
}

interface AuthLike {
  token: string | null;
  usesPlatformCookie?: boolean;
  authenticatedFetch?(input: string | URL, init?: RequestInit): Promise<Response>;
}

export class Maps {
  constructor(private readonly apiBase: string, private readonly auth?: AuthLike) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.auth?.token) h['Authorization'] = `Bearer ${this.auth.token}`;
    return h;
  }

  private fetchMap(url: URL, opts?: { signal?: AbortSignal }): Promise<Response> {
    const init: RequestInit = {
      headers: this.headers(),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    };
    if (this.auth?.usesPlatformCookie && this.auth.authenticatedFetch) {
      return this.auth.authenticatedFetch(url, init);
    }
    return fetch(url.toString(), init);
  }

  /** Convert an address string to coordinates. Returns up to `limit` results. */
  async geocode(
    query: string,
    limit = 5,
    opts?: { signal?: AbortSignal },
  ): Promise<GeoResult[]> {
    const url = new URL(`${this.apiBase}/v1/maps/geocode`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));

    const response = await this.fetchMap(url, opts);
    if (!response.ok) throw new Error(`maps.geocode failed: ${response.status}`);

    const data = (await response.json()) as { results: GeoResult[] };
    return data.results;
  }

  /**
   * Driving route between two points. Returns GeoJSON LineString geometry
   * plus distance and duration. Backed by OSRM (OpenStreetMap), proxied
   * through the platform — no API key needed.
   */
  async route(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    opts?: { signal?: AbortSignal },
  ): Promise<RouteResult> {
    const url = new URL(`${this.apiBase}/v1/maps/route`);
    url.searchParams.set('from', `${from.lat},${from.lng}`);
    url.searchParams.set('to', `${to.lat},${to.lng}`);

    const response = await this.fetchMap(url, opts);
    if (!response.ok) throw new Error(`maps.route failed: ${response.status}`);

    return (await response.json()) as RouteResult;
  }

  /** Convert coordinates to an address. */
  async reverseGeocode(
    lat: number,
    lng: number,
    opts?: { signal?: AbortSignal },
  ): Promise<ReverseResult> {
    const url = new URL(`${this.apiBase}/v1/maps/reverse`);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));

    const response = await this.fetchMap(url, opts);
    if (!response.ok) throw new Error(`maps.reverseGeocode failed: ${response.status}`);

    return (await response.json()) as ReverseResult;
  }

  /**
   * Get an OpenStreetMap embed URL for use in an iframe.
   * No API key needed. Free forever.
   *
   * Usage: <iframe src={app.maps.embedUrl(lat, lng, zoom)} />
   */
  embedUrl(lat: number, lng: number, zoom = 15): string {
    const delta = 360 / Math.pow(2, zoom);
    return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - delta},${lat - delta},${lng + delta},${lat + delta}&layer=mapnik&marker=${lat},${lng}`;
  }

  /**
   * Get a static map image URL (no JavaScript needed).
   * Uses OpenStreetMap tile server.
   *
   * Usage: <img src={app.maps.staticUrl(lat, lng)} />
   */
  staticUrl(lat: number, lng: number, zoom = 15): string {
    const clampedLat = Math.max(-85.05, Math.min(85.05, lat));
    const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan((clampedLat * Math.PI) / 180) + 1 / Math.cos((clampedLat * Math.PI) / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  }
}
