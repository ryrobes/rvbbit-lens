"use client"

import { Globe, X } from "@/lib/icons"
import type { DesktopParamValue } from "@/lib/desktop/types"
import { shortParamValue } from "@/lib/desktop/reactive-sql"
import { writeParamDragPayload } from "@/lib/desktop/param-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"
import { cn } from "@/lib/utils"

interface DesktopParamsSurfaceProps {
  params: DesktopParamValue[]
  onClear: (key: string) => void
  /** Flip a filter's broadcast (auto-apply to all blocks reading its table). */
  onSetBroadcast: (key: string, on: boolean) => void
  /** How many OTHER blocks a broadcast filter would touch (its blast radius). */
  broadcastCountFor: (param: DesktopParamValue) => number
}

/** Short label for a param's comparison operator. */
function opLabel(op: DesktopParamValue["operator"]): string {
  return op === "in" ? "in" : op === "gte" ? "≥" : op === "lte" ? "≤" : "="
}

/** Compact source label: `plate:demo/casebook` → `casebook`, block names
 *  pass through. The full name stays in tooltips and drag payloads. */
function prettySource(source: string): string {
  const s = source.replace(/^plate:/, "")
  const slash = s.lastIndexOf("/")
  return slash >= 0 ? s.slice(slash + 1) : s
}

function displayValue(v: unknown): string {
  const s = shortParamValue(v)
  return s === "" ? "∅" : s
}

/**
 * Sticky bar listing every active cascading-filter param, GROUPED by source
 * so long namespaces (plates especially) print once per group instead of on
 * every chip. Chips stay individually draggable — drop one onto a data
 * window header to make that window subscribe to it.
 */
export function DesktopParamsSurface({ params, onClear, onSetBroadcast, broadcastCountFor }: DesktopParamsSurfaceProps) {
  if (params.length === 0) return null

  const groups: Array<{ source: string; items: DesktopParamValue[] }> = []
  for (const p of params) {
    const g = groups.find((x) => x.source === p.sourceBlockName)
    if (g) g.items.push(p)
    else groups.push({ source: p.sourceBlockName, items: [p] })
  }

  return (
    <div className="pointer-events-auto fixed left-1/2 top-10 z-30 flex max-w-[calc(100vw-4rem)] -translate-x-1/2 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-chrome-border bg-chrome-bg/90 px-2.5 py-1.5 shadow-xl backdrop-blur">
      <span className="text-[10px] uppercase tracking-wider text-chrome-text">Params</span>
      {groups.map((g, gi) => (
        <div key={g.source} className="flex min-w-0 flex-wrap items-center gap-1.5">
          {gi > 0 ? <span className="h-4 w-px shrink-0 bg-chrome-border/70" /> : null}
          <span
            className="max-w-[140px] truncate text-[10px] font-medium uppercase tracking-wide text-chrome-text/55"
            title={g.source}
          >
            {prettySource(g.source)}
          </span>
          {g.items.map((p) => (
            <button
              key={p.key}
              type="button"
              draggable
              onDragStart={(e) => {
                writeParamDragPayload(e.dataTransfer, { kind: "rvbbit-lens.desktop.param", key: p.key })
                attachDragGhost(e.dataTransfer, {
                  variant: "param",
                  label: `${p.sourceBlockName}.${p.field}`,
                  sublabel: `${opLabel(p.operator)} ${shortParamValue(p.value)}`,
                })
              }}
              className={cn(
                "group inline-flex max-w-[220px] items-center gap-1 rounded-full border bg-secondary-background px-2 py-0.5 text-[11px] text-foreground transition-colors",
                "cursor-grab active:cursor-grabbing",
                // A "pick" param doesn't filter its source — it's inert until
                // dragged onto a target. Dashed + ringed so it reads differently
                // from a live cascade filter (solid border).
                p.cascade === false
                  ? "border-dashed border-main/55 ring-1 ring-inset ring-main/20 hover:border-main/80"
                  : "border-main/30 hover:border-main/60",
              )}
              title={
                `${p.sourceBlockName}.${p.field} ${opLabel(p.operator)} ${shortParamValue(p.value)}\n` +
                (p.cascade === false
                  ? `Pick — not filtering its source. Drag onto a window to bind · click X to clear`
                  : `Filter — drag onto a window to also subscribe · click X to clear`)
              }
            >
              <span className="truncate text-chrome-text">{p.field}</span>
              <span className="text-chrome-text/60">{opLabel(p.operator)}</span>
              <span className={cn("truncate", displayValue(p.value) === "∅" ? "text-chrome-text/45" : "text-foreground")}>
                {displayValue(p.value)}
              </span>
              {/* Broadcast toggle — only when we have the source table (pg provenance).
                  OFF = local; ON = filters every block reading that table (shows count). */}
              {p.sourceTable ? (
                <span
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSetBroadcast(p.key, !p.broadcast) }}
                  role="button"
                  aria-pressed={!!p.broadcast}
                  title={
                    p.broadcast
                      ? `Broadcasting to ${broadcastCountFor(p)} block(s) that read ${p.sourceTable} — click to make local`
                      : `Broadcast: also filter every block that reads ${p.sourceTable}`
                  }
                  className={cn(
                    "ml-0.5 inline-flex items-center gap-0.5 rounded-full px-1 py-0.5 text-[9px] tabular-nums transition-colors",
                    p.broadcast
                      ? "bg-rvbbit-accent/20 text-rvbbit-accent"
                      : "text-chrome-text/40 hover:bg-foreground/[0.08] hover:text-foreground",
                  )}
                >
                  <Globe className="h-2.5 w-2.5" />
                  {p.broadcast ? broadcastCountFor(p) : null}
                </span>
              ) : null}
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
      ))}
    </div>
  )
}
