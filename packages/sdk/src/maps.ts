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

export class Maps {
  constructor(private readonly apiBase: string) {}

  /** Convert an address string to coordinates. Returns up to `limit` results. */
  async geocode(query: string, limit = 5): Promise<GeoResult[]> {
    const url = new URL(`${this.apiBase}/v1/maps/geocode`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));

    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`maps.geocode failed: ${response.status}`);

    const data = (await response.json()) as { results: GeoResult[] };
    return data.results;
  }

  /** Convert coordinates to an address. */
  async reverseGeocode(lat: number, lng: number): Promise<ReverseResult> {
    const url = new URL(`${this.apiBase}/v1/maps/reverse`);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));

    const response = await fetch(url.toString());
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
    return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.01},${lat - 0.01},${lng + 0.01},${lat + 0.01}&layer=mapnik&marker=${lat},${lng}`;
  }

  /**
   * Get a static map image URL (no JavaScript needed).
   * Uses OpenStreetMap tile server.
   *
   * Usage: <img src={app.maps.staticUrl(lat, lng)} />
   */
  staticUrl(lat: number, lng: number, zoom = 15): string {
    const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  }
}
