"use client"

import { useEffect, useRef, useState } from "react"
import {
  Activity,
  Boxes,
  Calculator,
  Calendar,
  ChevronDown,
  Flag,
  GitBranch,
  Grip,
  Hash,
  Layers,
  Maximize2,
  Minus,
  Sigma,
  Sparkles,
  Table2,
  Tag,
  TreeStructure,
  TrendingUp,
  X,
  type LucideIcon,
} from "@/lib/icons"
import {
  readColumnDragPayload,
  useActiveColumnDragSource,
} from "@/lib/desktop/column-drag"
import {
  readBlockDragPayload,
  useActiveBlockDragSource,
  type ActiveBlockDragSource,
} from "@/lib/desktop/block-drag"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { availableRollupOps, isNumericRef } from "@/lib/desktop/sql-builder"
import {
  availableDimensionOps,
  availableSemanticOps,
  availableRowsetOps,
  groupScalarTilesByReturnType,
  placeholderShapeOps,
  returnTypeChip,
  returnTypeIcon,
  type SemanticOpTile,
} from "@/lib/desktop/semantic-ops"
import { DropTargetCard, type DropTargetInfo } from "./drop-target-card"
import { rowsetOpIcon } from "./rowset-op-palette"
import type {
  DesktopBlockDragPayload,
  DesktopColumnDragPayload,
  DesktopWindowState,
  RollupMeasure,
  RollupOp,
  SemanticOpMeta,
} from "@/lib/desktop/types"
import { cn } from "@/lib/utils"
import { SemanticOperatorTooltip } from "./semantic-operator-tooltip"

function rollupOpKey(op: RollupOp): string {
  if (op.kind === "measure") return `measure:${op.agg}`
  if (op.kind === "pivot") return `pivot:${op.measureIds?.join(",") ?? "all"}:${op.grain ?? ""}`
  if (op.kind === "group-by") return `group-by:${op.grain ?? ""}`
  return op.kind
}

function rollupOpIcon(op: RollupOp): LucideIcon {
  if (op.kind === "group-by") return op.grain ? Calendar : Layers
  if (op.kind === "order-by") return Table2
  if (op.kind === "pivot") return TreeStructure
  if (op.kind === "semantic-op") return Table2 // never reached (semantic tiles render separately); for totality
  switch (op.agg) {
    case "sum": return Sigma
    case "avg": return Calculator
    case "min": return ChevronDown
    case "max": return TrendingUp
    case "count": return Hash
    case "count_distinct": return Boxes
    // median / stddev / variance are reachable only via the shelf, never
    // as drop tiles, so they don't need a dedicated tile icon.
    default: return Sigma
  }
}

/** Plain-language explanation of a vanilla rollup drop target, for the hover card. */
function rollupOpDescription(op: RollupOp): string {
  if (op.kind === "group-by") {
    return op.grain
      ? `Bucket this date column by ${op.grain} and group rows into one row per ${op.grain}.`
      : "Group rows by this column — one row per distinct value."
  }
  if (op.kind === "order-by") return "Sort the result by this column."
  if (op.kind === "pivot") return "Spread this column's distinct values across columns (cross-tab)."
  if (op.kind !== "measure") return "Apply this operator to the column."
  switch (op.agg) {
    case "sum": return "Total this column within each group."
    case "avg": return "Average this column within each group."
    case "min": return "Smallest value in each group."
    case "max": return "Largest value in each group."
    case "count": return "Count non-null values in each group."
    case "count_distinct": return "Count distinct values in each group."
    default: return "Aggregate this column within each group."
  }
}

interface DesktopWindowProps {
  window: DesktopWindowState
  /** Presentation-only title override; persisted window identity is unchanged. */
  displayTitle?: string
  icon: LucideIcon
  children: React.ReactNode
  /** True when this window currently holds keyboard/visual focus. */
  focused: boolean
  /** A changing token mounts a short, high-contrast assistant callout over the
   *  window without changing its persisted focus/chrome state. */
  attentionToken?: number | null
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMinimize: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, width: number, height: number) => void
  viewportScale?: number
  /**
   * When set, the window can receive column drags whose source matches
   * this identity (same parent window + same source relation). A faint
   * outer ring shows on every compatible window during a drag; a strong
   * outer glow appears on the one the cursor is over.
   */
  columnDropAcceptsFrom?: {
    parentWindowId: string
    relationKey: string
    /** Existing measures of this block — drives the per-measure pivot tiles. */
    measures: RollupMeasure[]
  } | null
  /**
   * Called when a compatible column drag is dropped on one of the
   * type-aware operation tiles (or the fallback default zone).
   */
  onColumnMerge?: (payload: DesktopColumnDragPayload, op: RollupOp) => void
  /** Scalar semantic operator catalog (rvbbit.operators) for the on-block tiles. */
  semanticOps?: SemanticOpMeta[]
  /** Drop a semantic op onto this block's column — routed via the host so it
   *  can run a bind step for multi-arg ops before mutating the block. */
  onSemanticDrop?: (
    payload: DesktopColumnDragPayload,
    op: SemanticOpMeta,
    at: { x: number; y: number },
    targetWindowId?: string,
  ) => void
  /** Drop a rowset op onto THIS window's own block chip — chains a
   *  `then op('…')` pipeline stage onto the current block in place. */
  onRowsetChain?: (
    payload: DesktopBlockDragPayload,
    op: SemanticOpMeta,
    at: { x: number; y: number },
  ) => void
  /**
   * Tile mode: an EPHEMERAL rect this window renders at instead of its
   * stored geometry. Stored x/y/width/height are untouched — toggling
   * tile mode off restores the real layout because nothing ever moved.
   * While set, header-drag and the resize grip are inert (the window
   * itself stays fully interactive).
   */
  tileRect?: { x: number; y: number; width: number; height: number } | null
  /** Animate geometry changes (tile enter/exit) with a CSS transition. */
  geometryAnimated?: boolean
}

