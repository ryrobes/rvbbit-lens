"use client"

import { useRef } from "react"
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react"
import { Check, Eye, GitBranch, Loader2, Maximize2 } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { ScryNode } from "@/lib/desktop/scry-scene"
import { hitLabel, KindBadge, ScoreBar } from "./scry-shared"
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
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={node.hit.doc || undefined}
        style={{
          borderColor: selected ? "var(--terminal)" : "var(--chrome-border)",
          boxShadow: selected
            ? "0 0 0 1px var(--terminal), 0 6px 18px color-mix(in oklch, var(--terminal) 22%, transparent)"
            : "0 2px 10px oklch(0% 0 0 / 0.3)",
        }}
        className={cn(
          "flex h-full w-full cursor-grab flex-col overflow-hidden rounded-md border-2 bg-block-bg/95 text-left backdrop-blur transition-colors active:cursor-grabbing hover:border-terminal/50",
        )}
      >
        <div
          className="flex items-center gap-1.5 px-2 py-1"
          style={{ background: "color-mix(in oklch, var(--terminal) 12%, transparent)" }}
        >
          <KindBadge kind={node.hit.kind} />
          <span className="truncate font-mono text-[11px] text-foreground">{hitLabel(node.hit)}</span>
        </div>
        <div className="flex flex-1 items-center justify-between gap-2 px-2">
          <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">
            {node.hit.kind === "db_table" ? "table" : "column"}
            {truncated ? <span className="ml-1 text-terminal/70">+more</span> : null}
          </span>
          <ScoreBar score={node.hit.score} />
        </div>
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
          <NodeAction
            label={added ? "added" : "desktop"}
            disabled={added}
            onClick={() => onAddToDesktop(node)}
            icon={added ? <Check className="h-3 w-3 opacity-70" /> : <Maximize2 className="h-3 w-3" />}
          />
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
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
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
      className="flex items-center gap-1 rounded border bg-block-bg px-1.5 py-0.5 text-[10px] text-foreground shadow-sm transition-colors hover:bg-terminal/15 disabled:opacity-60"
      style={{ borderColor: "var(--terminal)" }}
    >
      {icon}
      <span className="font-mono">{label}</span>
    </button>
  )
}
