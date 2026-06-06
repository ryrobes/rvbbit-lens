"use client"

import { useRef } from "react"
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react"
import { Check, Eye, GitBranch, Layers, Loader2, Maximize2, Target, Trash2 } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { dataImportance, DATA_NODE_MAX_LINES, type ScryNode } from "@/lib/desktop/scry-scene"
import { displayLabel, KindBadge, ScoreBar } from "./scry-shared"
import { ScryPreviewPanel } from "./scry-preview-panel"
import type { PreviewEntry } from "./use-scry-preview"

interface ScryNodeBoxProps {
  node: ScryNode
  /** scry viewport scale — drag deltas are divided by this to move in world coords */
  scale: number
  selected: boolean
  expanding: boolean
  expanded: boolean
  /** expansion was capped at the fetch limit */
  truncated: boolean
  /** this node's table has been transferred to the desktop */
  added: boolean
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  /** spider out this node's KG neighbors */
  onExpand: (node: ScryNode) => void
  /** open this node's table as a real desktop window (stays in Scry) */
  onAddToDesktop: (node: ScryNode) => void
  /** node's data/metadata preview panel is open */
  previewed: boolean
  /** cached preview entry (undefined until first toggled) */
  preview?: PreviewEntry
  onTogglePreview: (node: ScryNode) => void
  /** isolate this node's connected component (scope-within) */
  onScope: (id: string) => void
  /** remove this node + its edges from the canvas */
  onRemove: (id: string) => void
  /** dimmed because a scope is active and this node is outside it */
  dimmed?: boolean
  /** a layout/fit commit is in flight — tween position changes (off during drag) */
  animating?: boolean
  /** expansion refused because the graph is at the node cap */
  capped?: boolean
  /** this node belongs to the data-derived KG layer (entities, not schema) */
  dataLayer?: boolean
}

