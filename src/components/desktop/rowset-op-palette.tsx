"use client"

import { useEffect, useState, type DragEvent } from "react"
import { Activity, Filter, GitBranch, Plus, Sigma, TreeStructure, TrendingUp, type LucideIcon } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  readBlockDragPayload,
  useActiveBlockDragSource,
  type ActiveBlockDragSource,
} from "@/lib/desktop/block-drag"
import { availableRowsetOps } from "@/lib/desktop/semantic-ops"
import type { DesktopBlockDragPayload, SemanticOpMeta } from "@/lib/desktop/types"
import type { DropTargetInfo } from "./drop-target-card"
import { SemanticOperatorTooltip } from "./semantic-operator-tooltip"

const ACCENT = "var(--viz-op-rowset)"

export function rowsetOpIcon(name: string): LucideIcon {
  switch (name) {
    case "filter": return Filter
    case "group": return Sigma
    case "pivot": return TreeStructure
    case "top": return TrendingUp
    case "analyze": return Activity
    case "enrich": return Plus
    default: return GitBranch
  }
}

// One-word role hint under each tile label.
function rowsetSub(name: string): string {
  switch (name) {
    case "filter": return "rows"
    case "group": return "aggregate"
    case "pivot": return "crosstab"
    case "top": return "order"
    case "analyze": return "findings"
    case "enrich": return "+columns"
    default: return "pipeline"
  }
}

export function rowsetInfo(op: SemanticOpMeta): DropTargetInfo {
  const heavy = op.name === "analyze" || op.name === "enrich"
  return {
    icon: rowsetOpIcon(op.name),
    title: op.name.charAt(0).toUpperCase() + op.name.slice(1),
    mono: `then ${op.name}`,
    shape: "rowset · pipeline stage",
    accent: ACCENT,
    description: op.description,
    signature: `… then ${op.name}('<prompt>')`,
    extraArgs: [{ name: "prompt", type: "instruction" }],
    note: heavy
      ? "Adds an LLM stage that runs per row — can be pricey. Spawns a new block on the SQL tab; hit Run when ready."
      : "Generates SQL from your prompt and pipelines the result. Spawns a new block on the SQL tab; hit Run when ready.",
  }
}

/**
 * Desktop-level palette of rowset (whole-result) pipeline operators. Appears
 * (docked top-center) only while a result BLOCK is being dragged. Dropping the
 * block on a tile opens a prompt, then spawns `SELECT * FROM {block} then
 * op('…')`.
 *
 * Mirrors SemanticOpPalette: rendered at desktop level (never over the drag
 * source), and deferred until the drag is in flight so it can't abort the
 * native drag by mounting over the block chip at dragstart.
 */
export function RowsetOpPalette({
  semanticOps,
  onDropOp,
}: {
  semanticOps: SemanticOpMeta[]
  onDropOp: (payload: DesktopBlockDragPayload, op: SemanticOpMeta, at: { x: number; y: number }) => void
}) {
  const active = useActiveBlockDragSource()
  const [armedFor, setArmedFor] = useState<ActiveBlockDragSource | null>(null)
  const [hovered, setHovered] = useState<{ op: SemanticOpMeta; title: string; tileRect: DOMRect; panelRect: DOMRect | null } | null>(null)

  // Defer past the synchronous dragstart commit (see SemanticOpPalette): arm on
  // the first dragover, keyed to the source identity so a new drag re-resets.
  useEffect(() => {
    if (!active) return
    const arm = () => setArmedFor(active)
    window.addEventListener("dragover", arm, { once: true })
    return () => window.removeEventListener("dragover", arm)
  }, [active])

  const armed = !!active && armedFor === active
  const tiles = armed ? availableRowsetOps(semanticOps) : []
  if (tiles.length === 0) return null

  function setHot(e: DragEvent<HTMLDivElement>, name: string, op: SemanticOpMeta) {
    if (hovered?.op.name === name) return
    const tile = e.currentTarget as HTMLElement
    const panel = tile.closest("[data-rowset-panel]")
    setHovered({
      op,
      title: name.charAt(0).toUpperCase() + name.slice(1),
      tileRect: tile.getBoundingClientRect(),
      panelRect: panel?.getBoundingClientRect() ?? null,
    })
  }

  return (
    <div
      data-rowset-panel
      className="pointer-events-auto fixed left-1/2 top-12 z-[70] flex max-w-[min(92vw,36rem)] -translate-x-1/2 flex-col gap-1.5 rounded-lg border border-chrome-border/70 bg-chrome-bg/90 p-2 shadow-2xl backdrop-blur"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      }}
    >
      <span className="inline-flex items-center gap-1 px-0.5 text-[10px] uppercase tracking-wider" style={{ color: ACCENT }}>
        <GitBranch className="h-3 w-3" />
        whole-result · drop the block to pipeline
      </span>
      <div className="flex flex-wrap gap-1">
        {tiles.map((t) => {
          const name = t.op.name
          const Icon = rowsetOpIcon(name)
          const isHot = hovered?.op.name === name
          return (
            <div
              key={name}
              title={t.hint}
              onDragEnter={(e) => { e.preventDefault(); setHot(e, name, t.op) }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setHot(e, name, t.op) }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setHovered(null)
                const payload = readBlockDragPayload(e.dataTransfer)
                if (payload) onDropOp(payload, t.op, { x: e.clientX, y: e.clientY })
              }}
              className={cn(
                "flex w-[5.5rem] cursor-copy select-none flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors",
                isHot
                  ? "border-transparent text-foreground"
                  : "border-chrome-border/50 bg-foreground/[0.03] text-chrome-text hover:bg-foreground/[0.06]",
              )}
              style={isHot ? {
                backgroundColor: `color-mix(in oklch, ${ACCENT} 22%, transparent)`,
                boxShadow: `inset 0 0 0 1.5px ${ACCENT}`,
              } : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" style={{ color: ACCENT }} />
              <span className="truncate">{t.label}</span>
              <span className="text-[8px] text-chrome-text/45">{rowsetSub(name)}</span>
            </div>
          )
        })}
      </div>
      {hovered ? (
        <SemanticOperatorTooltip
          op={hovered.op}
          title={hovered.title}
          signature={`... then ${hovered.op.name}('<prompt>')`}
          note={rowsetTooltipNote(hovered.op)}
          accent={ACCENT}
          panelRect={hovered.panelRect}
          tileRect={hovered.tileRect}
        />
      ) : null}
    </div>
  )
}

function rowsetTooltipNote(op: SemanticOpMeta): string {
  return op.name === "analyze" || op.name === "enrich"
    ? "Adds an LLM stage that can run per row. The generated block opens on the SQL tab; nothing runs until you hit Run."
    : "Adds a whole-result pipeline stage from your prompt. The generated block opens on the SQL tab; nothing runs until you hit Run."
}
