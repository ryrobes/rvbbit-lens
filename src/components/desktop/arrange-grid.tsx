"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { GripVertical } from "@/lib/icons"
import type { StatementResult } from "@/lib/db/types"
import type { DataPayload, StatementViewKind } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"
import { CardBody, CardMeta, ViewSwitcher, defaultKind, statementKeys } from "./result-transcript"

// "Arrange" mode for a multi-statement block: the same per-statement cards as the
// transcript, laid out in a bento CSS grid the user can REORDER (drag the grip)
// and RESIZE (drag the corner, snapped to grid units). Reflow keeps tiles packed
// with no overlap and no empty-space management — the grid is the layout engine,
// so the only persisted state is a key order + sparse per-tile {cw,rh} spans.
// Everything reconciles render-time against the live statement key set, so editing
// the SQL (add/remove/reorder/rewrite statements) degrades gracefully.

type Layout = NonNullable<DataPayload["statementLayout"]>
type Span = { cw: number; rh: number }

const ROW_UNIT = 80 // px per grid row; integer rh spans multiply this
const GAP = 6 // px (gap-1.5)
const MAX_RH = 8

function colsForWidth(w: number): number {
  return w < 520 ? 2 : w < 860 ? 3 : w < 1200 ? 4 : 6
}

/** A fresh tile's span is a pure function of its view kind so a first Arrange looks
 *  sensible with zero clicks. Read-time default; never stored. */
