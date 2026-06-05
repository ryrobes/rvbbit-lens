"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Filter, Layers, Search, Sigma, SortAscending, SortDescending, Sparkles, TreeStructure, TrendingUp, X } from "@/lib/icons"
import type {
  RollupCompareOp,
  RollupFilter,
  RollupGrain,
  RollupGroupTerm,
  RollupHavingTerm,
  RollupMeasure,
  RollupPivot,
  RollupSpec,
  SemanticProjection,
} from "@/lib/desktop/types"
import {
  aggregateProjection,
  clearColumnFilters,
  clearLimit,
  clearMeasureHaving,
  clearPivot,
  columnFilters,
  cycleMeasureAgg,
  cycleOrderBy,
  filterBadge,
  groupCountByProjection,
  measureLabel,
  orderDir,
  orderIndex,
  removeGroupBy,
  removeMeasure,
  removeProjection,
  setColumnFilters,
  setGroupByGrain,
  setLimit,
  setMeasureHaving,
} from "@/lib/desktop/sql-builder"
import { cn } from "@/lib/utils"

export type FilterKind = "text" | "numeric" | "date"

const GRAINS: RollupGrain[] = ["year", "quarter", "month", "week", "day", "hour"]
const COMPARE_OPS: RollupCompareOp[] = [">", ">=", "<", "<=", "=", "!="]

const PILL = "group inline-flex max-w-[240px] items-center gap-1 rounded-full border border-chrome-border/50 bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors"
const POPOVER = "absolute left-0 top-full z-50 mt-1 rounded-md border border-chrome-border bg-chrome-bg/95 p-2 shadow-lg backdrop-blur"

type EditFn = (transform: (s: RollupSpec) => RollupSpec) => void
type ProbeFn = (column: RollupFilter["column"], search?: string) => Promise<{ values: (string | number | null)[]; truncated: boolean }>

interface RollupShelfProps {
  spec: RollupSpec
  /** Apply a pure spec transform; the host rebuilds SQL + reruns. */
  onEdit: EditFn
  /** Re-pivot with a new temporal grain (async re-probe at the host). */
  onRepivot?: (grain: RollupGrain) => void
  /** Probe distinct source values for a column (filter multi-select). */
  onProbeValues?: ProbeFn
  /** Filter UI variant for a source column. */
  columnKind?: (name: string) => FilterKind
}

/**
 * Editable view of a column-aggregate window's `RollupSpec` — the sibling
 * of the chart shelf and the params chip bar. Pills remove on ✕; measure
 * pills cycle their aggregate on click and carry a HAVING filter; group-by
 * pills carry a WHERE filter (type-specific) and a grain dropdown; a Top-N
 * chip caps rows. Filters on non-grouped columns surface as standalone
 * chips so a hand-written WHERE stays visible.
 */
