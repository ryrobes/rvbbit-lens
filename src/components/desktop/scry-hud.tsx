"use client"

import { Loader2, Sparkles, X } from "@/lib/icons"
import type { UseScryCascade } from "./use-scry-cascade"

/**
 * The floating, un-transformed HUD prompt — drives the cascade hook. Lives
 * OUTSIDE the world container so it ignores pan/zoom; stops pointerdown so
 * interacting with it never pans the canvas behind it.
 */
export function ScryHud({
  cascade,
  onClose,
  addedCount = 0,
  bloomOverflow = 0,
  scopeActive = false,
  onExitScope,
}: {
  cascade: UseScryCascade
  onClose: () => void
  /** count of tables transferred to the desktop this session */
  addedCount?: number
  /** hits beyond the bloom cap (still listed in the rail) */
  bloomOverflow?: number
  /** a subgraph scope is active */
  scopeActive?: boolean
  onExitScope?: () => void
}) {
  const { stages, finalHits, finalError, canRefine } = cascade
  const relCount = new Set(finalHits.map((h) => `${h.schema}.${h.rel}`)).size

  return (
    <div
      className="pointer-events-auto fixed left-1/2 top-[9vh] z-[122] w-[600px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg/95 shadow-2xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-chrome-border/60 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-terminal" />
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-terminal/80">scry</span>
        <span className="ml-auto text-[10px] text-chrome-text/45">
          {addedCount > 0 ? `${addedCount} on desktop · ` : ""}drag to pan · scroll to zoom · esc to exit
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Exit (Esc)"
          className="grid h-5 w-5 place-items-center rounded text-chrome-text/50 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {stages.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2 border-b border-chrome-border/40 px-3 py-2">
          <span className="w-4 shrink-0 text-center font-mono text-[13px] text-terminal">{i === 0 ? "›" : "⤷"}</span>
          <input
            ref={(el) => {
              cascade.inputRefs.current[i] = el
            }}
            value={s.query}
            onChange={(e) => cascade.setQuery(i, e.target.value)}
            onKeyDown={(e) => cascade.onInputKey(e, i)}
            placeholder={i === 0 ? "describe the data you're looking for…" : "…within those, find…"}
            spellCheck={false}
            style={{ caretColor: "var(--terminal)" }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground placeholder:text-chrome-text/35 focus:outline-none"
          />
          {s.loading ? (
            <Loader2 className="h-3 w-3 animate-spin text-chrome-text/50" />
          ) : s.query.trim() ? (
            <span className="text-[10px] tabular-nums text-chrome-text/45">{s.hits.length}</span>
          ) : null}
          {stages.length > 1 ? (
            <button
              type="button"
              onClick={() => cascade.removeStage(i)}
              title="Remove stage"
              className="grid h-4 w-4 place-items-center rounded text-chrome-text/40 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ))}

      <div className="flex items-center gap-2 px-3 py-2 text-[10px] text-chrome-text/50">
        <span>
          {finalError ? (
            <span className="text-danger">{finalError}</span>
          ) : finalHits.length > 0 ? (
            `${finalHits.length} nodes · ${relCount} relations`
          ) : (
            "type to scry the catalog"
          )}
        </span>
        {bloomOverflow > 0 ? (
          <span
            className="rounded-full border border-chrome-border/60 px-1.5 py-0.5 text-[9px] text-chrome-text/55"
            title={`${bloomOverflow} hits past the canvas cap — all are listed in the rail`}
          >
            +{bloomOverflow} in rail
          </span>
        ) : null}
        {scopeActive ? (
          <button
            type="button"
            onClick={onExitScope}
            title="Exit subgraph scope (c)"
            className="rounded-full border border-terminal/50 bg-terminal/10 px-1.5 py-0.5 text-[9px] text-terminal hover:bg-terminal/20"
          >
            scope · exit
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => cascade.addStage()}
            disabled={!canRefine}
            className="rounded border border-chrome-border/60 px-2 py-0.5 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            ⤷ Refine within
          </button>
          <button
            type="button"
            onClick={() => cascade.submit()}
            disabled={finalHits.length === 0}
            className="rounded border border-chrome-border bg-secondary-background px-2 py-0.5 text-foreground hover:bg-foreground/[0.08] disabled:opacity-40"
          >
            Spawn results →
          </button>
        </span>
      </div>
    </div>
  )
}