const MIN_WIDTH = 320
const MIN_HEIGHT = 220
const MAX_WIDTH = 2400
const MAX_HEIGHT = 1800
const MIN_WORLD = -20000
const MAX_WORLD = 20000

export function DesktopWindow({
  window: w,
  displayTitle,
  icon: Icon,
  children,
  focused,
  attentionToken,
  onFocus,
  onClose,
  onMinimize,
  onMove,
  onResize,
  viewportScale = 1,
  columnDropAcceptsFrom,
  onColumnMerge,
  semanticOps,
  onSemanticDrop,
  onRowsetChain,
  tileRect,
  geometryAnimated,
}: DesktopWindowProps) {
  const chrome = windowChrome(w.kind)
  // Present (read-only) mode: drop the editor chrome (title-bar buttons, drag,
  // resize) and render as a clean card. Content + interactions are untouched.
  const present = usePresentMode()
  const activeColumnDrag = useActiveColumnDragSource()
  const columnDragCompatible = !!columnDropAcceptsFrom
    && !!activeColumnDrag
    && activeColumnDrag.parentWindowId === columnDropAcceptsFrom.parentWindowId
    && activeColumnDrag.relationKey === columnDropAcceptsFrom.relationKey
  // `columnDragHover` → cursor is somewhere over the drop overlay (drives
  // the strong outer glow). `hoveredOpKey` → which specific tile is hot.
  const [columnDragHover, setColumnDragHover] = useState(false)
  const [hoveredOpKey, setHoveredOpKey] = useState<string | null>(null)
  // Detail card shown beside the panel while a tile is hovered mid-drag.
  const [hoverCard, setHoverCard] = useState<{ info: DropTargetInfo; tileRect: DOMRect; panelRect: DOMRect | null } | null>(null)
  const [semanticHover, setSemanticHover] = useState<{
    op: SemanticOpMeta
    title: string
    signature: string
    note: string
    accent: string
    tileRect: DOMRect
    panelRect: DOMRect | null
  } | null>(null)
  // Block-drag: when THIS window's own block chip is being dragged, offer rowset
  // tiles to chain a `then op('…')` stage onto this very block (in place). The
  // overlay is deferred (armed on the first dragover) so mounting it over the
  // drag source doesn't abort the native drag — the same fix the floating
  // palette uses.
  const activeBlockDrag = useActiveBlockDragSource()
  const isOwnBlockDrag = !!activeBlockDrag && activeBlockDrag.windowId === w.id && !!onRowsetChain
  // Arm on the active-source OBJECT IDENTITY (a fresh object per dragstart), not
  // a stable key. A stable key (windowId:blockName) would still match on the
  // *next* drag of the same block, so the overlay would mount at dragstart,
  // cover the chip, and abort the drag — leaving chips undraggable until a
  // refresh. Object identity differs every drag, so the deferral re-applies.
  const [blockArmedFor, setBlockArmedFor] = useState<ActiveBlockDragSource | null>(null)
  useEffect(() => {
    if (!isOwnBlockDrag || !activeBlockDrag) return
    const arm = () => setBlockArmedFor(activeBlockDrag)
    window.addEventListener("dragover", arm, { once: true })
    return () => window.removeEventListener("dragover", arm)
  }, [isOwnBlockDrag, activeBlockDrag])
  const blockChainArmed = isOwnBlockDrag && blockArmedFor === activeBlockDrag
  const rowsetTiles = blockChainArmed ? availableRowsetOps(semanticOps ?? []) : []
  const draggedColumns = activeColumnDrag?.columns ?? []
  const rollupTiles = columnDragCompatible
    ? availableRollupOps(draggedColumns, columnDropAcceptsFrom?.measures ?? [])
    : []
  const baseTiles = rollupTiles.filter((t) => t.group !== "pivot")
  const pivotTiles = rollupTiles.filter((t) => t.group === "pivot")
  // Semantic-op tiles ride in the SAME compatible-target overlay as the rollup
  // tiles (never the source window — that aborts the drag). On a row-level
  // target the drop adds the projection in place; on an aggregate target the
  // host spawns a new projection block (different grain).
  const semanticTiles: SemanticOpTile[] = columnDragCompatible
    ? availableSemanticOps(draggedColumns, semanticOps ?? [])
    : []
  // Dimension tiles: fan-out ops (themes/tags/…) — dropping spawns a frequency
  // table. They activate the DIMENSION band (otherwise a "soon" placeholder).
  const dimensionTiles: SemanticOpTile[] = columnDragCompatible
    ? availableDimensionOps(draggedColumns, semanticOps ?? [])
    : []
  // Scalar tiles split by what they return (label / flag / score) for the
  // Scalar band's sub-rails; the other shapes surface as labeled "soon"
  // placeholder bands (names only) so every shape has a stable home.
  const scalarGroups = groupScalarTilesByReturnType(semanticTiles)
  const shapePlaceholders = columnDragCompatible
    ? placeholderShapeOps(semanticOps ?? [])
    : { aggregate: [], dimension: [], wholeResult: [] }
  // Default op for a drop on the cluster backdrop (not a specific tile):
  // sum for numeric drags, group-by otherwise — matches the old one-shot.
  const defaultRollupOp: RollupOp = draggedColumns.some(isNumericRef)
    ? { kind: "measure", agg: "sum" }
    : { kind: "group-by" }
  const resetColumnDragState = () => {
    setColumnDragHover(false)
    setHoveredOpKey(null)
    setHoverCard(null)
    setSemanticHover(null)
  }
  const draggedColName = draggedColumns.length === 1 ? draggedColumns[0]?.name ?? "col" : "cols"

  // Mark a tile hot + raise its detail card. Guarded on `hoveredOpKey` so the
  // per-frame dragover storm only rebuilds the card on a real tile change.
  // Rects come from the live event/DOM (the panel is found via `closest`, not a
  // React ref, so this stays clear of the render-phase ref lint). `build` is
  // lazy so the info is only computed on a real change.
  function setHotTile(e: React.DragEvent, key: string, build: () => DropTargetInfo) {
    if (hoveredOpKey === key) return
    setHoveredOpKey(key)
    setSemanticHover(null)
    const tile = e.currentTarget as HTMLElement
    const panel = tile.closest("[data-drop-panel]")
    setHoverCard({
      info: build(),
      tileRect: tile.getBoundingClientRect(),
      panelRect: panel?.getBoundingClientRect() ?? null,
    })
  }

  function setHotSemanticTile(
    e: React.DragEvent,
    key: string,
    op: SemanticOpMeta,
    title: string,
    signature: string,
    note: string,
    accent: string,
  ) {
    if (hoveredOpKey === key) return
    setHoveredOpKey(key)
    setHoverCard(null)
    const tile = e.currentTarget as HTMLElement
    const panel = tile.closest("[data-drop-panel]")
    setSemanticHover({
      op,
      title,
      signature,
      note,
      accent,
      tileRect: tile.getBoundingClientRect(),
      panelRect: panel?.getBoundingClientRect() ?? null,
    })
  }

  function rollupTileInfo(tile: { op: RollupOp; label: string; hint: string }): DropTargetInfo {
    return {
      icon: rollupOpIcon(tile.op),
      title: tile.label,
      accent: `oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h))`,
      description: rollupOpDescription(tile.op),
      signature: tile.hint,
    }
  }

  function renderRollupTile(tile: { op: RollupOp; label: string; hint: string }, fullWidth: boolean) {
    const key = rollupOpKey(tile.op)
    const Icon = rollupOpIcon(tile.op)
    const hot = hoveredOpKey === key
    const accent = `oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h))`
    return (
      <div
        key={key}
        title={tile.hint}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setHotTile(e, key, () => rollupTileInfo(tile)) }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = "copy"
          setHotTile(e, key, () => rollupTileInfo(tile))
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          resetColumnDragState()
          const payload = readColumnDragPayload(e.dataTransfer)
          if (payload && onColumnMerge) onColumnMerge(payload, tile.op)
        }}
        className={cn(
          "flex cursor-copy select-none items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors",
          fullWidth ? "col-span-full py-1.5" : "flex-col justify-center gap-1 py-2",
          hot
            ? "border-transparent text-foreground"
            : "border-chrome-border/50 bg-foreground/[0.03] text-chrome-text hover:bg-foreground/[0.06]",
        )}
        style={hot ? {
          backgroundColor: `oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h) / 0.22)`,
          boxShadow: `inset 0 0 0 1.5px oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h) / 0.9)`,
        } : undefined}
      >
        <Icon className="h-4 w-4 shrink-0" style={{ color: accent }} />
        <span className="w-full truncate text-center leading-tight">{tile.label}</span>
      </div>
    )
  }

  function renderSemanticTile(tile: SemanticOpTile) {
    const key = `semantic:${tile.op.operator.name}`
    const hot = hoveredOpKey === key
    const accent = "var(--viz-op-pipeline)"
    // Dimension (fan-out) tiles read as Layers; scalar tiles show their return-type glyph.
    const Icon = tile.op.operator.shape === "dimension" ? Layers : returnTypeIcon(tile.returnType)
    const signature = semanticSignature(tile, draggedColName)
    const note = semanticNote(tile)
    return (
      <div
        key={key}
        title={tile.hint}
        onDragEnter={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setHotSemanticTile(e, key, tile.op.operator, tile.label, signature, note, accent)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = "copy"
          setHotSemanticTile(e, key, tile.op.operator, tile.label, signature, note, accent)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          resetColumnDragState()
          const payload = readColumnDragPayload(e.dataTransfer)
          if (payload && onSemanticDrop) onSemanticDrop(payload, tile.op.operator, { x: e.clientX, y: e.clientY }, w.id)
        }}
        className={cn(
          "relative flex cursor-copy select-none flex-col items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-medium transition-colors",
          hot
            ? "border-transparent text-foreground"
            : "border-chrome-border/50 bg-foreground/[0.03] text-chrome-text hover:bg-foreground/[0.06]",
        )}
        style={hot ? {
          backgroundColor: `color-mix(in oklch, ${accent} 22%, transparent)`,
          boxShadow: `inset 0 0 0 1.5px ${accent}`,
        } : undefined}
      >
        <Icon className="h-4 w-4 shrink-0" style={{ color: accent }} />
        <span className="w-full truncate text-center leading-tight">
          {tile.label}
          {tile.needsArgs ? <span className="text-chrome-text/45">…</span> : null}
        </span>
        {/* return-type glyph in the corner — what the new column will be */}
        <span className="absolute right-1 top-1 font-mono text-[8px] text-chrome-text/40">
          {returnTypeChip(tile.returnType)}
        </span>
      </div>
    )
  }

  // Rowset (pipeline) tile in the on-own-block "chain" overlay. Dropping it
  // appends a `then op('…')` stage to THIS block (in place) via onRowsetChain.
  function renderRowsetChainTile(tile: { op: SemanticOpMeta; label: string; hint: string }) {
    const key = `rowset:${tile.op.name}`
    const hot = hoveredOpKey === key
    const accent = "var(--viz-op-rowset)"
    const Icon = rowsetOpIcon(tile.op.name)
    const signature = `... then ${tile.op.name}('<prompt>')`
    const note = rowsetTooltipNote(tile.op)
    return (
      <div
        key={key}
        title={tile.hint}
        onDragEnter={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setHotSemanticTile(e, key, tile.op, tile.label, signature, note, accent)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = "copy"
          setHotSemanticTile(e, key, tile.op, tile.label, signature, note, accent)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          resetColumnDragState()
          const payload = readBlockDragPayload(e.dataTransfer)
          if (payload && onRowsetChain) onRowsetChain(payload, tile.op, { x: e.clientX, y: e.clientY })
        }}
        className={cn(
          "relative flex cursor-copy select-none flex-col items-center justify-center gap-1 rounded-md border px-1.5 py-2 text-[11px] font-medium transition-colors",
          hot
            ? "border-transparent text-foreground"
            : "border-chrome-border/50 bg-foreground/[0.03] text-chrome-text hover:bg-foreground/[0.06]",
        )}
        style={hot ? {
          backgroundColor: `color-mix(in oklch, ${accent} 22%, transparent)`,
          boxShadow: `inset 0 0 0 1.5px ${accent}`,
        } : undefined}
      >
        <Icon className="h-4 w-4 shrink-0" style={{ color: accent }} />
        <span className="w-full truncate text-center leading-tight">{tile.label}</span>
      </div>
    )
  }

  // A band header: an uppercase label flanked by hairline rules. `chrome` tone
  // for vanilla SQL, `operators` tone (brand accent) for the semantic band.
  function bandDivider(
    label: string,
    opts?: { tone?: "chrome" | "operators"; icon?: LucideIcon; caption?: string },
  ) {
    const isOp = opts?.tone === "operators"
    const Icon = opts?.icon
    const ruleStyle = isOp
      ? { backgroundColor: "color-mix(in oklch, var(--viz-op-pipeline) 50%, transparent)" }
      : undefined
    return (
      <div
        className={cn(
          "col-span-full mt-0.5 flex items-center gap-2 px-1 text-[9px] uppercase tracking-wider",
          !isOp && "text-chrome-text/60",
        )}
        style={isOp ? { color: "var(--viz-op-pipeline)" } : undefined}
      >
        {Icon ? <Icon className="h-3 w-3 shrink-0" /> : null}
        <span className="shrink-0">{label}</span>
        <span className={cn("h-px flex-1", !isOp && "bg-chrome-border/60")} style={ruleStyle} />
        {opts?.caption ? (
          <span className="shrink-0 normal-case tracking-normal text-chrome-text/45">{opts.caption}</span>
        ) : null}
      </div>
    )
  }

  // Lightweight sub-rail label inside the Scalar band (Labels / Flags / Scores).
  // Lighter than a band divider so the hierarchy reads band > sub-rail.
  function subRail(Icon: LucideIcon, label: string, count: number) {
    return (
      <div className="col-span-full flex items-center gap-1 px-1 pt-0.5 text-[9px] text-chrome-text/55">
        <Icon className="h-2.5 w-2.5 shrink-0" style={{ color: "var(--viz-op-pipeline)" }} />
        <span>{label}</span>
        <span className="text-chrome-text/35">{count}</span>
      </div>
    )
  }

  // A "coming soon" band for a shape whose interaction model isn't wired up
  // yet (aggregate → measure, dimension → group-by, rowset → whole-result).
  // Non-interactive; lists the catalog op names so the taxonomy is taught
  // before the feature ships. Collapses to nothing when no ops of that shape
  // exist (data-gated), so a thin catalog never shows empty frames.
  function placeholderBand(Icon: LucideIcon, label: string, sub: string, names: string[], hint: string) {
    if (names.length === 0) return null
    return (
      <div
        title={`${label} · ${sub} — ${hint} (not yet available)`}
        className="col-span-full mt-0.5 pointer-events-none flex select-none items-center gap-1.5 px-1 text-[9px] text-chrome-text/40"
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="shrink-0 uppercase tracking-wider">{label}</span>
        <span className="min-w-0 flex-1 truncate normal-case tracking-normal text-chrome-text/35">
          {names.slice(0, 5).join(" · ")}
          {names.length > 5 ? " …" : ""}
          <span className="text-chrome-text/25"> · {hint}</span>
        </span>
        <span className="shrink-0 rounded-sm bg-foreground/[0.04] px-1 text-[8px] lowercase text-chrome-text/45">soon</span>
      </div>
    )
  }

  // Aspect-aware sizing. SQL result windows are usually wider than tall, so a
  // tall vertical stack forces a scrollbar — and you can't scroll mid-drag.
  // Instead we flow every tile into ONE grid and choose the column count that
  // makes the content fit the window's *height*, spending the window's *width*
  // (the axis we can spare) rather than scrolling. Shorter window / more tiles
  // ⇒ more columns ⇒ a wider, flatter panel.
  const scalarSubrails = [scalarGroups.text, scalarGroups.bool, scalarGroups.float8].filter((g) => g.length > 0)
  // The DIMENSION band is ACTIVE (real tiles) when dimension ops surface for
  // this column — so it's not counted as a placeholder then.
  // whole-result (rowset) is handled via the block-chip drag, not a column drop,
  // so it's intentionally NOT a column-overlay placeholder.
  const placeholderCount = [
    shapePlaceholders.aggregate,
    dimensionTiles.length > 0 ? [] : shapePlaceholders.dimension,
  ].filter((n) => n.length > 0).length
  // Rough per-element heights (px) for the fit estimate.
  const TILE_H = 44, HEAD_H = 18, SUBRAIL_H = 16, PIVOT_H = 30, PLACEHOLDER_H = 16
  const estPanelHeight = (
    cols: number,
    opts: { placeholders?: boolean; subrails?: boolean } = {},
  ) => {
    const withPlaceholders = opts.placeholders ?? true
    const withSubrails = opts.subrails ?? true
    let h = HEAD_H // dragged-column caption
    if (rollupTiles.length > 0) {
      h += HEAD_H + Math.ceil(baseTiles.length / cols) * TILE_H + pivotTiles.length * PIVOT_H
    }
    if (semanticTiles.length > 0) {
      h += HEAD_H
      if (withSubrails) {
        for (const g of scalarSubrails) h += SUBRAIL_H + Math.ceil(g.length / cols) * TILE_H
      } else {
        h += Math.ceil(semanticTiles.length / cols) * TILE_H // one packed grid
      }
    }
    if (dimensionTiles.length > 0) h += HEAD_H + Math.ceil(dimensionTiles.length / cols) * TILE_H
    if (withPlaceholders) h += placeholderCount * PLACEHOLDER_H
    return h
  }
  // Width budget → the most columns we *could* fit; height budget → the fewest
  // that fit without scrolling. Prefer the fewest-that-fit (biggest tiles),
  // defaulting to a comfortable 4 and widening only when height-constrained.
  const maxColsByWidth = Math.max(2, Math.min(10, Math.floor((w.width * 0.94 - 24) / 96)))
  const minCols = Math.min(4, maxColsByWidth)
  const availPanelH = Math.max(140, w.height * 0.9 - 40)
  let gridCols = maxColsByWidth
  for (let c = minCols; c <= maxColsByWidth; c++) {
    if (estPanelHeight(c) <= availPanelH) { gridCols = c; break }
  }
  // Panel is exactly as wide as `gridCols` tiles need, clamped to the window.
  const panelWidthPx = Math.min(Math.round(w.width * 0.94), gridCols * 112 + 24)
  const winCapH = Math.round(w.height * 0.92)
  // The informational "soon" placeholder bands are non-droppable, so they're
  // the first thing to drop when the window is too short to also fit the real
  // tiles without scrolling — droppable tiles win the height budget.
  const showPlaceholders = estPanelHeight(gridCols) <= winCapH
  // Still too tall even without placeholders? Collapse the return-type
  // sub-rails into one packed scalar grid (each tile keeps its type glyph), to
  // reclaim ~3 header rows on a very short window.
  const denseScalar = !showPlaceholders && estPanelHeight(gridCols, { placeholders: false }) > winCapH

  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const resizeRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originWidth: number
    originHeight: number
  } | null>(null)

  // Drag/resize are applied to LOCAL state during the gesture and committed to
  // shell state only on pointer-up. This keeps the desktop-wide `workspaces`
  // object — and therefore every other window across all slots — from
  // re-rendering on every mousemove frame; only this window's chrome moves,
  // and its content (passed as `children`) keeps its identity so it doesn't
  // re-render either. The mirror refs let pointer-up read the final value
  // without a stale-closure read of state.
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null)
  const [liveSize, setLiveSize] = useState<{ width: number; height: number } | null>(null)
  const livePosRef = useRef<{ x: number; y: number } | null>(null)
  const liveSizeRef = useRef<{ width: number; height: number } | null>(null)
  function applyLivePos(p: { x: number; y: number } | null) {
    livePosRef.current = p
    setLivePos(p)
  }
  function applyLiveSize(s: { width: number; height: number } | null) {
    liveSizeRef.current = s
    setLiveSize(s)
  }

  function clamp(v: number) {
    if (!Number.isFinite(v)) return 0
    return Math.min(MAX_WORLD, Math.max(MIN_WORLD, v))
  }

  function onHeaderDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    onFocus(w.id)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: w.x,
      originY: w.y,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onHeaderMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const s = Math.max(0.2, viewportScale)
    applyLivePos({
      x: clamp(d.originX + (e.clientX - d.startX) / s),
      y: clamp(d.originY + (e.clientY - d.startY) / s),
    })
  }
  function onHeaderUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released (e.g. pointercancel) */ }
    const p = livePosRef.current
    if (p) onMove(w.id, p.x, p.y) // commit once; batched with applyLivePos(null) below
    applyLivePos(null)
  }

  function onResizeDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onFocus(w.id)
    resizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originWidth: w.width,
      originHeight: w.height,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onResizeMove(e: React.PointerEvent<HTMLButtonElement>) {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    const s = Math.max(0.2, viewportScale)
    const nw = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, r.originWidth + (e.clientX - r.startX) / s))
    const nh = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, r.originHeight + (e.clientY - r.startY) / s))
    applyLiveSize({ width: nw, height: nh })
  }
  function onResizeUp(e: React.PointerEvent<HTMLButtonElement>) {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    resizeRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released (e.g. pointercancel) */ }
    const sz = liveSizeRef.current
    if (sz) onResize(w.id, sz.width, sz.height) // commit once
    applyLiveSize(null)
  }

  if (w.minimized) return null

  return (
    <section
      data-rvbbit-window
      data-rvbbit-window-id={w.id}
      data-focused={focused ? "true" : "false"}
      data-column-drop={columnDragCompatible ? (columnDragHover ? "hover" : "ready") : undefined}
      className={cn(
        // `group/window` lets content surfaces (datagrids, editors) react to
        // this window's focus state via `group-data-[focused=…]/window:` —
        // e.g. a grid stays opaque when focused but glass-tints when not.
        "group/window pointer-events-auto absolute overflow-hidden rounded-md border",
        geometryAnimated
          ? "transition-[left,top,width,height,background-color,backdrop-filter,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          : "transition-[background-color,backdrop-filter,box-shadow] duration-150",
        focused
          ? "bg-block-bg/95"
          : "bg-block-bg/55 backdrop-blur-[6px] saturate-[0.85]",
      )}
      style={{
        left: tileRect ? tileRect.x : livePos ? livePos.x : w.x,
        top: tileRect ? tileRect.y : livePos ? livePos.y : w.y,
        width: tileRect ? tileRect.width : liveSize ? liveSize.width : w.width,
        height: tileRect ? tileRect.height : liveSize ? liveSize.height : w.height,
        zIndex: w.zIndex,
        borderColor: chrome.border,
        // Unfocused windows get a shallower drop shadow and a half-strength
        // ring so the focused window sits visually forward. Present mode drops
        // the focus drama for a single, calm card shadow on every window.
        boxShadow: present
          ? `0 8px 30px oklch(0% 0 0 / 0.28), 0 0 0 1px color-mix(in oklch, ${chrome.ring} 55%, transparent)`
          : columnDragHover
          ? `0 24px 80px oklch(0% 0 0 / 0.62), 0 0 0 2px oklch(var(--win-l-icon) var(--win-c) ${chrome.hue} / 0.95), 0 0 56px 10px oklch(var(--win-l-icon) var(--win-c) ${chrome.hue} / 0.55)`
          : columnDragCompatible
            ? `0 16px 56px oklch(0% 0 0 / 0.5), 0 0 0 2px oklch(var(--win-l-icon) var(--win-c) ${chrome.hue} / 0.55), 0 0 24px 2px oklch(var(--win-l-icon) var(--win-c) ${chrome.hue} / 0.25)`
            : focused
              ? `0 24px 80px oklch(0% 0 0 / 0.62), 0 0 0 1px ${chrome.ring}`
              : `0 12px 40px oklch(0% 0 0 / 0.32), 0 0 0 1px color-mix(in oklch, ${chrome.ring} 45%, transparent)`,
      }}
      onMouseDown={() => onFocus(w.id)}
    >
      <div
        className={cn(
          "flex select-none items-center border-b transition-colors duration-150",
          present ? "h-7 px-2.5" : tileRect ? "h-9 px-2" : "h-9 cursor-grab px-2 active:cursor-grabbing",
          focused ? "bg-chrome-bg/85" : "bg-chrome-bg/55",
        )}
        style={{ borderColor: chrome.headerBorder }}
        onPointerDown={present || tileRect ? undefined : onHeaderDown}
        onPointerMove={present || tileRect ? undefined : onHeaderMove}
        onPointerUp={present || tileRect ? undefined : onHeaderUp}
        onPointerCancel={present || tileRect ? undefined : onHeaderUp}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0" style={{ color: chrome.icon }} />
          <h2 className="truncate text-[12px] font-semibold text-foreground">{displayTitle ?? w.title}</h2>
        </div>
        <div
          className={cn("flex items-center gap-1", present && "hidden")}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => onMinimize(w.id)}
            className="grid h-6 w-6 place-items-center rounded bg-foreground/[0.055] text-chrome-text transition-colors hover:bg-foreground/[0.105] hover:text-foreground"
            title="Minimize"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded bg-foreground/[0.035] text-chrome-text/30"
            title="Drag the lower-right handle to resize"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onClose(w.id)}
            className="grid h-6 w-6 place-items-center rounded bg-foreground/[0.055] text-chrome-text transition-colors hover:bg-danger/20 hover:text-danger"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content area lets the section's background show through so the
          glass blur is visible across the whole window when unfocused.
          When focused, the section is opaque enough to read as solid. */}
      <div className={cn("overflow-hidden", present ? "h-[calc(100%-1.75rem)]" : "h-[calc(100%-2.25rem)]")}>
        {children}
      </div>

      {columnDragCompatible && onColumnMerge && (rollupTiles.length > 0 || semanticTiles.length > 0) ? (
        <div
          // Capture layer that swallows a compatible column drag before it
          // bubbles to the canvas. When the drag is *not* compatible the
          // overlay isn't mounted, so the drop falls through to the canvas
          // handler (which creates a fresh block). Dropping on the backdrop
          // (not a tile) applies the default op.
          className="absolute inset-0 z-[60] flex items-center justify-center"
          onDragEnter={(e) => { e.preventDefault(); setColumnDragHover(true) }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "copy"
            // Tiles stopPropagation on their own dragover, so reaching here
            // means the cursor is over the backdrop — clear the hot tile + card.
            if (hoveredOpKey !== null) {
              setHoveredOpKey(null)
              setHoverCard(null)
              setSemanticHover(null)
            }
          }}
          onDragLeave={(e) => {
            // relatedTarget is the element being entered; if it's outside
            // the overlay we've genuinely left (moving between tiles keeps
            // it inside, avoiding flicker).
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              resetColumnDragState()
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            resetColumnDragState()
            const payload = readColumnDragPayload(e.dataTransfer)
            if (payload) onColumnMerge(payload, defaultRollupOp)
          }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{ backgroundColor: `oklch(var(--win-l) var(--win-c) var(--win-${w.kind}-h) / 0.12)` }}
          />
          {/* One grid that flows every band; `gridCols` is chosen above to fit
              the window's height so the panel spends width (which wide result
              windows have) instead of scrolling. Dividers/sub-rails/placeholders
              span the full row via `col-span-full`; tiles occupy one cell. */}
          <div
            data-drop-panel
            className="relative grid gap-1 overflow-y-auto rounded-lg border border-chrome-border/60 bg-chrome-bg/80 p-2 backdrop-blur-[3px]"
            style={{
              width: panelWidthPx,
              maxHeight: `${Math.round(w.height * 0.92)}px`,
              gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
            }}
          >
            <div className="col-span-full truncate px-1 text-center text-[10px] uppercase tracking-wider text-chrome-text/80">
              {draggedColumns.length > 1
                ? `${draggedColumns.length} columns →`
                : `${draggedColumns[0]?.name ?? "column"} →`}
            </div>

            {/* ROLLUP — vanilla SQL: measures, group/order, pivot. */}
            {rollupTiles.length > 0 ? (
              <>
                {bandDivider("rollup")}
                {baseTiles.map((tile) => renderRollupTile(tile, false))}
                {pivotTiles.map((tile) => renderRollupTile(tile, true))}
              </>
            ) : null}

            {/* SCALAR — per-row semantic projections, sub-railed by what they
                return (label / flag / score). */}
            {semanticTiles.length > 0 ? (
              <>
                {bandDivider("scalar · per-row column", {
                  tone: "operators",
                  icon: Sparkles,
                  caption: `${semanticTiles.length}`,
                })}
                {denseScalar ? (
                  // Cramped window: one packed grid, ordered by return type so
                  // tiles stay visually clustered even without sub-headers.
                  [...scalarGroups.text, ...scalarGroups.bool, ...scalarGroups.float8].map(renderSemanticTile)
                ) : (
                  <>
                    {scalarGroups.text.length > 0 ? (
                      <>
                        {subRail(Tag, "labels (text)", scalarGroups.text.length)}
                        {scalarGroups.text.map(renderSemanticTile)}
                      </>
                    ) : null}
                    {scalarGroups.bool.length > 0 ? (
                      <>
                        {subRail(Flag, "flags (yes / no)", scalarGroups.bool.length)}
                        {scalarGroups.bool.map(renderSemanticTile)}
                      </>
                    ) : null}
                    {scalarGroups.float8.length > 0 ? (
                      <>
                        {subRail(Activity, "scores (0–1)", scalarGroups.float8.length)}
                        {scalarGroups.float8.map(renderSemanticTile)}
                      </>
                    ) : null}
                  </>
                )}
              </>
            ) : null}

            {/* DIMENSION — active fan-out tiles when dimension ops apply to this
                column (drop → frequency table). Falls back to a "soon" placeholder. */}
            {dimensionTiles.length > 0 ? (
              <>
                {bandDivider("dimension · bins a group", { tone: "operators", icon: Layers, caption: `${dimensionTiles.length}` })}
                {dimensionTiles.map(renderSemanticTile)}
              </>
            ) : null}

            {/* Not-yet-draggable shapes — a labeled home for each so wiring
                them up later is drop-in. Each collapses when its catalog is
                empty; all of them yield to the real tiles on a short window. */}
            {showPlaceholders ? (
              <>
                {placeholderBand(Boxes, "aggregate", "one per group", shapePlaceholders.aggregate, "drop a column")}
                {dimensionTiles.length > 0 ? null : placeholderBand(Layers, "dimension", "bins a group", shapePlaceholders.dimension, "drop a column")}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* On-own-block rowset overlay — drag this window's {block} chip back
          onto its body to chain a `then op('…')` pipeline stage in place.
          Deferred mount (blockChainArmed) so it can't abort the native drag. */}
      {isOwnBlockDrag && rowsetTiles.length > 0 ? (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center"
          onDragEnter={(e) => { e.preventDefault() }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "copy"
            if (hoveredOpKey !== null) { setHoveredOpKey(null); setHoverCard(null); setSemanticHover(null) }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resetColumnDragState()
          }}
          onDrop={(e) => {
            // Backdrop drop (not on a tile) is a no-op — a stage needs an op.
            // stopPropagation so it doesn't bubble to the canvas (which would
            // spawn a self-reference block).
            e.preventDefault()
            e.stopPropagation()
            resetColumnDragState()
          }}
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{ backgroundColor: "color-mix(in oklch, var(--viz-op-rowset) 10%, transparent)" }}
          />
          <div
            data-drop-panel
            className="relative grid w-[min(94%,22rem)] grid-cols-3 gap-1 rounded-lg border border-chrome-border/60 bg-chrome-bg/85 p-2 backdrop-blur-[3px]"
          >
            <div className="col-span-full flex items-center gap-2 px-1 text-[9px] uppercase tracking-wider" style={{ color: "var(--viz-op-rowset)" }}>
              <GitBranch className="h-3 w-3" />
              chain a pipeline stage onto this block
            </div>
            {rowsetTiles.map(renderRowsetChainTile)}
          </div>
        </div>
      ) : null}

      {/* Hover detail card — shared by the column, semantic and rowset overlays
          (a portal, so it lives at section level regardless of which is up). */}
      {hoverCard ? (
        <DropTargetCard info={hoverCard.info} panelRect={hoverCard.panelRect} tileRect={hoverCard.tileRect} />
      ) : null}
      {semanticHover ? (
        <SemanticOperatorTooltip
          op={semanticHover.op}
          title={semanticHover.title}
          signature={semanticHover.signature}
          note={semanticHover.note}
          accent={semanticHover.accent}
          panelRect={semanticHover.panelRect}
          tileRect={semanticHover.tileRect}
        />
      ) : null}

      {attentionToken != null ? (
        <div
          key={attentionToken}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[80] animate-pulse rounded-[inherit] border-2 border-main/90"
          style={{
            background:
              "radial-gradient(circle at 50% 40%, color-mix(in oklch, var(--main) 13%, transparent), transparent 68%)",
            boxShadow:
              "inset 0 0 0 2px color-mix(in oklch, var(--main) 52%, transparent), inset 0 0 42px color-mix(in oklch, var(--main) 24%, transparent)",
          }}
        />
      ) : null}

      {present || tileRect ? null : (
        <button
          type="button"
          aria-label="Resize"
          className="absolute bottom-0 right-0 grid h-6 w-6 cursor-nwse-resize place-items-center rounded-tl bg-foreground/[0.035] text-chrome-text/35 transition-colors hover:bg-foreground/[0.08] hover:text-foreground/65"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        >
          <Grip className="h-3.5 w-3.5 rotate-45" />
        </button>
      )}
    </section>
  )
}