export function RollupShelf({ spec, onEdit, onRepivot, onProbeValues, columnKind }: RollupShelfProps) {
  const pivot = spec.pivot ?? null
  const showDivider = spec.groupBy.length > 0 && spec.measures.length > 0
  const havingFor = (id: string) => spec.having?.find((h) => h.measureId === id)
  const kindOf = (name: string): FilterKind => columnKind?.(name) ?? "text"
  const orderCount = spec.orderBy?.length ?? 0
  const sortFor = (ref: string): SortInfo => {
    const dir = orderDir(spec, ref)
    const idx = orderIndex(spec, ref)
    return { dir, badge: orderCount > 1 && idx >= 0 ? String(idx + 1) : null }
  }

  // Filters whose column isn't a group-by dim → shown as standalone chips.
  const groupedNames = new Set(spec.groupBy.map((t) => t.column.name.toLowerCase()))
  const orphanColumns = useMemo(() => {
    const seen = new Set<string>()
    const out: RollupFilter["column"][] = []
    for (const f of spec.filters ?? []) {
      const key = f.column.name.toLowerCase()
      if (groupedNames.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push(f.column)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.filters, spec.groupBy])

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-chrome-border/60 bg-chrome-bg/40 px-2 py-1.5">
      <span className="select-none text-[9px] uppercase tracking-wider text-chrome-text/70">Rollup</span>

      {spec.groupBy.map((term) => (
        <GroupPill
          key={`g:${term.column.name}`}
          term={term}
          filters={columnFilters(spec, term.column.name)}
          kind={kindOf(term.column.name)}
          sort={sortFor(term.column.name)}
          onCycleSort={() => onEdit((s) => cycleOrderBy(s, term.column.name))}
          onEdit={onEdit}
          onProbeValues={onProbeValues}
        />
      ))}

      {showDivider ? <Divider /> : null}

      {spec.measures.map((m) => (
        <MeasurePill
          key={`m:${m.id}`}
          measure={m}
          having={havingFor(m.id)}
          sort={sortFor(m.alias)}
          onCycleSort={() => onEdit((s) => cycleOrderBy(s, m.alias))}
          onEdit={onEdit}
        />
      ))}

      {orphanColumns.length > 0 ? <Divider /> : null}
      {orphanColumns.map((col) => (
        <FilterChip
          key={`f:${col.name}`}
          column={col}
          filters={columnFilters(spec, col.name)}
          kind={kindOf(col.name)}
          onEdit={onEdit}
          onProbeValues={onProbeValues}
        />
      ))}

      {(spec.projections?.length ?? 0) > 0 ? (
        <>
          <Divider />
          {(spec.projections ?? []).map((proj) => {
            const composed =
              spec.groupBy.some((t) => t.column.name.toLowerCase() === proj.alias.toLowerCase()) ||
              spec.measures.some((m) => m.column?.name?.toLowerCase() === proj.alias.toLowerCase())
            return <SemanticPill key={`p:${proj.id}`} proj={proj} composed={composed} onEdit={onEdit} />
          })}
        </>
      ) : null}

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

/** A semantic-projection pill (rvbbit scalar op). Compose it into the rollup:
 *  text/bool → "count" (group & count by the value); float8 → "avg". Once
 *  composed (its column is grouped/aggregated) only remove remains. */
function SemanticPill({
  proj,
  composed,
  onEdit,
}: {
  proj: SemanticProjection
  composed: boolean
  onEdit: EditFn
}) {
  const numeric = proj.returnType === "float8"
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]"
      style={{
        borderColor: "color-mix(in oklch, var(--brand-operators) 45%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--brand-operators) 12%, transparent)",
        color: "var(--brand-operators)",
      }}
      title={`rvbbit.${proj.operator}(${proj.column.name})${composed ? "" : ` — click to ${numeric ? "average" : "group & count"}`}`}
    >
      <Sparkles className="h-3 w-3" />
      <span className="font-mono text-foreground/85">{proj.alias}</span>
      {!composed ? (
        <button
          type="button"
          onClick={() => onEdit((s) => (numeric ? aggregateProjection(s, proj, "avg") : groupCountByProjection(s, proj)))}
          className="rounded px-1 font-medium uppercase tracking-wider hover:bg-foreground/10"
        >
          {numeric ? "avg" : "count"}
        </button>
      ) : null}
      <RemoveBtn onRemove={() => onEdit((s) => removeProjection(s, proj.id))} />
    </span>
  )
}

interface SortInfo { dir: "asc" | "desc" | null; badge: string | null }

/** Sort toggle on a pill: none → asc → desc → none. */
function SortButton({ sort, onCycle }: { sort: SortInfo; onCycle: () => void }) {
  const Icon = sort.dir === "desc" ? SortDescending : SortAscending
  return (
    <span
      role="button"
      onClick={(e) => { e.stopPropagation(); onCycle() }}
      title={sort.dir ? `sorted ${sort.dir} — click to ${sort.dir === "asc" ? "flip to desc" : "clear"}` : "sort"}
      className={cn(
        "ml-0.5 inline-flex items-center gap-0.5 rounded-full",
        sort.dir
          ? "bg-main/15 px-1 text-[9px] text-main hover:bg-main/25"
          : "h-3.5 w-3.5 justify-center text-chrome-text/40 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100",
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {sort.dir && sort.badge ? <span>{sort.badge}</span> : null}
    </span>
  )
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

function GroupPill({
  term,
  filters,
  kind,
  sort,
  onCycleSort,
  onEdit,
  onProbeValues,
}: {
  term: RollupGroupTerm
  filters: RollupFilter[]
  kind: FilterKind
  sort: SortInfo
  onCycleSort: () => void
  onEdit: EditFn
  onProbeValues?: ProbeFn
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [menu, setMenu] = useState<null | "grain" | "filter">(null)
  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(null) }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [menu])

  const badge = filterBadge(filters)
  const name = term.column.name
  return (
    <span ref={ref} className="relative inline-flex">
      <span className={PILL} title={`GROUP BY ${name}${term.grain ? ` (${term.grain})` : ""}`}>
        <Layers className="h-3 w-3 shrink-0 text-main/75" />
        <span className="truncate">{name}</span>
        {term.grain ? (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === "grain" ? null : "grain")) }}
            className="ml-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded-full bg-foreground/[0.07] px-1 text-[9px] text-chrome-text/85 hover:bg-foreground/[0.14] hover:text-foreground"
            title="change grain"
          >
            {term.grain}
            <ChevronDown className="h-2 w-2" />
          </span>
        ) : null}
        {badge ? (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === "filter" ? null : "filter")) }}
            className="ml-0.5 cursor-pointer rounded-full bg-main/15 px-1 text-[9px] text-main hover:bg-main/25"
            title="edit filter"
          >
            {badge}
          </span>
        ) : (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === "filter" ? null : "filter")) }}
            className="ml-0.5 inline-grid h-3.5 w-3.5 place-items-center rounded-full text-chrome-text/40 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
            title="filter (WHERE)"
          >
            <Filter className="h-2.5 w-2.5" />
          </span>
        )}
        <SortButton sort={sort} onCycle={onCycleSort} />
        <RemoveBtn onRemove={() => onEdit((s) => removeGroupBy(s, name))} />
      </span>
      {menu === "grain" && term.grain ? (
        <GrainMenu value={term.grain} onPick={(g) => { setMenu(null); onEdit((s) => setGroupByGrain(s, name, g)) }} />
      ) : null}
      {menu === "filter" ? (
        <FilterPopover
          column={term.column}
          kind={kind}
          filters={filters}
          onProbeValues={onProbeValues}
          onApply={(next) => { setMenu(null); onEdit((s) => setColumnFilters(s, name, next)) }}
          onClear={() => { setMenu(null); onEdit((s) => clearColumnFilters(s, name)) }}
        />
      ) : null}
    </span>
  )
}