function defaultSpan(kind: StatementViewKind): Span {
  if (kind === "number") return { cw: 1, rh: 1 }
  if (kind === "bar" || kind === "line") return { cw: 2, rh: 2 }
  return { cw: 2, rh: 3 } // table
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

export function ArrangeGrid({
  results,
  views,
  onSetView,
  layout,
  onChangeLayout,
}: {
  results: StatementResult[]
  views?: Record<string, StatementViewKind>
  onSetView: (key: string, kind: StatementViewKind) => void
  layout?: Layout
  onChangeLayout: (mut: (prev: Layout) => Layout) => void
}) {
  const keys = useMemo(() => statementKeys(results), [results])
  const keyToStmt = useMemo(() => {
    const m = new Map<string, StatementResult>()
    keys.forEach((k, i) => m.set(k, results[i]))
    return m
  }, [keys, results])

  // Effective reading order: persisted order ∩ live keys, then any new keys appended
  // in statement-index order. Stale keys never render.
  const order = useMemo(() => {
    const live = new Set(keys)
    const seen = new Set<string>()
    const kept: string[] = []
    for (const k of layout?.order ?? []) {
      // Filter to live keys AND dedupe (a corrupted payload could repeat a key,
      // which would render two tiles with the same React key).
      if (live.has(k) && !seen.has(k)) {
        seen.add(k)
        kept.push(k)
      }
    }
    return [...kept, ...keys.filter((k) => !seen.has(k))]
  }, [keys, layout?.order])

  // Responsive column count from the container width (clamp-on-read for tile cw).
  const containerRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(4)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setCols(colsForWidth(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const spanOf = (key: string, s: StatementResult): Span => {
    const hasGrid = s.columns.length > 0 && s.rows.length > 0
    const stored = layout?.tiles?.[key]
    // No-grid (DML/DDL) cards have an empty body, so they default to a compact 1×1
    // instead of a big empty table-sized tile — unless the user explicitly resized.
    const base = stored ?? (hasGrid ? defaultSpan(views?.[key] ?? defaultKind(s)) : { cw: 1, rh: 1 })
    return { cw: clampInt(base.cw, 1, cols), rh: clampInt(base.rh, 1, MAX_RH) }
  }

  // Commit a layout change, pruning stale order/tiles entries to the live keys so
  // the payload never accrues cruft (render-time filtering already guarantees
  // correctness; this just keeps it tidy on write).
  const commit = (mut: (prev: Layout) => Layout) => {
    const live = new Set(keys)
    onChangeLayout((prev) => {
      const next = mut(prev ?? {})
      if (next.order) next.order = next.order.filter((k) => live.has(k))
      if (next.tiles) {
        const t: Record<string, Span> = {}
        for (const k of Object.keys(next.tiles)) if (live.has(k)) t[k] = next.tiles[k]
        next.tiles = t
      }
      return next
    })
  }

  // ── Reorder (drag the grip; insertion index by reading-order hit-test) ──
  const tileEls = useRef<Map<string, HTMLElement>>(new Map())
  const dragRef = useRef<{ pointerId: number; key: string } | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const insertIndex = (px: number, py: number, draggedKey: string): number => {
    let before = 0
    for (const key of order) {
      if (key === draggedKey) continue
      const el = tileEls.current.get(key)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      // Use the tile's OWN rect (tiles span 1..8 rows): it's "before the cursor" in
      // reading order if the cursor is below its bottom edge (a later row), or within
      // its vertical extent and right of its horizontal midpoint (same row, to the left).
      const inRow = py >= r.top && py <= r.bottom
      if (r.bottom < py || (inRow && cx < px)) before++
    }
    return before
  }

  const gripDown = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { pointerId: e.pointerId, key }
    setDraggingKey(key)
    setDropIndex(null)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const gripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    setDropIndex(insertIndex(e.clientX, e.clientY, d.key))
  }
  const release = (e: React.PointerEvent<HTMLButtonElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released (e.g. after pointercancel) */
    }
  }
  const gripUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const idx = insertIndex(e.clientX, e.clientY, d.key)
    dragRef.current = null
    release(e)
    setDraggingKey(null)
    setDropIndex(null)
    const without = order.filter((k) => k !== d.key)
    const next = [...without.slice(0, idx), d.key, ...without.slice(idx)]
    commit((prev) => ({ ...prev, order: next }))
  }
  // Interrupted drag (touch/OS gesture takeover): reset, do NOT commit a reorder.
  const gripCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    release(e)
    setDraggingKey(null)
    setDropIndex(null)
  }

  // ── Resize (drag the corner; snap to integer grid spans) ──
  const resizeRef = useRef<{ pointerId: number; key: string; startX: number; startY: number; startCw: number; startRh: number } | null>(null)
  const [liveResize, setLiveResize] = useState<{ key: string; cw: number; rh: number } | null>(null)
  const liveResizeRef = useRef<{ key: string; cw: number; rh: number } | null>(null)
  const setLive = (v: { key: string; cw: number; rh: number } | null) => {
    liveResizeRef.current = v
    setLiveResize(v)
  }

  const resizeDown = (e: React.PointerEvent<HTMLButtonElement>, key: string, span: Span) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { pointerId: e.pointerId, key, startX: e.clientX, startY: e.clientY, startCw: span.cw, startRh: span.rh }
    setLive({ key, cw: span.cw, rh: span.rh })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const resizeMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    const cw0 = containerRef.current?.clientWidth ?? 800
    const colPitch = Math.max(1, cw0 / cols)
    const rowPitch = ROW_UNIT + GAP
    const dCols = Math.round((e.clientX - r.startX) / colPitch)
    const dRows = Math.round((e.clientY - r.startY) / rowPitch)
    setLive({ key: r.key, cw: clampInt(r.startCw + dCols, 1, cols), rh: clampInt(r.startRh + dRows, 1, MAX_RH) })
  }
  const resizeUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    resizeRef.current = null
    release(e)
    const lr = liveResizeRef.current
    setLive(null)
    if (lr) commit((prev) => ({ ...prev, tiles: { ...(prev?.tiles ?? {}), [r.key]: { cw: lr.cw, rh: lr.rh } } }))
  }
  // Interrupted resize: reset, do NOT commit a span.
  const resizeCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== e.pointerId) return
    resizeRef.current = null
    release(e)
    setLive(null)
  }

  // If the grid unmounts mid-gesture (mode toggle or re-run remount), drop the
  // in-flight refs so nothing dangles on a detached node.
  useEffect(() => () => {
    dragRef.current = null
    resizeRef.current = null
  }, [])

  const withoutDragged = draggingKey != null ? order.filter((k) => k !== draggingKey) : order
  const dropBeforeKey =
    draggingKey != null && dropIndex != null ? withoutDragged[dropIndex] ?? null : null
  // Appending past the last tile → no dropBeforeKey; show a trailing end-marker.
  const appendingAtEnd =
    draggingKey != null && dropIndex != null && dropBeforeKey == null && dropIndex >= withoutDragged.length

  return (
    <div
      ref={containerRef}
      className="grid h-full content-start gap-1.5 overflow-y-auto bg-doc-bg p-1.5"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${ROW_UNIT}px` }}
    >
      {order.map((key) => {
        const s = keyToStmt.get(key)
        if (!s) return null
        const hasGrid = s.columns.length > 0 && s.rows.length > 0
        const emptySelect = s.columns.length > 0 && s.rows.length === 0
        const kind: StatementViewKind = views?.[key] ?? defaultKind(s)
        const span = liveResize?.key === key ? { cw: liveResize.cw, rh: liveResize.rh } : spanOf(key, s)
        return (
          <div
            key={key}
            ref={(el) => {
              if (el) tileEls.current.set(key, el)
              else tileEls.current.delete(key)
            }}
            style={{ gridColumn: `span ${Math.min(span.cw, cols)}`, gridRow: `span ${span.rh}` }}
            className={cn(
              "relative flex min-w-0 flex-col overflow-hidden rounded-md border border-chrome-border/70 bg-chrome-bg/40",
              draggingKey === key && "opacity-40",
              dropBeforeKey === key && "ring-2 ring-rvbbit-accent",
            )}
          >
            <div className="flex items-center gap-2 border-b border-chrome-border/50 px-1.5 py-1 text-[11px]">
              <button
                type="button"
                title="Drag to reorder"
                onPointerDown={(e) => gripDown(e, key)}
                onPointerMove={gripMove}
                onPointerUp={gripUp}
                onPointerCancel={gripCancel}
                className="shrink-0 cursor-grab touch-none text-chrome-text/35 hover:text-foreground active:cursor-grabbing"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <CardMeta s={s} />
              </div>
              {hasGrid ? <ViewSwitcher viewKey={key} kind={kind} onSetView={onSetView} /> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <CardBody s={s} kind={hasGrid ? kind : "table"} hasGrid={hasGrid} emptySelect={emptySelect} fill />
            </div>
            <button
              type="button"
              title="Drag to resize"
              onPointerDown={(e) => resizeDown(e, key, span)}
              onPointerMove={resizeMove}
              onPointerUp={resizeUp}
              onPointerCancel={resizeCancel}
              className="absolute bottom-0 right-0 grid h-4 w-4 cursor-se-resize touch-none place-items-center text-chrome-text/30 hover:text-foreground"
            >
              <span className="block h-1.5 w-1.5 border-b-2 border-r-2 border-current" />
            </button>
          </div>
        )
      })}
      {appendingAtEnd ? (
        <div style={{ gridColumn: "1 / -1" }} className="h-1 self-start rounded-full bg-rvbbit-accent" />
      ) : null}
    </div>
  )
}
