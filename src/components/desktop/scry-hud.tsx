"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Loader2, Save, Sparkles, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { ScrySourceId } from "@/lib/desktop/scry"
import type { KgGraphSummary } from "@/lib/rvbbit/kg"
import { objectTypeLabel, type ScryTypeBucket } from "@/lib/desktop/scry-types"
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
  typeDist = [],
  enabledTypes = null,
  onSetEnabledTypes,
  colorMode = "stage",
  onSetColorMode,
  onSaveView,
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
  /** object-type composition of the active graph — filter + color legend */
  typeDist?: ScryTypeBucket[]
  /** enabled object types; null = all on */
  enabledTypes?: Set<string> | null
  onSetEnabledTypes?: (next: Set<string> | null) => void
  colorMode?: "stage" | "type"
  onSetColorMode?: (mode: "stage" | "type") => void
  /** Save the current exploration as a Saved View. */
  onSaveView?: () => void
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
        {onSetEnabledTypes && typeDist.length > 0 ? (
          <TypeFilterMenu
            typeDist={typeDist}
            enabledTypes={enabledTypes}
            onSetEnabledTypes={onSetEnabledTypes}
            colorMode={colorMode}
            onSetColorMode={onSetColorMode}
          />
        ) : null}
        <span className="ml-auto text-[10px] text-chrome-text/45">
          {addedCount > 0 ? `${addedCount} on desktop` : ""}
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
          {onSaveView ? (
            <button
              type="button"
              onClick={onSaveView}
              disabled={finalHits.length === 0}
              title="Save this exploration as a Saved View"
              className="flex items-center gap-1 rounded border border-chrome-border/60 px-2 py-0.5 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            >
              <Save className="h-3 w-3" /> Save view
            </button>
          ) : null}
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

/**
 * The object-type filter — a dropdown that doubles as the color legend. Each row
 * is a checkbox + color swatch + label + count; toggling re-flows the cascade
 * (results + rankings change). The color-mode toggle flips node fills between the
 * cascade-stage hue and the object-type hue (the swatches shown here).
 */
function TypeFilterMenu({
  typeDist,
  enabledTypes,
  onSetEnabledTypes,
  colorMode,
  onSetColorMode,
}: {
  typeDist: ScryTypeBucket[]
  enabledTypes: Set<string> | null
  onSetEnabledTypes: (next: Set<string> | null) => void
  colorMode: "stage" | "type"
  onSetColorMode?: (mode: "stage" | "type") => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The HUD is overflow-hidden, so the menu is portaled to <body> and anchored
  // to the trigger by a fixed position (computed below) — no clipping.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    const W = 256 // w-64
    const m = 8
    setPos({ left: Math.max(m, Math.min(b.left, window.innerWidth - W - m)), top: b.bottom + 4 })
  }, [open])

  const allTypes = typeDist.map((b) => b.type)
  const isOn = (t: string) => enabledTypes === null || enabledTypes.has(t)
  const enabledCount = enabledTypes === null ? allTypes.length : allTypes.filter((t) => enabledTypes.has(t)).length
  const filtered = enabledTypes !== null && enabledCount < allTypes.length

  const toggle = (t: string) => {
    const cur = enabledTypes === null ? new Set(allTypes) : new Set(enabledTypes)
    if (cur.has(t)) cur.delete(t)
    else cur.add(t)
    // Empty or full both mean "no filter" — collapse to null so the checkbox
    // state always matches what's on screen (never a stuck all-unchecked view).
    onSetEnabledTypes(cur.size === 0 || cur.size === allTypes.length ? null : cur)
  }
  const only = (t: string) => onSetEnabledTypes(allTypes.length === 1 ? null : new Set([t]))

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Filter + color by object type"
        className={cn(
          "flex h-6 items-center gap-1 rounded border px-2 font-mono text-[10px] outline-none hover:bg-foreground/[0.05]",
          filtered
            ? "border-terminal/60 text-terminal"
            : "border-chrome-border/60 text-chrome-text",
        )}
      >
        <span>types</span>
        <span className="tabular-nums text-chrome-text/55">
          {filtered ? `${enabledCount}/${allTypes.length}` : "all"}
        </span>
        <span className="text-chrome-text/40">▾</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ position: "fixed", left: pos.left, top: pos.top }}
              className="z-[200] w-64 overflow-hidden rounded-md border border-chrome-border bg-chrome-bg/98 shadow-2xl backdrop-blur"
            >
          <div className="flex items-center gap-2 border-b border-chrome-border/50 px-2 py-1.5">
            {onSetColorMode ? (
              <div className="flex items-center overflow-hidden rounded border border-chrome-border/60 text-[9px]">
                <button
                  type="button"
                  onClick={() => onSetColorMode("stage")}
                  className={cn("px-1.5 py-0.5", colorMode === "stage" ? "bg-terminal/20 text-terminal" : "text-chrome-text/60 hover:bg-foreground/[0.05]")}
                >
                  stage
                </button>
                <button
                  type="button"
                  onClick={() => onSetColorMode("type")}
                  className={cn("px-1.5 py-0.5", colorMode === "type" ? "bg-terminal/20 text-terminal" : "text-chrome-text/60 hover:bg-foreground/[0.05]")}
                  title="Color nodes by object type (the swatches below)"
                >
                  type
                </button>
              </div>
            ) : null}
            <span className="text-[9px] text-chrome-text/45">color by</span>
            <button
              type="button"
              onClick={() => onSetEnabledTypes(null)}
              disabled={!filtered}
              className="ml-auto rounded px-1.5 py-0.5 text-[9px] text-chrome-text/60 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30"
            >
              all on
            </button>
          </div>
          <div className="max-h-[300px] overflow-y-auto py-0.5">
            {typeDist.map((b) => {
              const on = isOn(b.type)
              return (
                <div
                  key={b.type}
                  className="group flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-foreground/[0.05]"
                  onClick={() => toggle(b.type)}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    readOnly
                    className="h-3 w-3 shrink-0 accent-[var(--terminal)]"
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: b.color, opacity: on ? 1 : 0.3 }}
                  />
                  <span className={cn("min-w-0 flex-1 truncate font-mono text-[10px]", on ? "text-foreground/90" : "text-chrome-text/45")}>
                    {objectTypeLabel(b.type)}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      only(b.type)
                    }}
                    title="Show only this type"
                    className="hidden rounded px-1 text-[9px] text-chrome-text/50 hover:bg-foreground/[0.1] hover:text-foreground group-hover:block"
                  >
                    only
                  </button>
                  <span className="shrink-0 tabular-nums text-[9px] text-chrome-text/45">{b.count}</span>
                </div>
              )
            })}
          </div>
            </div>,
            document.body,
          )
        : null}
    </>
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