/** Standalone chip for a WHERE filter on a column that isn't grouped. */
function FilterChip({
  column,
  filters,
  kind,
  onEdit,
  onProbeValues,
}: {
  column: RollupFilter["column"]
  filters: RollupFilter[]
  kind: FilterKind
  onEdit: EditFn
  onProbeValues?: ProbeFn
}) {
  const { open, setOpen, ref } = usePopover()
  const name = column.name
  return (
    <span ref={ref} className="relative inline-flex">
      <span
        role="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(PILL, "cursor-pointer hover:border-main/50")}
        title={`WHERE ${name}`}
      >
        <Filter className="h-3 w-3 shrink-0 text-main/75" />
        <span className="truncate">{name}</span>
        <span className="rounded-full bg-main/15 px-1 text-[9px] text-main">{filterBadge(filters)}</span>
        <RemoveBtn onRemove={(e) => { e.stopPropagation(); onEdit((s) => clearColumnFilters(s, name)) }} />
      </span>
      {open ? (
        <FilterPopover
          column={column}
          kind={kind}
          filters={filters}
          onProbeValues={onProbeValues}
          onApply={(next) => { setOpen(false); onEdit((s) => setColumnFilters(s, name, next)) }}
          onClear={() => { setOpen(false); onEdit((s) => clearColumnFilters(s, name)) }}
        />
      ) : null}
    </span>
  )
}