function semanticSignature(tile: SemanticOpTile, colName: string): string {
  const op = tile.op.operator
  if (op.shape === "dimension") return `LATERAL rvbbit.${op.name}(${colName}) -> GROUP BY label`
  return `rvbbit.${op.name}(${[colName, ...op.argNames.slice(1)].join(", ")}) -> ${op.returnType}`
}

function semanticNote(tile: SemanticOpTile): string {
  const op = tile.op.operator
  if (op.shape === "dimension") {
    return "On drop it fans this column out into label rows and counts them. The generated block opens on the SQL tab; nothing runs until you hit Run."
  }
  return tile.needsArgs
    ? "On drop you'll fill the remaining args, then the generated block opens on the SQL tab. Nothing runs until you hit Run."
    : "On drop it creates a per-row semantic projection. The generated block opens on the SQL tab; nothing runs until you hit Run."
}

function rowsetTooltipNote(op: SemanticOpMeta): string {
  return op.name === "analyze" || op.name === "enrich"
    ? "Adds an LLM stage that can run per row. The generated block opens on the SQL tab; nothing runs until you hit Run."
    : "Adds a whole-result pipeline stage from your prompt. The generated block opens on the SQL tab; nothing runs until you hit Run."
}

interface ChromeColors {
  border: string
  ring: string
  headerBorder: string
  icon: string
  hue: number
}

