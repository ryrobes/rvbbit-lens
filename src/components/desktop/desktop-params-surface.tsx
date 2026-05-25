"use client"

import { X } from "@/lib/icons"
import type { DesktopParamValue } from "@/lib/desktop/types"
import { shortParamValue } from "@/lib/desktop/reactive-sql"
import { writeParamDragPayload } from "@/lib/desktop/param-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"
import { cn } from "@/lib/utils"

interface DesktopParamsSurfaceProps {
  params: DesktopParamValue[]
  onClear: (key: string) => void
}

/**
 * Sticky bar that lists every active cascading-filter param. Each chip
 * is draggable — drop one onto a data window header to make that window
 * subscribe to it (the engine rewrites the SQL as a WHERE clause).
 */
export function DesktopParamsSurface({ params, onClear }: DesktopParamsSurfaceProps) {
  if (params.length === 0) return null
  return (
    <div className="pointer-events-auto fixed left-1/2 top-10 z-30 flex max-w-[calc(100vw-4rem)] -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-md border border-chrome-border bg-chrome-bg/90 px-2 py-1.5 shadow-xl backdrop-blur">
      <span className="text-[10px] uppercase tracking-wider text-chrome-text">Params</span>
      {params.map((p) => (
        <button
          key={p.key}
          type="button"
          draggable
          onDragStart={(e) => {
            writeParamDragPayload(e.dataTransfer, { kind: "rvbbit-lens.desktop.param", key: p.key })
            attachDragGhost(e.dataTransfer, {
              variant: "param",
              label: `${p.sourceBlockName}.${p.field}`,
              sublabel: `${p.operator === "in" ? "in" : "="} ${shortParamValue(p.value)}`,
            })
          }}
          className={cn(
            "group inline-flex max-w-[260px] items-center gap-1 rounded-full border border-main/30 bg-secondary-background px-2 py-0.5 text-[11px] text-foreground transition-colors",
            "hover:border-main/60 cursor-grab active:cursor-grabbing",
          )}
          title={`Drag onto a window to subscribe · click X to clear`}
        >
          <span className="truncate text-chrome-text">{p.sourceBlockName}.{p.field}</span>
          <span className="text-chrome-text/60">{p.operator === "in" ? "in" : "="}</span>
          <span className="truncate text-foreground">{shortParamValue(p.value)}</span>
          <span
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClear(p.key) }}
            className="ml-0.5 inline-grid h-4 w-4 place-items-center rounded-full text-chrome-text opacity-60 hover:bg-danger/20 hover:text-danger hover:opacity-100"
            role="button"
            aria-label={`Clear ${p.key}`}
          >
            <X className="h-2.5 w-2.5" />
          </span>
        </button>
      ))}
    </div>
  )
}
