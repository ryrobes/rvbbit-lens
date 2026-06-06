"use client"

import { useEffect, useState } from "react"
import { Activity, Flag, Layers, Sparkles, Tag, type LucideIcon } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  readColumnDragPayload,
  useActiveColumnDragSource,
  type ActiveColumnDragSource,
} from "@/lib/desktop/column-drag"
import {
  availableDimensionOps,
  availableSemanticOps,
  groupScalarTilesByReturnType,
  returnTypeChip,
  returnTypeIcon,
  type SemanticOpTile,
} from "@/lib/desktop/semantic-ops"
import type { DesktopColumnDragPayload, SemanticOpMeta } from "@/lib/desktop/types"

const ACCENT = "var(--brand-operators)"

/**
 * Desktop-level palette of scalar semantic-operator drop tiles. Appears
 * (docked top-center) only while a single text column is being dragged.
 * Dropping the column on a tile spawns a `rvbbit.<op>(col)` projection block.
 *
 * Tiles are grouped by return type (Labels / Flags / Scores) and wrap within a
 * capped width, so the bar stays readable as the catalog grows instead of
 * running off-screen — mirroring the Scalar band of the on-block overlay.
 *
 * Rendered at desktop level — deliberately NOT as a per-window overlay — so it
 * never covers the window you're dragging *from*. Covering the drag source
 * aborts the native HTML5 drag (and its ghost), which is why the rollup overlay
 * only ever targets *other* windows.
 */
export function SemanticOpPalette({
  semanticOps,
  onDropOp,
}: {
  semanticOps: SemanticOpMeta[]
  /** Drop the column on a semantic op (spawns a projection; multi-arg ops bind
   *  first at the drop point). */
  onDropOp: (payload: DesktopColumnDragPayload, op: SemanticOpMeta, at: { x: number; y: number }) => void
}) {
  const active = useActiveColumnDragSource()
  const [hot, setHot] = useState<string | null>(null)
  // Defer the palette's appearance until *after* the drag has actually begun.
  // `onHeaderDragStart` sets the active drag source during the native
  // `dragstart`, which re-renders this subscriber in the SAME commit. Because
  // this bar floats (pointer-events-auto) centered near the top of the screen,
  // mounting it right then can land it over the column header being dragged —
  // which aborts the native HTML5 drag, so that column produces no drag ghost
  // at all. (Numeric/date columns have no semantic tiles, so they never hit
  // this — which is why only *some* string fields appeared undraggable.)
  //
  // We arm on the first `dragover`, which only fires once the drag is in
  // flight; tying it to the source's identity means a new drag re-resets
  // automatically (no setState in the effect body).
  const [armedFor, setArmedFor] = useState<ActiveColumnDragSource | null>(null)
  useEffect(() => {
    if (!active) return
    const arm = () => setArmedFor(active)
    window.addEventListener("dragover", arm, { once: true })
    return () => window.removeEventListener("dragover", arm)
  }, [active])
  const armed = !!active && armedFor === active
  const tiles = active && armed ? availableSemanticOps(active.columns, semanticOps) : []
  // Dimension ops fan a column out into label rows → drop spawns a frequency
  // table (GROUP BY the label). Single-arg, so no bind step.
  const dims = active && armed ? availableDimensionOps(active.columns, semanticOps) : []
  if (tiles.length === 0 && dims.length === 0) return null
  const groups = groupScalarTilesByReturnType(tiles)

  function renderTile(t: SemanticOpTile) {
    const name = t.op.operator.name
    const isHot = hot === name
    const Icon = returnTypeIcon(t.returnType)
    return (
      <div
        key={name}
        title={t.hint}
        onDragEnter={(e) => { e.preventDefault(); setHot(name) }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setHot(name) }}
        onDragLeave={() => setHot((h) => (h === name ? null : h))}
        onDrop={(e) => {
          // stopPropagation so the drop doesn't also bubble to the desktop
          // canvas handler, which would spawn a second (vanilla) block.
          e.preventDefault()
          e.stopPropagation()
          setHot(null)
          const payload = readColumnDragPayload(e.dataTransfer)
          if (payload) onDropOp(payload, t.op.operator, { x: e.clientX, y: e.clientY })
        }}
        className={cn(
          "flex cursor-copy select-none items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
          isHot
            ? "border-transparent text-foreground"
            : "border-chrome-border/50 bg-foreground/[0.03] text-chrome-text hover:bg-foreground/[0.06]",
        )}
        style={isHot ? {
          backgroundColor: `color-mix(in oklch, ${ACCENT} 22%, transparent)`,
          boxShadow: `inset 0 0 0 1.5px ${ACCENT}`,
        } : undefined}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: ACCENT }} />
        <span className="truncate">
          {t.label}
          {t.needsArgs ? <span className="text-chrome-text/45">…</span> : null}
        </span>
        <span className="font-mono text-[9px] text-chrome-text/45">{returnTypeChip(t.returnType)}</span>
      </div>
    )
  }

  function renderGroup(label: string, Icon: LucideIcon, items: SemanticOpTile[]) {
    if (items.length === 0) return null
    return (
      <div className="flex items-start gap-1.5">
        <span className="flex w-[5.5rem] shrink-0 items-center gap-1 pt-1 text-[9px] lowercase tracking-wide text-chrome-text/50">
          <Icon className="h-2.5 w-2.5 shrink-0" style={{ color: ACCENT }} />
          <span className="truncate">{label}</span>
        </span>
        <div className="flex flex-wrap gap-1">{items.map(renderTile)}</div>
      </div>
    )
  }

  return (
    <div
      className="pointer-events-auto fixed left-1/2 top-12 z-[70] flex max-w-[min(92vw,42rem)] -translate-x-1/2 flex-col gap-1.5 rounded-lg border border-chrome-border/70 bg-chrome-bg/90 p-2 shadow-2xl backdrop-blur"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      }}
    >
      <span className="inline-flex items-center gap-1 px-0.5 text-[10px] uppercase tracking-wider" style={{ color: ACCENT }}>
        <Sparkles className="h-3 w-3" />
        semantic · drop on a column
      </span>
      {renderGroup("labels (text)", Tag, groups.text)}
      {renderGroup("flags (y/n)", Flag, groups.bool)}
      {renderGroup("scores (0–1)", Activity, groups.float8)}
      {dims.length > 0 ? (
        <div className="mt-0.5 border-t border-chrome-border/40 pt-1.5">
          {renderGroup("group by ↘", Layers, dims)}
        </div>
      ) : null}
    </div>
  )
}
