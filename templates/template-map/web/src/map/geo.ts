/**
 * Web-Mercator geometry for the map view — pure functions, no DOM, no library.
 * Tiles are 256 px; coordinates are in "world pixels" at a given zoom.
 * The tile server is the one `app.maps.staticUrl` already points at
 * (OpenStreetMap, no key). Front it through app.proxy or a tile provider
 * before serving heavy traffic — see README.
 */
export const TILE = 256
export const MIN_ZOOM = 2
export const MAX_ZOOM = 18
export const MAX_LAT = 85.0511

export interface LatLng { lat: number; lng: number }
export interface Bounds { south: number; north: number; west: number; east: number }
export interface Point { x: number; y: number }

export const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
export const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180

/** Lat/lng → world pixel at `zoom`. */
export function project(p: LatLng, zoom: number): Point {
  const scale = TILE * Math.pow(2, zoom)
  const lat = (clampLat(p.lat) * Math.PI) / 180
  return {
    x: ((p.lng + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * scale,
  }
}

/** World pixel at `zoom` → lat/lng. */
export function unproject(pt: Point, zoom: number): LatLng {
  const scale = TILE * Math.pow(2, zoom)
  const lng = (pt.x / scale) * 360 - 180
  const n = Math.PI - (2 * Math.PI * pt.y) / scale
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: wrapLng(lng) }
}

/** The tile URL for z/x/y — same server as app.maps.staticUrl. x wraps around the antimeridian. */
export function tileUrl(z: number, x: number, y: number): string {
  const n = Math.pow(2, z)
  const wx = ((x % n) + n) % n
  return `https://tile.openstreetmap.org/${z}/${wx}/${y}.png`
}

/** The tiles that cover a viewport of `width`×`height` px centred on `center`. */
export function visibleTiles(center: LatLng, zoom: number, width: number, height: number): { z: number; x: number; y: number; left: number; top: number }[] {
  const z = Math.round(zoom)
  const c = project(center, z)
  const originX = c.x - width / 2
  const originY = c.y - height / 2
  const n = Math.pow(2, z)
  const out: { z: number; x: number; y: number; left: number; top: number }[] = []
  for (let x = Math.floor(originX / TILE); x <= Math.floor((originX + width) / TILE); x++) {
    for (let y = Math.max(0, Math.floor(originY / TILE)); y <= Math.min(n - 1, Math.floor((originY + height) / TILE)); y++) {
      out.push({ z, x, y, left: x * TILE - originX, top: y * TILE - originY })
    }
  }
  return out
}

/** Where a point lands on screen for the given view. */
export function toScreen(p: LatLng, center: LatLng, zoom: number, width: number, height: number): Point {
  const c = project(center, zoom)
  const q = project(p, zoom)
  return { x: q.x - c.x + width / 2, y: q.y - c.y + height / 2 }
}

/** The lat/lng under a screen point for the given view. */
export function fromScreen(pt: Point, center: LatLng, zoom: number, width: number, height: number): LatLng {
  const c = project(center, zoom)
  return unproject({ x: c.x + pt.x - width / 2, y: c.y + pt.y - height / 2 }, zoom)
}

/** Geographic bounds of the view — what the map asks the data for. */
export function viewportBounds(center: LatLng, zoom: number, width: number, height: number): Bounds {
  const nw = fromScreen({ x: 0, y: 0 }, center, zoom, width, height)
  const se = fromScreen({ x: width, y: height }, center, zoom, width, height)
  return { south: Math.max(-MAX_LAT, se.lat), north: Math.min(MAX_LAT, nw.lat), west: nw.lng, east: se.lng }
}

/** Centre and zoom that fit every point with some margin; a single point gets a sensible zoom. */
export function fitBounds(points: LatLng[], width: number, height: number, padding = 48): { center: LatLng; zoom: number } {
  if (points.length === 0) return { center: { lat: 0, lng: 0 }, zoom: MIN_ZOOM }
  const lats = points.map((p) => clampLat(p.lat))
  const lngs = points.map((p) => p.lng)
  const south = Math.min(...lats), north = Math.max(...lats), west = Math.min(...lngs), east = Math.max(...lngs)
  const center = { lat: (south + north) / 2, lng: (west + east) / 2 }
  if (points.length === 1) return { center, zoom: 15 }
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const a = project({ lat: north, lng: west }, z)
    const b = project({ lat: south, lng: east }, z)
    if (b.x - a.x <= width - padding * 2 && b.y - a.y <= height - padding * 2) return { center, zoom: z }
  }
  return { center, zoom: MIN_ZOOM }
}

export interface Cluster<T extends LatLng> { key: string; lat: number; lng: number; items: T[] }

/**
 * Grid clustering in screen space: points closer than `cellPx` at this zoom share
 * a cluster. Deterministic and cheap — no library, no state between frames.
 */
export function cluster<T extends LatLng>(points: T[], zoom: number, cellPx = 64): Cluster<T>[] {
  const cells = new Map<string, T[]>()
  for (const p of points) {
    const q = project(p, zoom)
    const key = `${Math.floor(q.x / cellPx)}:${Math.floor(q.y / cellPx)}`
    const list = cells.get(key)
    if (list) list.push(p)
    else cells.set(key, [p])
  }
  return [...cells.entries()].map(([key, items]) => ({
    key,
    lat: items.reduce((s, p) => s + p.lat, 0) / items.length,
    lng: items.reduce((s, p) => s + p.lng, 0) / items.length,
    items,
  }))
}

/** Great-circle distance in km (haversine). */
export function distanceKm(a: LatLng, b: LatLng): number {
  const r = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}
