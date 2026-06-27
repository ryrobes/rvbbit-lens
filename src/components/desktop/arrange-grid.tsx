"use client"

import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { GripVertical } from "@/lib/icons"
import type { QueryResultColumn, StatementResult } from "@/lib/db/types"
import type { ArrangeRow, ArrangeTile, DataPayload, DesktopParamValue, StatementViewKind } from "@/lib/desktop/types"
import type { CrossFilter } from "@/lib/desktop/reactive-sql"
import { cn } from "@/lib/utils"
import { CardBody, CardMeta, ViewSwitcher, defaultKind, statementKeys } from "./result-transcript"
import type { UiArtifactActionInput, UiArtifactActionResult, UiArtifactParamInput } from "./ui-artifact-view"

// "Arrange" mode as a tiling window manager INSIDE the block: rows top→bottom,
// tiles left→right within each row, every boundary a draggable gutter, the block
// area always fully tiled (flex weights ⇒ 100% fill, no gaps, no overlap). Drag a
// tile's grip to MOVE it (drop on a tile edge to sit beside it, on a row edge to
// make a new row). Persisted as relative weights in DataPayload.statementLayout.rows,
// keyed by statementKeys — so the layout reconciles render-time against the live
// statement set and degrades gracefully when you edit the SQL.

type Layout = NonNullable<DataPayload["statementLayout"]>

const MIN_FRAC = 0.1 // each side of a resized boundary keeps ≥10% of the pair
const EDGE_PX = 14 // top/bottom band of a row that means "drop into a NEW row"
// Hit-test fuzz: must exceed half the 6px gutter so adjacent row/tile bands OVERLAP
// and cover the gutter — otherwise the gutter centre matches no element and the drop
// wrongly falls through to bottom/append. First-match (the earlier element) wins.
const FUZZ = 8

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** One render-time pass: keep live+deduped tiles (collapse emptied rows), then
 *  append any live keys not yet placed as their own bottom row (added/rewritten/
 *  fresh). Never mutates the persisted layout — purely derived each render. */
function reconcile(keys: string[], rows: ArrangeRow[] | undefined): ArrangeRow[] {
  const live = new Set(keys)
  const seen = new Set<string>()
  const out: ArrangeRow[] = []
  for (const row of rows ?? []) {
    const tiles: ArrangeTile[] = []
    for (const t of row.tiles) {
      if (live.has(t.key) && !seen.has(t.key)) {
        seen.add(t.key)
        tiles.push({ key: t.key, w: t.w > 0 ? t.w : 1 })
      }
    }
    if (tiles.length) out.push({ h: row.h > 0 ? row.h : 1, tiles })
  }
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k)
      out.push({ h: 1, tiles: [{ key: k, w: 1 }] })
    }
  }
  return out
}

function pruneRows(rows: ArrangeRow[], live: Set<string>): ArrangeRow[] {
  const seen = new Set<string>()
  const out: ArrangeRow[] = []
  for (const r of rows) {
    const tiles: ArrangeTile[] = []
    for (const t of r.tiles) {
      if (live.has(t.key) && !seen.has(t.key)) {
        seen.add(t.key)
        tiles.push(t)
      }
    }
    if (tiles.length) out.push({ h: r.h, tiles })
  }
  return out
}

// A move drop target, referenced by a STABLE non-dragged tile key (not an index),
// so it survives removing the dragged tile from its source before re-inserting.
type Drop =
  | { pos: "before" | "after"; refKey: string }
  | { pos: "rowBefore" | "rowAfter" | "rowAppend"; refKey: string }
  | { pos: "bottom" }

type LiveResize = { kind: "row" | "tile"; ri: number; iA: number; iB: number; a: number; b: number }

