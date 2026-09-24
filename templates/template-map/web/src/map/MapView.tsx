import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { MAX_ZOOM, MIN_ZOOM, cluster, fromScreen, toScreen, viewportBounds, visibleTiles, tileUrl, type Bounds, type LatLng } from './geo'

export interface MapMarker extends LatLng { id: string; label: string; color?: string }
export interface MapView { center: LatLng; zoom: number }

interface Props {
  view: MapView
  onViewChange: (view: MapView, bounds: Bounds) => void
  markers: MapMarker[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  /** Called with the tapped coordinate when the map is in "place a point" mode. */
  onPick?: (p: LatLng) => void
  picking?: boolean
  /** Shown while the tile layer cannot load (offline). */
  offline?: boolean
  className?: string
}

/**
 * A slippy map with no library: OpenStreetMap raster tiles (the same server
 * app.maps.staticUrl uses), drag / wheel / pinch / keyboard navigation, grid
 * clustering, marker selection. Every control is a real button; the map itself
 * is focusable and arrow-key navigable. The list view is the accessible
 * alternative for the records themselves.
 */
export function MapView({ view, onViewChange, markers, selectedId, onSelect, onPick, picking, offline, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      setSize({ width: Math.round(width), height: Math.round(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const emit = useCallback((next: MapView) => {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next.zoom))
    const v = { center: { lat: Math.max(-85, Math.min(85, next.center.lat)), lng: next.center.lng }, zoom }
    onViewChange(v, viewportBounds(v.center, v.zoom, size.width, size.height))
  }, [onViewChange, size.width, size.height])

  // Report bounds once the element has a size (the first data fetch needs them).
  const sized = size.width > 0 && size.height > 0
  useEffect(() => { if (sized) emit(view) }, [sized]) // eslint-disable-line react-hooks/exhaustive-deps

  const panBy = (dx: number, dy: number) => {
    const c = fromScreen({ x: size.width / 2 - dx, y: size.height / 2 - dy }, view.center, view.zoom, size.width, size.height)
    emit({ center: c, zoom: view.zoom })
  }
  const zoomAt = (delta: number, at?: { x: number; y: number }) => {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + delta))
    if (zoom === view.zoom) return
    if (!at) { emit({ center: view.center, zoom }); return }
    // keep the point under the cursor fixed
    const geo = fromScreen(at, view.center, view.zoom, size.width, size.height)
    const after = toScreen(geo, view.center, zoom, size.width, size.height)
    const c = fromScreen({ x: size.width / 2 + (after.x - at.x), y: size.height / 2 + (after.y - at.y) }, view.center, zoom, size.width, size.height)
    emit({ center: c, zoom })
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: view.zoom }
      drag.current = null
    } else {
      drag.current = { x: e.clientX, y: e.clientY, moved: false }
    }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const zoom = pinch.current.zoom + Math.log2(dist / pinch.current.dist)
      if (Math.abs(zoom - view.zoom) >= 0.25) emit({ center: view.center, zoom: Math.round(zoom) })
      return
    }
    if (!drag.current) return
    const dx = e.clientX - drag.current.x
    const dy = e.clientY - drag.current.y
    if (!drag.current.moved && Math.hypot(dx, dy) < 4) return
    drag.current = { x: e.clientX, y: e.clientY, moved: true }
    panBy(dx, dy)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const rect = ref.current?.getBoundingClientRect()
    if (drag.current && !drag.current.moved && picking && onPick && rect) {
      onPick(fromScreen({ x: e.clientX - rect.left, y: e.clientY - rect.top }, view.center, view.zoom, size.width, size.height))
    }
    drag.current = null
  }
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const rect = ref.current?.getBoundingClientRect()
    zoomAt(e.deltaY < 0 ? 1 : -1, rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = 80
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
      '+': () => zoomAt(1), '=': () => zoomAt(1), '-': () => zoomAt(-1), '_': () => zoomAt(-1),
    }
    const fn = keys[e.key]
    if (fn) { e.preventDefault(); fn() }
  }

  const tiles = useMemo(() => (sized ? visibleTiles(view.center, view.zoom, size.width, size.height) : []), [view, size, sized])
  const clusters = useMemo(() => cluster(markers, view.zoom), [markers, view.zoom])

  return (
    <div
      ref={ref}
      role="application"
      aria-label="Map. Arrow keys pan, plus and minus zoom. The list view offers the same records as text."
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      className={`relative select-none overflow-hidden bg-[var(--paper-deep)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--sky)] ${picking ? 'cursor-crosshair' : 'cursor-grab'} ${className ?? ''}`}
      style={{ touchAction: 'none' }}
    >
      {tiles.map((t) => (
        <img
          key={`${t.z}/${t.x}/${t.y}`}
          src={tileUrl(t.z, t.x, t.y)}
          alt=""
          draggable={false}
          className="pointer-events-none absolute h-64 w-64"
          style={{ left: t.left, top: t.top }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
        />
      ))}
      {sized && clusters.map((c) => {
        const at = toScreen(c, view.center, view.zoom, size.width, size.height)
        if (at.x < -40 || at.y < -40 || at.x > size.width + 40 || at.y > size.height + 40) return null
        if (c.items.length > 1) {
          return (
            <button
              key={c.key}
              type="button"
              aria-label={`${c.items.length} places here, zoom in`}
              onClick={(e) => { e.stopPropagation(); emit({ center: { lat: c.lat, lng: c.lng }, zoom: Math.min(MAX_ZOOM, view.zoom + 2) }) }}
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--paper)] bg-[var(--accent)] px-2 py-1 text-xs font-bold text-white shadow"
              style={{ left: at.x, top: at.y, minWidth: 32 }}
            >
              {c.items.length}
            </button>
          )
        }
        const m = c.items[0]!
        const selected = m.id === selectedId
        return (
          <button
            key={m.id}
            type="button"
            aria-label={m.label}
            aria-pressed={selected}
            onClick={(e) => { e.stopPropagation(); onSelect?.(m.id) }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`absolute -translate-x-1/2 -translate-y-full rounded-full border-2 border-[var(--paper)] shadow transition-transform ${selected ? 'z-10 scale-125' : ''}`}
            style={{ left: at.x, top: at.y, width: 18, height: 18, background: m.color ?? 'var(--accent)' }}
          />
        )
      })}
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1)} onPointerDown={(e) => e.stopPropagation()} className="h-9 w-9 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-strong)] text-lg font-bold text-[var(--ink)]">+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(-1)} onPointerDown={(e) => e.stopPropagation()} className="h-9 w-9 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--panel-strong)] text-lg font-bold text-[var(--ink)]">−</button>
      </div>
      {offline ? <p role="status" className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-[var(--warning-soft)] px-3 py-1 text-xs font-semibold text-[var(--warning)]">Offline — map tiles may not load</p> : null}
      <p className="absolute bottom-0 right-0 rounded-tl bg-[var(--panel-strong)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">© <a href="https://www.openstreetmap.org/copyright" className="underline" onPointerDown={(e) => e.stopPropagation()}>OpenStreetMap</a> contributors</p>
    </div>
  )
}