// Temporary visual test: keep per-kind accent icons/drop targets, but remove
// the colored frame/ring around normal windows.
const WINDOW_ACCENT_FRAME_ENABLED = false

// Per-kind identity hue (oklch degrees). The hue is baked in here rather
// than read from a --win-<kind>-h CSS var so a window's frame can never
// fall back to an invalid color (which paints as white) if a token is
// missing. Shared lightness/chroma still live in --win-l / --win-l-icon /
// --win-c, so a theme switch or ImagePalette derivation re-tints every
// window without re-rendering React — those are the parts that actually
// vary by theme; the hues are fixed identity. Reusing each surface's
// --brand-* hue keeps a window's frame, its title-bar icon, and its
// desktop shortcut on the same accent.
const KIND_HUE: Record<string, number> = {
  finder: 220,
  data: 155,
  "query-document": 65,
  artifact: 205,
  "view-app": 196,
  "view-app-builder": 178,
  "view-apps": 196,
  "system-objects": 235,
  extensions: 285,
  "rvbbit-cache": 175,
  connections: 290,
  palette: 320,
  appearance: 320,
  "pg-monitor": 150,
  "pg-query-explorer": 150,
  "lock-explorer": 205,
  "mvcc-explorer": 115,
  "semantic-tests": 75,
  "postgres-admin": 150,
  "data-mover": 175,
  duck: 210,
  routing: 255,
  operators: 168,
  "operator-flow": 168,
  "semantic-op": 168,
  specialists: 300,
  "specialist-detail": 300,
  "model-studio": 300,
  "metric-catalog": 95,
  "metric-creator": 95,
  "metric-inspector": 95,
  "metric-board": 95,
  "alerts": 25,
  "mcp-servers": 55,
  "mcp-incoming": 205,
  "mcp-server-detail": 55,
  "query-lens": 200,
  costs: 130,
  warren: 35,
  "warren-job-detail": 35,
  capabilities: 190,
  "capability-detail": 190,
  "hf-deploy": 175,
  cache: 95,
  "kg-browser": 320,
  "kg-entity-detail": 320,
  "kg-explorer": 320,
  "hindsight-memory": 300,
  "kg-extraction-runs": 320,
  "kg-merge-review": 320,
  "data-search": 320,
  drift: 320,
  browser: 230,
  "block-ref": 65,
  "column-aggregate": 155,
  "csv-import": 100,
  "scry-results": 72,
  notifications: 260,
  dagster: 235,
}

function buildChrome(hue: number): ChromeColors {
  const h = String(hue)
  const border = WINDOW_ACCENT_FRAME_ENABLED
    ? `oklch(var(--win-l) var(--win-c) ${h} / 0.34)`
    : "color-mix(in oklch, var(--chrome-border) 68%, transparent)"
  const ring = WINDOW_ACCENT_FRAME_ENABLED
    ? `oklch(var(--win-l) var(--win-c) ${h} / 0.18)`
    : "color-mix(in oklch, var(--chrome-border) 54%, transparent)"
  const headerBorder = WINDOW_ACCENT_FRAME_ENABLED
    ? `oklch(var(--win-l) var(--win-c) ${h} / 0.16)`
    : "color-mix(in oklch, var(--chrome-border) 46%, transparent)"
  return {
    border,
    ring,
    headerBorder,
    icon: `oklch(var(--win-l-icon) var(--win-c) ${h} / 0.86)`,
    hue,
  }
}

const CHROME: Record<string, ChromeColors> = Object.fromEntries(
  Object.entries(KIND_HUE).map(([k, hue]) => [k, buildChrome(hue)]),
)

function windowChrome(kind: string): ChromeColors {
  return CHROME[kind] ?? CHROME.finder
}