type FilterColumn = RollupFilter["column"]

function FilterPopover({
  column,
  kind,
  filters,
  onProbeValues,
  onApply,
  onClear,
}: {
  column: FilterColumn
  kind: FilterKind
  filters: RollupFilter[]
  onProbeValues?: ProbeFn
  onApply: (next: RollupFilter[]) => void
  onClear: () => void
}) {
  return (
    <div className={cn(POPOVER, "min-w-[210px] space-y-1.5")}>
      <div className="truncate text-[9px] uppercase tracking-wider text-chrome-text/70">filter {column.name}</div>
      {kind === "text"
        ? <TextFilter column={column} filters={filters} probe={onProbeValues} onApply={onApply} onClear={onClear} />
        : <RangeFilter column={column} kind={kind} filters={filters} onApply={onApply} onClear={onClear} />}
    </div>
  )
}

function ApplyClear({ canClear, onApply, onClear }: { canClear: boolean; onApply: () => void; onClear: () => void }) {
  return (
    <div className="flex items-center gap-1 pt-0.5">
      <button type="button" onClick={onApply} className="rounded bg-main/20 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-main/30">Apply</button>
      {canClear ? (
        <button type="button" onClick={onClear} className="rounded px-2 py-0.5 text-[10px] text-chrome-text hover:bg-danger/15 hover:text-danger">Clear</button>
      ) : null}
    </div>
  )
}

function TextFilter({
  column,
  filters,
  probe,
  onApply,
  onClear,
}: {
  column: FilterColumn
  filters: RollupFilter[]
  probe?: ProbeFn
  onApply: (next: RollupFilter[]) => void
  onClear: () => void
}) {
  const existingIn = filters.find((f) => f.op === "in")
  const [selected, setSelected] = useState<Map<string, string | number | null>>(() => {
    const m = new Map<string, string | number | null>()
    for (const v of existingIn?.values ?? []) m.set(String(v), v)
    return m
  })
  const [search, setSearch] = useState("")
  const [fetched, setFetched] = useState<(string | number | null)[]>([])
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    if (!probe) return
    let cancelled = false
    const h = setTimeout(async () => {
      setLoading(true)
      const res = await probe(column, search)
      if (cancelled) return
      setFetched(res.values)
      setTruncated(res.truncated)
      setLoading(false)
    }, search ? 250 : 0)
    return () => { cancelled = true; clearTimeout(h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Always show selected values; append fetched ones not already selected.
  const display = useMemo(() => {
    const out: (string | number | null)[] = []
    const seen = new Set<string>()
    for (const v of selected.values()) { out.push(v); seen.add(String(v)) }
    for (const v of fetched) { const k = String(v); if (!seen.has(k)) { out.push(v); seen.add(k) } }
    return out
  }, [selected, fetched])

  const toggle = (v: string | number | null) => setSelected((prev) => {
    const m = new Map(prev)
    const k = String(v)
    if (m.has(k)) m.delete(k); else m.set(k, v)
    return m
  })
  const addTyped = () => {
    const t = search.trim()
    if (!t) return
    setSelected((prev) => new Map(prev).set(t, t))
    setSearch("")
  }
  const apply = () => {
    const vals = [...selected.values()]
    if (vals.length) onApply([{ column, op: "in", values: vals }])
    else onClear()
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 rounded border border-chrome-border/60 bg-doc-bg px-1">
        <Search className="h-3 w-3 shrink-0 text-chrome-text/55" />
        <input
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addTyped() }}
          placeholder={probe ? "search values…" : "type a value, Enter"}
          className="w-full bg-transparent py-0.5 text-[10px] text-foreground outline-none placeholder:text-chrome-text/40"
        />
      </div>
      <div className="max-h-40 overflow-auto rounded border border-chrome-border/40">
        {loading && display.length === 0 ? (
          <div className="px-2 py-2 text-[10px] text-chrome-text/50">loading…</div>
        ) : display.length === 0 ? (
          <div className="px-2 py-2 text-[10px] text-chrome-text/50">no values</div>
        ) : (
          display.map((v) => {
            const checked = selected.has(String(v))
            return (
              <button
                key={String(v)}
                type="button"
                onClick={() => toggle(v)}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2 py-0.5 text-left font-mono text-[10px]",
                  checked ? "bg-main/15 text-foreground" : "text-chrome-text hover:bg-foreground/10",
                )}
              >
                <span className={cn("inline-grid h-3 w-3 shrink-0 place-items-center rounded-sm border", checked ? "border-main bg-main/30" : "border-chrome-border/70")}>
                  {checked ? <span className="h-1.5 w-1.5 rounded-[1px] bg-main" /> : null}
                </span>
                <span className="truncate">{v === null ? "∅ null" : String(v)}</span>
              </button>
            )
          })
        )}
      </div>
      {truncated ? <div className="text-[9px] text-chrome-text/45">showing most common — search to narrow</div> : null}
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-chrome-text/55">{selected.size} selected</span>
        <ApplyClear canClear={!!existingIn} onApply={apply} onClear={onClear} />
      </div>
    </div>
  )
}

