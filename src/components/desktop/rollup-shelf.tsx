"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown, Filter, Layers, Sigma, TreeStructure, TrendingUp, X } from "@/lib/icons"
import type {
  RollupCompareOp,
  RollupGrain,
  RollupGroupTerm,
  RollupHavingTerm,
  RollupMeasure,
  RollupPivot,
  RollupSpec,
} from "@/lib/desktop/types"
import {
  clearLimit,
  clearMeasureHaving,
  clearPivot,
  cycleMeasureAgg,
  measureLabel,
  removeGroupBy,
  removeMeasure,
  setGroupByGrain,
  setLimit,
  setMeasureHaving,
} from "@/lib/desktop/sql-builder"
import { cn } from "@/lib/utils"

const GRAINS: RollupGrain[] = ["year", "quarter", "month", "week", "day", "hour"]
const COMPARE_OPS: RollupCompareOp[] = [">", ">=", "<", "<=", "=", "!="]

const PILL = "group inline-flex max-w-[240px] items-center gap-1 rounded-full border border-chrome-border/50 bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors"
const POPOVER = "absolute left-0 top-full z-50 mt-1 rounded-md border border-chrome-border bg-chrome-bg/95 p-2 shadow-lg backdrop-blur"

type EditFn = (transform: (s: RollupSpec) => RollupSpec) => void

interface RollupShelfProps {
  spec: RollupSpec
  /** Apply a pure spec transform; the host rebuilds SQL + reruns. */
  onEdit: EditFn
  /** Re-pivot with a new temporal grain (async re-probe at the host). */
  onRepivot?: (grain: RollupGrain) => void
}

/**
 * Editable view of a column-aggregate window's `RollupSpec` — the sibling
 * of the chart shelf and the params chip bar. Pills remove on ✕; measure
 * pills cycle their aggregate on click and carry a HAVING filter via the
 * funnel; temporal pills expose a grain dropdown; a Top-N chip caps rows.
 */
export function RollupShelf({ spec, onEdit, onRepivot }: RollupShelfProps) {
  const pivot = spec.pivot ?? null
  const showDivider = spec.groupBy.length > 0 && spec.measures.length > 0
  const havingFor = (id: string) => spec.having?.find((h) => h.measureId === id)

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-chrome-border/60 bg-chrome-bg/40 px-2 py-1.5">
      <span className="select-none text-[9px] uppercase tracking-wider text-chrome-text/70">Rollup</span>

      {spec.groupBy.map((term) => (
        <GroupPill key={`g:${term.column.name}`} term={term} onEdit={onEdit} />
      ))}

      {showDivider ? <Divider /> : null}

      {spec.measures.map((m) => (
        <MeasurePill key={`m:${m.id}`} measure={m} having={havingFor(m.id)} onEdit={onEdit} />
      ))}

      {pivot ? (
        <>
          <Divider />
          <PivotChip pivot={pivot} onEdit={onEdit} onRepivot={onRepivot} />
        </>
      ) : null}

      <div className="flex-1" />
      <TopNChip spec={spec} onEdit={onEdit} />
    </div>
  )
}

function Divider() {
  return <span className="mx-0.5 h-3.5 w-px bg-chrome-border/60" />
}

function RemoveBtn({ onRemove }: { onRemove: (e: React.MouseEvent) => void }) {
  return (
    <span
      role="button"
      aria-label="remove"
      onClick={onRemove}
      className="ml-0.5 inline-grid h-3.5 w-3.5 place-items-center rounded-full text-chrome-text/55 hover:bg-danger/20 hover:text-danger"
    >
      <X className="h-2.5 w-2.5" />
    </span>
  )
}

function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])
  return { open, setOpen, ref }
}

function GrainMenu({ value, onPick }: { value: RollupGrain; onPick: (g: RollupGrain) => void }) {
  return (
    <div className={cn(POPOVER, "min-w-[96px] p-1")}>
      {GRAINS.map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => onPick(g)}
          className={cn(
            "block w-full rounded px-2 py-0.5 text-left font-mono text-[10px] capitalize",
            g === value ? "bg-main/20 text-foreground" : "text-chrome-text hover:bg-foreground/10",
          )}
        >
          {g}
        </button>
      ))}
    </div>
  )
}