export function ScryNodeBox({
  node,
  scale,
  selected,
  expanding,
  expanded,
  truncated,
  added,
  onSelect,
  onMove,
  onExpand,
  onAddToDesktop,
  previewed,
  preview,
  onTogglePreview,
  onScope,
  onRemove,
  dimmed,
  animating,
  capped,
  dataLayer,
}: ScryNodeBoxProps) {
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return
    e.stopPropagation() // don't also start a canvas pan
    onSelect(node.id)
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const s = Math.max(0.2, scale) // mirrors desktop-window onHeaderMove guard
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true
    if (d.moved) onMove(node.id, d.ox + (e.clientX - d.sx) / s, d.oy + (e.clientY - d.sy) / s)
  }
  function onPointerUp(e: ReactPointerEvent) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    // a click is just a selection now — actions live on the toolbar below
  }

  // Data layer: importance (0..1, sqrt of FREQUENCY) drives heat + size — a warmer,
  // bigger card for entities that recur across many source rows. The chip shows that
  // frequency ("N×" = seen in N reports); degree (connections) rides in the tooltip.
  const imp = dataLayer ? dataImportance(node.hit.frequency) : 0
  const freq = node.hit.frequency

  return (
    // non-clipping wrapper so the toolbar can sit above the card edge
    <div
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        // lift previewed/selected cards so their expanded panel isn't occluded
        zIndex: previewed ? 30 : selected ? 20 : undefined,
        // out-of-scope nodes dim back and stop intercepting pointers
        opacity: dimmed ? 0.22 : undefined,
        pointerEvents: dimmed ? "none" : undefined,
        // tween position only during a layout/fit commit — never during drag
        transition: animating ? "left .3s ease, top .3s ease, opacity .2s ease" : undefined,
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={node.hit.doc || displayLabel(node.hit, dataLayer) || undefined}
        style={{
          borderColor: selected
            ? "var(--terminal)"
            : dataLayer
              ? `color-mix(in oklch, var(--terminal) ${Math.round(24 + imp * 76)}%, var(--chrome-border))`
              : "var(--chrome-border)",
          boxShadow: selected
            ? "0 0 0 1px var(--terminal), 0 6px 18px color-mix(in oklch, var(--terminal) 22%, transparent)"
            : dataLayer && imp > 0.05
              ? `0 2px 10px oklch(0% 0 0 / 0.3), 0 0 ${Math.round(8 + imp * 32)}px color-mix(in oklch, var(--terminal) ${Math.round(imp * 58)}%, transparent)`
              : "0 2px 10px oklch(0% 0 0 / 0.3)",
        }}
        className={cn(
          "flex h-full w-full cursor-grab flex-col overflow-hidden rounded-md border-2 bg-block-bg/95 text-left backdrop-blur transition-colors active:cursor-grabbing hover:border-terminal/50",
        )}
      >
        {dataLayer ? (
          // ── DATA entity: the text IS the body (wrapped, clamped); heat = hub-ness ──
          <>
            <div
              className="flex flex-1 items-start gap-1.5 px-2 pt-1.5"
              style={{ background: imp > 0.05 ? `color-mix(in oklch, var(--terminal) ${Math.round(imp * 16)}%, transparent)` : undefined }}
            >
              <KindBadge kind={node.hit.kind} dataLayer />
              <span
                className="min-w-0 flex-1 font-mono text-[11px] leading-[16px] text-foreground"
                style={{
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: DATA_NODE_MAX_LINES,
                  overflow: "hidden",
                }}
              >
                {displayLabel(node.hit, dataLayer)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span
                className="inline-flex items-center gap-1 rounded-sm px-1 py-px font-mono text-[9px] tabular-nums"
                title={`seen in ${freq} source row${freq === 1 ? "" : "s"} · ${node.hit.degree} connection${node.hit.degree === 1 ? "" : "s"}`}
                style={{
                  color: freq > 0 ? "var(--terminal)" : "var(--chrome-text)",
                  opacity: freq > 0 ? 0.85 : 0.4,
                  background: freq > 0 ? `color-mix(in oklch, var(--terminal) ${Math.round(12 + imp * 32)}%, transparent)` : "transparent",
                }}
              >
                <Layers className="h-2.5 w-2.5" />
                {freq}×
                {truncated ? <span className="ml-0.5 text-terminal/70">+</span> : null}
                {capped ? <span className="ml-0.5 text-warning" title="graph at node cap — remove or scope to expand further">⊘</span> : null}
              </span>
              <ScoreBar score={node.hit.score} />
            </div>
          </>
        ) : (
          // ── STRUCTURE: schema/table/column header + sublabel (unchanged) ──
          <>
            <div
              className="flex items-center gap-1.5 px-2 py-1"
              style={{ background: "color-mix(in oklch, var(--terminal) 12%, transparent)" }}
            >
              <KindBadge kind={node.hit.kind} dataLayer={dataLayer} />
              <span className="truncate font-mono text-[11px] text-foreground">{displayLabel(node.hit, dataLayer)}</span>
            </div>
            <div className="flex flex-1 items-center justify-between gap-2 px-2">
              <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">
                {node.hit.kind === "db_table" ? "table" : "column"}
                {truncated ? <span className="ml-1 text-terminal/70">+more</span> : null}
                {capped ? (
                  <span className="ml-1 text-warning" title="graph at node cap — remove or scope to expand further">
                    cap
                  </span>
                ) : null}
              </span>
              <ScoreBar score={node.hit.score} />
            </div>
          </>
        )}
      </div>

      {previewed ? (
        <div
          className="absolute left-0 z-10 overflow-hidden rounded-md border bg-block-bg/95 shadow-lg backdrop-blur"
          style={{ top: node.h + 4, width: node.w, borderColor: "var(--chrome-border)" }}
          // the panel scrolls; never let it arm a node drag or a canvas pan.
          // The canvas wheel-zoom is a NATIVE listener, so the synthetic
          // stopPropagation isn't enough — stop the native event too.
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => {
            e.stopPropagation()
            e.nativeEvent.stopPropagation()
          }}
        >
          <ScryPreviewPanel preview={preview} />
        </div>
      ) : null}

      {selected ? (
        <div
          className="absolute -top-8 left-0 z-20 flex items-center gap-1"
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <NodeAction
            label="explore"
            onClick={() => {
              // Data layer: an entity has no table/column to preview — explore just
              // spiders its KG neighbors (idempotent). Structure layer additionally
              // opens the live data + fingerprint-metadata panel.
              if (dataLayer) {
                onExpand(node)
                return
              }
              if (!previewed) onExpand(node) // spider neighbors once (idempotent); only while opening
              onTogglePreview(node) // toggle the data + KG-metadata panel
            }}
            icon={
              expanding || preview?.loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : previewed ? (
                <Eye className="h-3 w-3 opacity-70" />
              ) : (
                // accent tint once the node has already been branched
                <GitBranch className={cn("h-3 w-3", expanded && "text-terminal")} />
              )
            }
          />
          {/* "desktop" graduates a real table/column window — meaningless for a
              derived entity (no backing relation), so it's structure-layer only. */}
          {!dataLayer ? (
            <NodeAction
              label={added ? "added" : "desktop"}
              disabled={added}
              onClick={() => onAddToDesktop(node)}
              icon={added ? <Check className="h-3 w-3 opacity-70" /> : <Maximize2 className="h-3 w-3" />}
            />
          ) : null}
          <NodeAction label="scope" onClick={() => onScope(node.id)} icon={<Target className="h-3 w-3" />} />
          <NodeAction label="remove" danger onClick={() => onRemove(node.id)} icon={<Trash2 className="h-3 w-3" />} />
        </div>
      ) : null}
    </div>
  )
}

function NodeAction({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        // never arm the node drag or a canvas pan
        e.stopPropagation()
        e.preventDefault()
      }}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex items-center gap-1 rounded border bg-block-bg px-1.5 py-0.5 text-[10px] text-foreground shadow-sm transition-colors disabled:opacity-60",
        danger ? "hover:bg-danger/20" : "hover:bg-terminal/15",
      )}
      style={{ borderColor: danger ? "color-mix(in oklch, var(--danger) 55%, var(--terminal))" : "var(--terminal)" }}
    >
      {icon}
      <span className="font-mono">{label}</span>
    </button>
  )
}