function RangeFilter({
  column,
  kind,
  filters,
  onApply,
  onClear,
}: {
  column: FilterColumn
  kind: FilterKind
  filters: RollupFilter[]
  onApply: (next: RollupFilter[]) => void
  onClear: () => void
}) {
  const gte = filters.find((f) => f.op === "gte" || f.op === "gt")
  const lte = filters.find((f) => f.op === "lte" || f.op === "lt")
  const [lo, setLo] = useState(gte?.value != null ? String(gte.value) : "")
  const [hi, setHi] = useState(lte?.value != null ? String(lte.value) : "")
  const inputType = kind === "date" ? "date" : "number"

  const coerce = (s: string): string | number | null => {
    if (kind === "numeric") { const n = Number(s); return Number.isFinite(n) ? n : null }
    return s
  }
  const apply = () => {
    const next: RollupFilter[] = []
    const loV = lo.trim(), hiV = hi.trim()
    if (loV) { const v = coerce(loV); if (v !== null) next.push({ column, op: "gte", value: v }) }
    if (hiV) { const v = coerce(hiV); if (v !== null) next.push({ column, op: "lte", value: v }) }
    if (next.length) onApply(next); else onClear()
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <input
          type={inputType}
          value={lo}
          autoFocus
          onChange={(e) => setLo(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") apply() }}
          placeholder="min"
          className="w-full rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
        />
        <span className="text-chrome-text/50">–</span>
        <input
          type={inputType}
          value={hi}
          onChange={(e) => setHi(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") apply() }}
          placeholder="max"
          className="w-full rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
        />
      </div>
      <ApplyClear canClear={!!(gte || lte)} onApply={apply} onClear={onClear} />
    </div>
  )
}

function MeasurePill({
  measure: m,
  having,
  sort,
  onCycleSort,
  onEdit,
}: {
  measure: RollupMeasure
  having?: RollupHavingTerm
  sort: SortInfo
  onCycleSort: () => void
  onEdit: EditFn
}) {
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
        <SortButton sort={sort} onCycle={onCycleSort} />
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
  // When explicit pill sorts drive the order, the limit is just a row cap —
  // label it "Limit N" rather than implying a Top-N-by-measure ranking.
  const explicitOrder = (spec.orderBy?.length ?? 0) > 0
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
          <span className="truncate">
            {explicitOrder ? `Limit ${limit.n}` : `${limit.dir === "asc" ? "Bottom" : "Top"} ${limit.n} · ${rankLabel}`}
          </span>
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
