"use client"

import { useRef, useState } from "react"
import {
  Boxes,
  Calculator,
  Calendar,
  ChevronDown,
  Grip,
  Hash,
  Layers,
  Maximize2,
  Minus,
  Sigma,
  Table2,
  TreeStructure,
  TrendingUp,
  X,
  type LucideIcon,
} from "@/lib/icons"
import {
  readColumnDragPayload,
  useActiveColumnDragSource,
} from "@/lib/desktop/column-drag"
import { availableRollupOps, isNumericRef } from "@/lib/desktop/sql-builder"
import type {
  DesktopColumnDragPayload,
  DesktopWindowState,
  RollupMeasure,
  RollupOp,
} from "@/lib/desktop/types"
import { cn } from "@/lib/utils"

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

interface DesktopWindowProps {
  window: DesktopWindowState
  icon: LucideIcon
  children: React.ReactNode
  /** True when this window currently holds keyboard/visual focus. */
  focused: boolean
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
}

const MIN_WIDTH = 320
const MIN_HEIGHT = 220
const MAX_WIDTH = 2400
const MAX_HEIGHT = 1800
const MIN_WORLD = -20000
const MAX_WORLD = 20000

export function DesktopWindow({
  window: w,
  icon: Icon,
  children,
  focused,
  onFocus,
  onClose,
  onMinimize,
  onMove,
  onResize,
  viewportScale = 1,
  columnDropAcceptsFrom,
  onColumnMerge,
}: DesktopWindowProps) {
  const chrome = windowChrome(w.kind)
  const activeColumnDrag = useActiveColumnDragSource()
  const columnDragCompatible = !!columnDropAcceptsFrom
    && !!activeColumnDrag
    && activeColumnDrag.parentWindowId === columnDropAcceptsFrom.parentWindowId
    && activeColumnDrag.relationKey === columnDropAcceptsFrom.relationKey
  // `columnDragHover` → cursor is somewhere over the drop overlay (drives
  // the strong outer glow). `hoveredOpKey` → which specific tile is hot.
  const [columnDragHover, setColumnDragHover] = useState(false)
  const [hoveredOpKey, setHoveredOpKey] = useState<string | null>(null)
  const draggedColumns = activeColumnDrag?.columns ?? []
  const rollupTiles = columnDragCompatible
    ? availableRollupOps(draggedColumns, columnDropAcceptsFrom?.measures ?? [])
    : []
  const baseTiles = rollupTiles.filter((t) => t.group !== "pivot")
  const pivotTiles = rollupTiles.filter((t) => t.group === "pivot")
  // Default op for a drop on the cluster backdrop (not a specific tile):
  // sum for numeric drags, group-by otherwise — matches the old one-shot.
  const defaultRollupOp: RollupOp = draggedColumns.some(isNumericRef)
    ? { kind: "measure", agg: "sum" }
    : { kind: "group-by" }
  const resetColumnDragState = () => { setColumnDragHover(false); setHoveredOpKey(null) }

  function renderRollupTile(tile: { op: RollupOp; label: string; hint: string }, fullWidth: boolean) {
    const key = rollupOpKey(tile.op)
    const Icon = rollupOpIcon(tile.op)
    const hot = hoveredOpKey === key
    const accent = `oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h))`
    return (
      <div
        key={key}
        title={tile.hint}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setHoveredOpKey(key) }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = "copy"
          setHoveredOpKey(key)
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
          fullWidth ? "col-span-2 py-1.5" : "flex-col justify-center py-2.5",
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
        <span className="truncate">{tile.label}</span>
      </div>
    )
  }
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
    onMove(w.id, clamp(d.originX + (e.clientX - d.startX) / s), clamp(d.originY + (e.clientY - d.startY) / s))
  }
  function onHeaderUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
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
    onResize(w.id, nw, nh)
  }
  function onResizeUp(e: React.PointerEvent<HTMLButtonElement>) {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    resizeRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  if (w.minimized) return null

  return (
    <section
      data-rvbbit-window
      data-focused={focused ? "true" : "false"}
      data-column-drop={columnDragCompatible ? (columnDragHover ? "hover" : "ready") : undefined}
      className={cn(
        // `group/window` lets content surfaces (datagrids, editors) react to
        // this window's focus state via `group-data-[focused=…]/window:` —
        // e.g. a grid stays opaque when focused but glass-tints when not.
        "group/window pointer-events-auto absolute overflow-hidden rounded-md border transition-[background-color,backdrop-filter,box-shadow] duration-150",
        focused
          ? "bg-block-bg/95"
          : "bg-block-bg/55 backdrop-blur-[6px] saturate-[0.85]",
      )}
      style={{
        left: w.x,
        top: w.y,
        width: w.width,
        height: w.height,
        zIndex: w.zIndex,
        borderColor: chrome.border,
        // Unfocused windows get a shallower drop shadow and a half-strength
        // ring so the focused window sits visually forward.
        boxShadow: columnDragHover
          ? `0 24px 80px oklch(0% 0 0 / 0.62), 0 0 0 2px oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h) / 0.95), 0 0 56px 10px oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h) / 0.55)`
          : columnDragCompatible
            ? `0 16px 56px oklch(0% 0 0 / 0.5), 0 0 0 2px oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h) / 0.55), 0 0 24px 2px oklch(var(--win-l-icon) var(--win-c) var(--win-${w.kind}-h) / 0.25)`
            : focused
              ? `0 24px 80px oklch(0% 0 0 / 0.62), 0 0 0 1px ${chrome.ring}`
              : `0 12px 40px oklch(0% 0 0 / 0.32), 0 0 0 1px color-mix(in oklch, ${chrome.ring} 45%, transparent)`,
      }}
      onMouseDown={() => onFocus(w.id)}
    >
      <div
        className={cn(
          "flex h-9 cursor-grab select-none items-center border-b px-2 active:cursor-grabbing transition-colors duration-150",
          focused ? "bg-chrome-bg/85" : "bg-chrome-bg/55",
        )}
        style={{ borderColor: chrome.headerBorder }}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded" style={{ backgroundColor: chrome.iconBg }}>
            <Icon className="h-3.5 w-3.5" style={{ color: chrome.icon }} />
          </div>
          <h2 className="truncate text-[12px] font-semibold text-foreground">{w.title}</h2>
        </div>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
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
      <div className="h-[calc(100%-2.25rem)] overflow-hidden">{children}</div>

      {columnDragCompatible && onColumnMerge && rollupTiles.length > 0 ? (
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
            // means the cursor is over the backdrop — clear the hot tile.
            setHoveredOpKey(null)
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
          <div className="relative grid w-[min(80%,18rem)] grid-cols-2 gap-1.5 rounded-lg border border-chrome-border/60 bg-chrome-bg/80 p-2 backdrop-blur-[3px]">
            <div className="col-span-2 truncate px-1 pb-0.5 text-center text-[10px] uppercase tracking-wider text-chrome-text/80">
              {draggedColumns.length > 1
                ? `${draggedColumns.length} columns →`
                : `${draggedColumns[0]?.name ?? "column"} →`}
            </div>
            {baseTiles.map((tile, i) => {
              const lastOdd = baseTiles.length % 2 === 1 && i === baseTiles.length - 1
              return renderRollupTile(tile, lastOdd)
            })}
            {pivotTiles.length > 0 ? (
              <>
                <div className="col-span-2 mt-1 flex items-center gap-2 px-1 text-[9px] uppercase tracking-wider text-chrome-text/60">
                  <span className="h-px flex-1 bg-chrome-border/60" />
                  pivot
                  <span className="h-px flex-1 bg-chrome-border/60" />
                </div>
                {pivotTiles.map((tile) => renderRollupTile(tile, true))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        aria-label="Resize"
        className="absolute bottom-0 right-0 grid h-6 w-6 cursor-nwse-resize place-items-center rounded-tl bg-foreground/[0.035] text-chrome-text/35 transition-colors hover:bg-foreground/[0.08] hover:text-foreground/65"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      >
        <Grip className="h-3.5 w-3.5 rotate-45" />
      </button>
    </section>
  )
}

interface ChromeColors {
  border: string
  ring: string
  headerBorder: string
  icon: string
  iconBg: string
}

// Every chrome color is a CSS expression that resolves at paint time.
// Per-kind hue lives in --win-<kind>-h (defined per theme in globals.css);
// shared lightness/chroma live in --win-l, --win-l-icon, --win-c. Changing
// any of those — by theme switch or by ImagePalette derivation — re-tints
// every window without re-rendering React.
const KINDS = [
  "finder",
  "data",
  "query-document",
  "artifact",
  "view-app",
  "view-app-builder",
  "view-apps",
  "system-objects",
  "extensions",
  "rvbbit-cache",
  "connections",
  "palette",
  "pg-monitor",
  "duck",
] as const

function buildChrome(kind: string): ChromeColors {
  const h = `var(--win-${kind}-h)`
  return {
    border: `oklch(var(--win-l) var(--win-c) ${h} / 0.34)`,
    ring: `oklch(var(--win-l) var(--win-c) ${h} / 0.18)`,
    headerBorder: `oklch(var(--win-l) var(--win-c) ${h} / 0.16)`,
    icon: `oklch(var(--win-l-icon) var(--win-c) ${h} / 0.86)`,
    iconBg: `oklch(var(--win-l) var(--win-c) ${h} / 0.12)`,
  }
}

const CHROME: Record<string, ChromeColors> = Object.fromEntries(
  KINDS.map((k) => [k, buildChrome(k)]),
)

function windowChrome(kind: string): ChromeColors {
  return CHROME[kind] ?? CHROME.finder
}
