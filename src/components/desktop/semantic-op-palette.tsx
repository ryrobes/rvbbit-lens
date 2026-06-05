"use client"

import { useState } from "react"
import { Sparkles } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { readColumnDragPayload, useActiveColumnDragSource } from "@/lib/desktop/column-drag"
import { availableSemanticOps } from "@/lib/desktop/semantic-ops"
import type { DesktopColumnDragPayload, SemanticOpMeta } from "@/lib/desktop/types"

/**
 * Desktop-level palette of scalar semantic-operator drop tiles. Appears
 * (docked top-center) only while a single text column is being dragged.
 * Dropping the column on a tile spawns a `rvbbit.<op>(col)` projection block.
 *
 * Rendered at desktop level — deliberately NOT as a per-window overlay — so it
 * never covers the window you're dragging *from*. Covering the drag source
 * aborts the native HTML5 drag (and its ghost), which is why the rollup overlay
 * only ever targets *other* windows.
 */
export function SemanticOpPalette({
  semanticOps,
  onSpawn,
}: {
  semanticOps: SemanticOpMeta[]
  onSpawn: (payload: DesktopColumnDragPayload, op: SemanticOpMeta) => void
}) {
  const active = useActiveColumnDragSource()
  const [hot, setHot] = useState<string | null>(null)
  const tiles = active ? availableSemanticOps(active.columns, semanticOps) : []
  if (tiles.length === 0) return null
  const accent = "var(--brand-operators)"
  return (
    <div
      className="pointer-events-auto fixed left-1/2 top-12 z-[70] flex -translate-x-1/2 items-center gap-1.5 rounded-lg border border-chrome-border/70 bg-chrome-bg/90 p-1.5 shadow-2xl backdrop-blur"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      }}
    >
      <span className="inline-flex items-center gap-1 px-1.5 text-[10px] uppercase tracking-wider text-chrome-text/60">
        <Sparkles className="h-3 w-3" style={{ color: accent }} />
        semantic
      </span>
      {tiles.map((t) => {
        const name = t.op.operator.name
        const isHot = hot === name
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
              if (payload) onSpawn(payload, t.op.operator)
            }}
            className={cn(
              "flex cursor-copy select-none items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
              isHot
                ? "border-transparent text-foreground"
                : "border-chrome-border/50 bg-foreground/[0.03] text-chrome-text hover:bg-foreground/[0.06]",
            )}
            style={isHot ? {
              backgroundColor: `color-mix(in oklch, ${accent} 22%, transparent)`,
              boxShadow: `inset 0 0 0 1.5px ${accent}`,
            } : undefined}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
            <span className="truncate">{t.label}</span>
            <span className="font-mono text-[9px] text-chrome-text/45">{t.returnType}</span>
          </div>
        )
      })}
    </div>
  )
}