export function ArrangeGrid({
  results,
  views,
  onSetView,
  layout,
  onChangeLayout,
  onCellFilter,
  onChartFilter,
  crossFilters,
  sourceStatements,
  activeParams,
  onEmitParam,
  onRunAction,
}: {
  results: StatementResult[]
  views?: Record<string, StatementViewKind>
  onSetView: (key: string, kind: StatementViewKind) => void
  layout?: Layout
  onChangeLayout: (mut: (prev: Layout) => Layout) => void
  onCellFilter?: (column: QueryResultColumn, value: unknown, stmtIndex: number) => void
  onChartFilter?: (column: QueryResultColumn, values: unknown[], stmtIndex: number) => void
  crossFilters?: CrossFilter[]
  /** Pre-filter statement texts (by index) for STABLE tile keys across a rewrite. */
  sourceStatements?: string[]
  activeParams?: DesktopParamValue[]
  onEmitParam?: (input: UiArtifactParamInput) => void
  onRunAction?: (input: UiArtifactActionInput) => Promise<UiArtifactActionResult>
}) {
  const keys = useMemo(() => statementKeys(results, sourceStatements), [results, sourceStatements])
  const keyToStmt = useMemo(() => {
    const m = new Map<string, StatementResult>()
    keys.forEach((k, i) => m.set(k, results[i]))
    return m
  }, [keys, results])
  const rows = useMemo(() => reconcile(keys, layout?.rows), [keys, layout?.rows])

  const containerRef = useRef<HTMLDivElement>(null)
  const rowEls = useRef<Map<number, HTMLElement>>(new Map())
  const tileEls = useRef<Map<string, HTMLElement>>(new Map())

  const commit = (nextRows: ArrangeRow[]) => {
    const pruned = pruneRows(nextRows, new Set(keys))
    onChangeLayout((prev) => ({ ...prev, mode: "arrange", rows: pruned }))
  }

  const release = (e: React.PointerEvent<Element>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released (e.g. after pointercancel) */
    }
  }

  // ── Resize (drag a gutter; shift weight between the two neighbors only) ──
  const resizeRef = useRef<
    { pointerId: number; kind: "row" | "tile"; ri: number; iA: number; iB: number; sa: number; sb: number; axis: number; start: number } | null
  >(null)
  const movedRef = useRef(false)
  const [liveResize, setLiveResize] = useState<LiveResize | null>(null)
  const liveResizeRef = useRef<LiveResize | null>(null)
  const setLive = (v: LiveResize | null) => {
    liveResizeRef.current = v
    setLiveResize(v)
  }

  const rowGrow = (j: number) => {
    const lr = liveResize
    if (lr?.kind === "row") {
      if (j === lr.iA) return lr.a
      if (j === lr.iB) return lr.b
    }
    return rows[j]?.h ?? 1
  }
  const tileGrow = (ri: number, tj: number) => {
    const lr = liveResize
    if (lr?.kind === "tile" && lr.ri === ri) {
      if (tj === lr.iA) return lr.a
      if (tj === lr.iB) return lr.b
    }
    return rows[ri]?.tiles[tj]?.w ?? 1
  }

  const rowGutterDown = (e: React.PointerEvent<HTMLDivElement>, ri: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sa = rows[ri - 1].h
    const sb = rows[ri].h
    // axis = the two neighbors' COMBINED pixel height, so px↔weight is 1:1 with the
    // seam (the pair only spans part of the container when there are 3+ rows).
    const aPx = rowEls.current.get(ri - 1)?.getBoundingClientRect().height ?? 0
    const bPx = rowEls.current.get(ri)?.getBoundingClientRect().height ?? 0
    const axis = aPx + bPx || containerRef.current?.clientHeight || 1
    movedRef.current = false
    resizeRef.current = { pointerId: e.pointerId, kind: "row", ri, iA: ri - 1, iB: ri, sa, sb, axis, start: e.clientY }
    setLive({ kind: "row", ri, iA: ri - 1, iB: ri, a: sa, b: sb })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const tileGutterDown = (e: React.PointerEvent<HTMLDivElement>, ri: number, ti: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sa = rows[ri].tiles[ti - 1].w
    const sb = rows[ri].tiles[ti].w
    const aPx = tileEls.current.get(rows[ri].tiles[ti - 1].key)?.getBoundingClientRect().width ?? 0
    const bPx = tileEls.current.get(rows[ri].tiles[ti].key)?.getBoundingClientRect().width ?? 0
    const axis = aPx + bPx || rowEls.current.get(ri)?.clientWidth || 1
    movedRef.current = false
    resizeRef.current = { pointerId: e.pointerId, kind: "tile", ri, iA: ti - 1, iB: ti, sa, sb, axis, start: e.clientX }
    setLive({ kind: "tile", ri, iA: ti - 1, iB: ti, a: sa, b: sb })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const gutterMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    movedRef.current = true
    const sum = r.sa + r.sb
    const cur = r.kind === "row" ? e.clientY : e.clientX
    const a = clamp(r.sa + ((cur - r.start) / Math.max(1, r.axis)) * sum, MIN_FRAC * sum, (1 - MIN_FRAC) * sum)
    setLive({ kind: r.kind, ri: r.ri, iA: r.iA, iB: r.iB, a, b: sum - a })
  }
  const gutterUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    resizeRef.current = null
    release(e)
    const lr = liveResizeRef.current
    setLive(null)
    // A plain click (no movement) must not persist an identical-weight no-op write
    // — also stops a double-click from emitting two stale commits before the reset.
    if (!lr || !movedRef.current) return
    const next = rows.map((row, j) => {
      if (lr.kind === "row") {
        if (j === lr.iA) return { ...row, h: lr.a }
        if (j === lr.iB) return { ...row, h: lr.b }
        return row
      }
      if (j !== lr.ri) return row
      return { ...row, tiles: row.tiles.map((t, ti) => (ti === lr.iA ? { ...t, w: lr.a } : ti === lr.iB ? { ...t, w: lr.b } : t)) }
    })
    commit(next)
  }
  const gutterCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== e.pointerId) return
    resizeRef.current = null
    release(e)
    setLive(null)
  }
  // Double-click a gutter → split its two neighbors evenly.
  const rowGutterReset = (ri: number) => {
    const avg = (rows[ri - 1].h + rows[ri].h) / 2
    commit(rows.map((row, j) => (j === ri - 1 || j === ri ? { ...row, h: avg } : row)))
  }
  const tileGutterReset = (ri: number, ti: number) => {
    const avg = (rows[ri].tiles[ti - 1].w + rows[ri].tiles[ti].w) / 2
    commit(rows.map((row, j) => (j !== ri ? row : { ...row, tiles: row.tiles.map((t, k) => (k === ti - 1 || k === ti ? { ...t, w: avg } : t)) })))
  }

  // ── Move (drag the grip; reference-based 4-zone drop) ──
  const dragRef = useRef<{ pointerId: number; key: string } | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)

  const resolveDrop = (px: number, py: number, draggedKey: string): Drop | null => {
    for (let ri = 0; ri < rows.length; ri++) {
      const el = rowEls.current.get(ri)
      if (!el) continue
      const rr = el.getBoundingClientRect()
      if (py < rr.top - FUZZ || py > rr.bottom + FUZZ) continue
      const tiles = rows[ri].tiles
      const refRowKey = tiles.find((t) => t.key !== draggedKey)?.key
      if (py - rr.top < EDGE_PX) return refRowKey ? { pos: "rowBefore", refKey: refRowKey } : null
      if (rr.bottom - py < EDGE_PX) return refRowKey ? { pos: "rowAfter", refKey: refRowKey } : null
      for (const t of tiles) {
        if (t.key === draggedKey) continue
        const tEl = tileEls.current.get(t.key)
        if (!tEl) continue
        const tr = tEl.getBoundingClientRect()
        if (px < tr.left - FUZZ || px > tr.right + FUZZ) continue
        return { pos: px < tr.left + tr.width / 2 ? "before" : "after", refKey: t.key }
      }
      return refRowKey ? { pos: "rowAppend", refKey: refRowKey } : null
    }
    return { pos: "bottom" }
  }

  const gripDown = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { pointerId: e.pointerId, key }
    setDraggingKey(key)
    setDrop(null)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const gripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    setDrop(resolveDrop(e.clientX, e.clientY, d.key))
  }
  const gripUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const target = resolveDrop(e.clientX, e.clientY, d.key)
    dragRef.current = null
    release(e)
    setDraggingKey(null)
    setDrop(null)
    if (target) commit(applyMove(rows, d.key, target))
  }
  const gripCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    release(e)
    setDraggingKey(null)
    setDrop(null)
  }

  // Drop in-flight gesture refs on unmount (mode toggle / re-run remount).
  useEffect(() => () => {
    dragRef.current = null
    resizeRef.current = null
  }, [])

  const tileAccent = (key: string): "left" | "right" | null => {
    if (!drop) return null
    if (drop.pos === "before" && drop.refKey === key) return "left"
    if (drop.pos === "after" && drop.refKey === key) return "right"
    return null
  }
  const rowAccent = (ri: number): "top" | "bottom" | "right" | null => {
    if (!drop || drop.pos === "before" || drop.pos === "after" || drop.pos === "bottom") return null
    if (!rows[ri].tiles.some((t) => t.key === drop.refKey)) return null
    return drop.pos === "rowBefore" ? "top" : drop.pos === "rowAfter" ? "bottom" : "right"
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col bg-doc-bg p-1.5">
      {rows.map((row, ri) => {
        const racc = rowAccent(ri)
        return (
          /* Key by the row's first tile (stable per-row identity), not its full
             membership — else moving a tile remounts both rows' ResultGrids. */
          <Fragment key={row.tiles[0].key}>
            {ri > 0 ? (
              <div
                role="separator"
                title="Drag to resize rows · double-click to even"
                onPointerDown={(e) => rowGutterDown(e, ri)}
                onPointerMove={gutterMove}
                onPointerUp={gutterUp}
                onPointerCancel={gutterCancel}
                onDoubleClick={() => rowGutterReset(ri)}
                className="group/g relative h-1.5 shrink-0 cursor-row-resize touch-none"
              >
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-chrome-border/40 group-hover/g:bg-rvbbit-accent/60" />
              </div>
            ) : null}
            <div
              ref={(el) => {
                if (el) rowEls.current.set(ri, el)
                else rowEls.current.delete(ri)
              }}
              className="relative flex min-h-0"
              style={{ flexGrow: rowGrow(ri), flexShrink: 1, flexBasis: 0 }}
            >
              {racc === "top" ? <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-rvbbit-accent" /> : null}
              {racc === "bottom" ? <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.5 bg-rvbbit-accent" /> : null}
              {racc === "right" ? <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-0.5 bg-rvbbit-accent" /> : null}
              {row.tiles.map((t, ti) => {
                const s = keyToStmt.get(t.key)
                if (!s) return null
                const hasGrid = s.columns.length > 0 && s.rows.length > 0
                const emptySelect = s.columns.length > 0 && s.rows.length === 0
                const kind: StatementViewKind = views?.[t.key] ?? defaultKind(s)
                const acc = tileAccent(t.key)
                return (
                  <Fragment key={t.key}>
                    {ti > 0 ? (
                      <div
                        role="separator"
                        title="Drag to resize · double-click to even"
                        onPointerDown={(e) => tileGutterDown(e, ri, ti)}
                        onPointerMove={gutterMove}
                        onPointerUp={gutterUp}
                        onPointerCancel={gutterCancel}
                        onDoubleClick={() => tileGutterReset(ri, ti)}
                        className="group/g relative w-1.5 shrink-0 cursor-col-resize touch-none"
                      >
                        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-chrome-border/40 group-hover/g:bg-rvbbit-accent/60" />
                      </div>
                    ) : null}
                    <div
                      ref={(el) => {
                        if (el) tileEls.current.set(t.key, el)
                        else tileEls.current.delete(t.key)
                      }}
                      style={{ flexGrow: tileGrow(ri, ti), flexShrink: 1, flexBasis: 0 }}
                      className={cn(
                        "relative flex min-w-0 min-h-0 flex-col overflow-hidden rounded-md border border-chrome-border/70 bg-chrome-bg/40",
                        draggingKey === t.key && "opacity-40",
                      )}
                    >
                      {acc === "left" ? <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-0.5 bg-rvbbit-accent" /> : null}
                      {acc === "right" ? <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-0.5 bg-rvbbit-accent" /> : null}
                      <div className="flex items-center gap-2 border-b border-chrome-border/50 px-1.5 py-1 text-[11px]">
                        <button
                          type="button"
                          title="Drag to move"
                          onPointerDown={(e) => gripDown(e, t.key)}
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
                        {hasGrid ? <ViewSwitcher viewKey={t.key} kind={kind} onSetView={onSetView} /> : null}
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <CardBody
                          s={s}
                          kind={hasGrid ? kind : "table"}
                          hasGrid={hasGrid}
                          emptySelect={emptySelect}
                          fill
                          onCellFilter={onCellFilter ? (c, v) => onCellFilter(c, v, s.index) : undefined}
                          onChartFilter={onChartFilter ? (c, v) => onChartFilter(c, v, s.index) : undefined}
                          highlightFilters={crossFilters?.filter((f) => f.sourceStmtIndex === s.index)}
                          activeParams={activeParams}
                          onEmitParam={onEmitParam}
                          onRunAction={onRunAction}
                          sourceStmtIndex={s.index}
                        />
                      </div>
                    </div>
                  </Fragment>
                )
              })}
            </div>
          </Fragment>
        )
      })}
      {drop?.pos === "bottom" ? <div className="pointer-events-none mt-1 h-0.5 shrink-0 bg-rvbbit-accent" /> : null}
    </div>
  )
}

/** Move `draggedKey` to `target`: detach it (dropping any row it empties), then
 *  re-insert relative to the target's reference tile. The dragged tile keeps its
 *  own width weight; new rows get h:1. Weights are relative, so it renormalizes for
 *  free — no rescaling. */
function applyMove(rows: ArrangeRow[], draggedKey: string, target: Drop): ArrangeRow[] {
  let dragged: ArrangeTile | undefined
  for (const r of rows) {
    const t = r.tiles.find((x) => x.key === draggedKey)
    if (t) {
      dragged = t
      break
    }
  }
  const tile: ArrangeTile = { key: draggedKey, w: dragged?.w && dragged.w > 0 ? dragged.w : 1 }
  const base: ArrangeRow[] = rows
    .map((r) => ({ h: r.h, tiles: r.tiles.filter((t) => t.key !== draggedKey) }))
    .filter((r) => r.tiles.length > 0)

  if (target.pos === "bottom") return [...base, { h: 1, tiles: [tile] }]

  let ri = -1
  let ti = -1
  for (let i = 0; i < base.length; i++) {
    const j = base[i].tiles.findIndex((t) => t.key === target.refKey)
    if (j >= 0) {
      ri = i
      ti = j
      break
    }
  }
  if (ri < 0) return [...base, { h: 1, tiles: [tile] }] // ref vanished → bottom (shouldn't happen)

  const next = base.map((r) => ({ h: r.h, tiles: [...r.tiles] }))
  switch (target.pos) {
    case "before":
      next[ri].tiles.splice(ti, 0, tile)
      break
    case "after":
      next[ri].tiles.splice(ti + 1, 0, tile)
      break
    case "rowAppend":
      next[ri].tiles.push(tile)
      break
    case "rowBefore":
      next.splice(ri, 0, { h: 1, tiles: [tile] })
      break
    case "rowAfter":
      next.splice(ri + 1, 0, { h: 1, tiles: [tile] })
      break
  }
  return next
}
