/**
 * The map geometry (web/src/map/geo.ts) — projection round-trips, tiles, viewport
 * bounds, fitting and clustering. Runs the TypeScript directly with Node's type
 * stripping; no build step, no browser.
 *
 *   node --no-warnings --experimental-strip-types qa/geo.mjs
 */
import { project, unproject, tileUrl, visibleTiles, viewportBounds, fitBounds, cluster, distanceKm, toScreen, fromScreen } from '../web/src/map/geo.ts'

let failures = 0
const ok = (pass, what) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`); if (!pass) failures++ }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

const melb = { lat: -37.8136, lng: 144.9631 }
const back = unproject(project(melb, 12), 12)
ok(near(back.lat, melb.lat) && near(back.lng, melb.lng), 'project / unproject round-trips')
ok(project({ lat: 0, lng: 0 }, 0).x === 128 && project({ lat: 0, lng: 0 }, 0).y === 128, 'the origin is the centre of the single zoom-0 tile')
ok(tileUrl(3, 9, 2) === 'https://tile.openstreetmap.org/3/1/2.png', 'tile x wraps around the antimeridian')
ok(tileUrl(3, -1, 2) === 'https://tile.openstreetmap.org/3/7/2.png', 'negative tile x wraps too')

const tiles = visibleTiles(melb, 12, 800, 600)
ok(tiles.length >= 12 && tiles.length <= 20, `a 800×600 viewport needs ~12–20 tiles (${tiles.length})`)
ok(tiles.every((t) => t.z === 12 && t.left > -256 && t.top > -256 && t.left < 800 && t.top < 600), 'every tile overlaps the viewport')

const b = viewportBounds(melb, 12, 800, 600)
ok(b.south < melb.lat && melb.lat < b.north && b.west < melb.lng && melb.lng < b.east, 'the centre lies inside the viewport bounds')
const s = toScreen(melb, melb, 12, 800, 600)
ok(near(s.x, 400) && near(s.y, 300), 'the centre projects to the middle of the screen')
const f = fromScreen({ x: 400, y: 300 }, melb, 12, 800, 600)
ok(near(f.lat, melb.lat) && near(f.lng, melb.lng), 'fromScreen inverts toScreen')

const fit = fitBounds([{ lat: -37.81, lng: 144.96 }, { lat: -37.86, lng: 144.98 }], 800, 600)
ok(fit.zoom >= 10 && fit.zoom <= 14, `fitBounds picks a sensible zoom for two nearby points (${fit.zoom})`)
ok(fitBounds([melb], 800, 600).zoom === 15, 'a single point gets zoom 15')
ok(fitBounds([], 800, 600).zoom === 2, 'no points falls back to the world')

const pts = [{ id: 'a', lat: -37.8102, lng: 144.9628 }, { id: 'b', lat: -37.8171, lng: 144.9700 }, { id: 'c', lat: -37.7940, lng: 144.9450 }, { id: 'd', lat: 10, lng: 10 }]
const low = cluster(pts, 8)
ok(low.length === 2 && low.some((c) => c.items.length === 3), 'at low zoom the three nearby points cluster and the far one stands alone')
ok(cluster(pts, 16).length === 4, 'at high zoom every point is its own marker')
ok(low.every((c) => c.items.length === 1 || (c.lat < -37 && c.lng > 144)), 'a cluster sits among its members')

const mel2syd = distanceKm({ lat: -37.8136, lng: 144.9631 }, { lat: -33.8688, lng: 151.2093 })
ok(mel2syd > 700 && mel2syd < 730, `haversine: Melbourne → Sydney ≈ 714 km (${mel2syd.toFixed(1)})`)

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