function GroupPill({ term, onEdit }: { term: RollupGroupTerm; onEdit: EditFn }) {
  const { open, setOpen, ref } = usePopover()
  return (
    <span ref={ref} className="relative inline-flex">
      <span className={PILL} title={`GROUP BY ${term.column.name}${term.grain ? ` (${term.grain})` : ""}`}>
        <Layers className="h-3 w-3 shrink-0 text-main/75" />
        <span className="truncate">{term.column.name}</span>
        {term.grain ? (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
            className="ml-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-full bg-foreground/[0.07] px-1 text-[9px] text-chrome-text/85 hover:bg-foreground/[0.14] hover:text-foreground"
            title="change grain"
          >
            {term.grain}
            <ChevronDown className="h-2 w-2" />
          </span>
        ) : null}
        <RemoveBtn onRemove={() => onEdit((s) => removeGroupBy(s, term.column.name))} />
      </span>
      {open && term.grain ? (
        <GrainMenu value={term.grain} onPick={(g) => { setOpen(false); onEdit((s) => setGroupByGrain(s, term.column.name, g)) }} />
      ) : null}
    </span>
  )
}

function MeasurePill({ measure: m, having, onEdit }: { measure: RollupMeasure; having?: RollupHavingTerm; onEdit: EditFn }) {
  const { open, setOpen, ref } = usePopover()
  const cyclable = !!m.column
  return (
    <span ref={ref} className="relative inline-flex">
      <span
        role={cyclable ? "button" : undefined}
        onClick={cyclable ? () => onEdit((s) => cycleMeasureAgg(s, m.id)) : undefined}
        title={cyclable ? `${measureLabel(m)} · click to change aggregate` : measureLabel(m)}
        className={cn(PILL, cyclable && "cursor-pointer hover:border-main/50")}
      >
        <Sigma className="h-3 w-3 shrink-0 text-chart-3" />
        <span className="truncate">{measureLabel(m)}</span>
        {cyclable ? <ChevronDown className="h-2.5 w-2.5 shrink-0 text-chrome-text/40" /> : null}
        {having ? (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
            className="ml-0.5 cursor-pointer rounded-full bg-main/15 px-1 text-[9px] text-main hover:bg-main/25"
            title="edit filter"
          >
            {having.op} {having.value}
          </span>
        ) : (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
            className="ml-0.5 inline-grid h-3.5 w-3.5 place-items-center rounded-full text-chrome-text/40 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
            title="add filter (HAVING)"
          >
            <Filter className="h-2.5 w-2.5" />
          </span>
        )}
        <RemoveBtn onRemove={() => onEdit((s) => removeMeasure(s, m.id))} />
      </span>
      {open ? (
        <HavingPopover
          measure={m}
          having={having}
          onApply={(op, value) => { setOpen(false); onEdit((s) => setMeasureHaving(s, m.id, op, value)) }}
          onClear={() => { setOpen(false); onEdit((s) => clearMeasureHaving(s, m.id)) }}
        />
      ) : null}
    </span>
  )
}

