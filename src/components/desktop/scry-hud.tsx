"use client"

import { Loader2, Sparkles, X } from "@/lib/icons"
import type { ScrySourceId } from "@/lib/desktop/scry"
import type { KgGraphSummary } from "@/lib/rvbbit/kg"
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
  source = "catalog",
  graphId = source === "data" ? "data_kg" : "db_catalog",
  graphs = [],
  graphsError = null,
  onSetGraphId,
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
  /** active graph corpus class, derived from the selected graph id */
  source?: ScrySourceId
  /** active KG graph_id searched by rvbbit.data_search */
  graphId?: string
  /** available KG graph_ids from rvbbit.kg_* tables */
  graphs?: KgGraphSummary[]
  graphsError?: string | null
  onSetGraphId?: (graphId: string) => void
}) {
  const { stages, finalHits, finalError, canRefine } = cascade
  const relCount = new Set(finalHits.map((h) => `${h.schema}.${h.rel}`)).size
  const factResults = finalHits.length > 0 && finalHits.every((h) => h.kind !== "db_table" && h.kind !== "db_column")
  const graphOptions = graphs.length > 0
    ? graphs
    : [{ graphId, nodes: 0, edges: 0, evidenceRows: 0, lastActivity: null }]

  return (
    <div
      className="pointer-events-auto fixed left-1/2 top-[9vh] z-[122] w-[600px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg/95 shadow-2xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-chrome-border/60 px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-terminal" />
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-terminal/80">scry</span>
        {onSetGraphId ? (
          <label
            className="ml-1 flex min-w-0 items-center gap-1"
            title="Graph corpus searched by rvbbit.data_search"
          >
            <span className="sr-only">Search graph</span>
            <select
              value={graphId}
              onChange={(e) => onSetGraphId(e.target.value)}
              className="h-6 max-w-[230px] rounded border border-chrome-border/60 bg-chrome-bg px-2 font-mono text-[10px] text-chrome-text outline-none hover:bg-foreground/[0.05] focus:border-terminal/70 focus:text-foreground"
            >
              {graphOptions.map((graph) => (
                <option key={graph.graphId} value={graph.graphId}>
                  {graphOptionLabel(graph)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {graphsError ? (
          <span className="max-w-[140px] truncate text-[10px] text-danger" title={graphsError}>
            graphs unavailable
          </span>
        ) : null}
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
            `${finalHits.length} ${factResults ? "entities" : "nodes"} · ${relCount} relations`
          ) : (
            `type to scry ${graphId}`
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

function graphOptionLabel(graph: KgGraphSummary): string {
  const graphKind = graph.graphId === "db_catalog" ? "structure" : graph.graphId === "data_kg" ? "facts" : "graph"
  const counts = graph.nodes > 0 || graph.edges > 0 ? ` - ${fmtCompact(graph.nodes)}n/${fmtCompact(graph.edges)}e` : ""
  return `${graph.graphId} - ${graphKind}${counts}`
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}
