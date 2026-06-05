"use client"

import { Download } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"
import { nodeId } from "@/lib/desktop/scry-scene"
import { hitLabel, KindBadge, ScoreBar } from "./scry-shared"

/**
 * A fixed, non-zoomable results rail on the right edge — a live, transparent
 * tabular mirror of the cascade's final hits. It's a sibling of the canvas (not
 * a descendant), so pan/zoom never touch it. Clicking a row FOCUSES the matching
 * node in the graph (select + recenter) — it never spawns to the desktop.
 */
export function ScryResultsRail({
  hits,
  selectedId,
  onFocus,
  graduateCount,
  onGraduateAll,
}: {
  hits: DataSearchHit[]
  selectedId: string | null
  onFocus: (id: string) => void
  /** distinct tables on the canvas that "Send to desktop" would graduate */
  graduateCount: number
  /** graduate the explored set to the desktop and exit Scry */
  onGraduateAll: () => void
}) {
  return (
    <div className="pointer-events-auto fixed right-3 top-[9vh] bottom-3 z-[121] flex w-[280px] max-w-[40vw] flex-col overflow-hidden rounded-lg border border-chrome-border/60 bg-chrome-bg/70 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-chrome-border/60 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-terminal/80">
        results
        <span className="ml-auto tabular-nums text-chrome-text/45">{hits.length}</span>
      </div>
      {hits.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-chrome-text/45">no results yet</div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-chrome-border/20 overflow-y-auto">
          {hits.map((h) => {
            const id = nodeId(h)
            const sel = id === selectedId
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onFocus(id)}
                  title={h.doc || undefined}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                    sel ? "bg-terminal/15" : "hover:bg-foreground/[0.05]",
                  )}
                >
                  <KindBadge kind={h.kind} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{hitLabel(h)}</span>
                  <ScoreBar score={h.score} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {graduateCount > 0 ? (
        <button
          type="button"
          onClick={onGraduateAll}
          title="Open all explored tables on the desktop and exit Scry"
          className="flex shrink-0 items-center justify-center gap-1.5 border-t border-chrome-border/60 px-3 py-2 text-[11px] text-foreground transition-colors hover:bg-foreground/[0.06]"
        >
          <Download className="h-3.5 w-3.5 text-terminal" />
          Send {graduateCount} {graduateCount === 1 ? "table" : "tables"} to desktop
        </button>
      ) : null}
    </div>
  )
}