function HavingPopover({
  measure: m,
  having,
  onApply,
  onClear,
}: {
  measure: RollupMeasure
  having?: RollupHavingTerm
  onApply: (op: RollupCompareOp, value: number) => void
  onClear: () => void
}) {
  const [op, setOp] = useState<RollupCompareOp>(having?.op ?? ">")
  const [val, setVal] = useState(having ? String(having.value) : "")
  const apply = () => {
    const n = Number(val)
    if (Number.isFinite(n) && val.trim() !== "") onApply(op, n)
  }
  return (
    <div className={cn(POPOVER, "min-w-[180px] space-y-1.5")}>
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/70">keep rows where {measureLabel(m)}</div>
      <div className="flex flex-wrap gap-0.5">
        {COMPARE_OPS.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setOp(o)}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px]",
              o === op ? "border-main/60 bg-main/15 text-foreground" : "border-chrome-border/50 text-chrome-text hover:border-main/40",
            )}
          >
            {o}
          </button>
        ))}
      </div>
      <input
        type="number"
        value={val}
        autoFocus
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") apply() }}
        placeholder="value"
        className="w-full rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none placeholder:text-chrome-text/40"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={apply}
          className="rounded bg-main/20 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-main/30"
        >
          Apply
        </button>
        {having ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded px-2 py-0.5 text-[10px] text-chrome-text hover:bg-danger/15 hover:text-danger"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

function PivotChip({ pivot, onEdit, onRepivot }: { pivot: RollupPivot; onEdit: EditFn; onRepivot?: (g: RollupGrain) => void }) {
  const { open, setOpen, ref } = usePopover()
  const hasGrainMenu = pivot.grain != null && !!onRepivot
  return (
    <span ref={ref} className="relative inline-flex">
      <span
        className={PILL}
        title={`pivoted across ${pivot.values.length}${pivot.truncated ? "+ (capped)" : ""} values of ${pivot.column.name}${pivot.grain ? ` (${pivot.grain})` : ""}`}
      >
        <TreeStructure className="h-3 w-3 shrink-0 text-rvbbit-accent" />
        <span className="truncate">{pivot.column.name} · {pivot.values.length}{pivot.truncated ? "+" : ""}</span>
        {pivot.grain ? (
          <span
            role={hasGrainMenu ? "button" : undefined}
            onClick={hasGrainMenu ? (e) => { e.stopPropagation(); setOpen((o) => !o) } : undefined}
            className={cn(
              "ml-0.5 inline-flex items-center gap-0.5 rounded-full bg-foreground/[0.07] px-1 text-[9px] text-chrome-text/85",
              hasGrainMenu && "cursor-pointer hover:bg-foreground/[0.14] hover:text-foreground",
            )}
            title={hasGrainMenu ? "change grain" : pivot.grain}
          >
            {pivot.grain}
            {hasGrainMenu ? <ChevronDown className="h-2 w-2" /> : null}
          </span>
        ) : null}
        <RemoveBtn onRemove={() => onEdit(clearPivot)} />
      </span>
      {open && hasGrainMenu ? (
        <GrainMenu value={pivot.grain!} onPick={(g) => { setOpen(false); onRepivot!(g) }} />
      ) : null}
    </span>
  )
}

function TopNChip({ spec, onEdit }: { spec: RollupSpec; onEdit: EditFn }) {
  const { open, setOpen, ref } = usePopover()
  const limit = spec.limit ?? null
  const rankLabel = (() => {
    if (!limit) return ""
    const m = spec.measures.find((x) => x.id === limit.byMeasureId) ?? spec.measures.find((x) => x.alias !== "row_count") ?? spec.measures[0]
    return m ? measureLabel(m) : "row_count"
  })()
  return (
    <span ref={ref} className="relative inline-flex">
      {limit ? (
        <span className={cn(PILL, "cursor-pointer hover:border-main/50")} onClick={() => setOpen((o) => !o)} title="edit Top-N">
          <TrendingUp className={cn("h-3 w-3 shrink-0 text-main/75", limit.dir === "asc" && "rotate-180")} />
          <span className="truncate">{limit.dir === "asc" ? "Bottom" : "Top"} {limit.n} · {rankLabel}</span>
          <RemoveBtn onRemove={(e) => { e.stopPropagation(); onEdit(clearLimit) }} />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-chrome-border/50 px-1.5 py-0.5 text-[10px] text-chrome-text/55 hover:border-main/40 hover:text-foreground"
          title="limit to the top N rows by a measure"
        >
          <TrendingUp className="h-3 w-3" /> Top N
        </button>
      )}
      {open ? <TopNPopover spec={spec} onEdit={onEdit} close={() => setOpen(false)} /> : null}
    </span>
  )
}

function TopNPopover({ spec, onEdit, close }: { spec: RollupSpec; onEdit: EditFn; close: () => void }) {
  const limit = spec.limit ?? null
  const measures = spec.measures
  const [n, setN] = useState(limit ? String(limit.n) : "10")
  const [byId, setById] = useState<string>(limit?.byMeasureId ?? measures[0]?.id ?? "")
  const [dir, setDir] = useState<"asc" | "desc">(limit?.dir ?? "desc")
  const apply = () => {
    const num = Number(n)
    if (!Number.isFinite(num) || num < 1) return
    onEdit((s) => setLimit(s, { n: Math.floor(num), byMeasureId: byId || undefined, dir }))
    close()
  }
  return (
    <div className={cn(POPOVER, "right-0 left-auto min-w-[200px] space-y-1.5")}>
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/70">top-n rows</div>
      <div className="flex items-center gap-1">
        <div className="flex overflow-hidden rounded border border-chrome-border/50">
          {(["desc", "asc"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDir(d)}
              className={cn(
                "px-1.5 py-0.5 text-[10px]",
                d === dir ? "bg-main/15 text-foreground" : "text-chrome-text hover:bg-foreground/10",
              )}
            >
              {d === "desc" ? "Top" : "Bottom"}
            </button>
          ))}
        </div>
        <input
          type="number"
          value={n}
          onChange={(e) => setN(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") apply() }}
          className="w-16 rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
        />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] uppercase tracking-wider text-chrome-text/70">by</span>
        <select
          value={byId}
          onChange={(e) => setById(e.target.value)}
          className="min-w-0 flex-1 rounded border border-chrome-border bg-doc-bg px-1 py-0.5 font-mono text-[10px] text-foreground outline-none"
        >
          {measures.map((m) => (
            <option key={m.id} value={m.id}>{measureLabel(m)}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={apply} className="rounded bg-main/20 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-main/30">Apply</button>
        {limit ? (
          <button type="button" onClick={() => { onEdit(clearLimit); close() }} className="rounded px-2 py-0.5 text-[10px] text-chrome-text hover:bg-danger/15 hover:text-danger">Clear</button>
        ) : null}
      </div>
    </div>
  )
}
