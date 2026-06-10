"use client"

// ⊞ KPI Board — a (metric × data-time) matrix read from the materialized
// observation log (rvbbit.metric_board). Rows are metrics (search-filtered),
// columns are data-time buckets, each cell is the headline value tinted by its
// KPI verdict (subtle green/red). The fast historical floor; restatement,
// def-time scrub, drill-down and threshold what-if layer on top later.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Search, RefreshCw, Table2, X, ChevronRight, Clock } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchMetricBoard,
  listMetrics,
  resolveMetricSql,
  recomputeCell,
  checkMetric,
  boardCellHeadline,
  type MetricBoardCell,
  type MetricSummary,
  type MetricVerdict,
  type BoardBucket,
} from "@/lib/rvbbit/metrics"
import { inputCls, VerdictBadge, fmtTime } from "./metric-shared"
import { useWorkspaceActive } from "./workspace-active-context"
import { usePresentMode } from "@/lib/desktop/present-mode"
import type { MetricBoardPayload } from "@/lib/desktop/types"

type EmitParamInput = {
  sourceWindowId: string
  sourceBlockName: string
  sourceTitle: string
  field: string
  value: unknown
  type?: string
}

/** A live-recomputed cell, alongside the value originally reported. */
type Recomputed = { headline: number | null; verdict: MetricVerdict | null; stored: number | null }

interface MetricBoardWindowProps {
  payload: MetricBoardPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  windowId: string
  onOpenInspector?: (name: string) => void
  onOpenSqlData?: (sql: string, title: string) => void
  onEmitParam?: (input: EmitParamInput) => void
  onChangePayload?: (mut: (p: MetricBoardPayload) => MetricBoardPayload) => void
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-chrome-text/50">{k}</span>
      <span className="truncate tabular-nums text-chrome-text/90">{v}</span>
    </div>
  )
}

const RANGES: { label: string; days: number; bucket: BoardBucket }[] = [
  { label: "30d", days: 30, bucket: "day" },
  { label: "90d", days: 90, bucket: "day" },
  { label: "26w", days: 182, bucket: "week" },
  { label: "12mo", days: 365, bucket: "month" },
]

function compactNum(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, "") + "k"
  if (Number.isInteger(n)) return String(n)
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

function fmtCol(ms: number, bucket: BoardBucket): string {
  const d = new Date(ms)
  if (bucket === "month") return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
  if (bucket === "hour") return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
  if (bucket === "raw")
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Verdict tint for a cell: subtle green (pass) / red (fail) / none. */
function tint(ok: boolean | null | undefined): string {
  if (ok === true) return "bg-emerald-500/12 text-emerald-100"
  if (ok === false) return "bg-red-500/15 text-red-100"
  return "text-chrome-text/90"
}

/** A roll-up "temperature" color for a pass-rate %: a continuous gradient routed
 *  through the theme tokens danger(0%) → warning(50%) → success(100%), so a
 *  category's health reads at a glance. Null pct = no KPI data this bucket. */
function heatColor(pct: number | null): { bg: string; fg: string } | null {
  if (pct == null) return null
  const p = Math.max(0, Math.min(100, pct))
  const stop =
    p >= 50
      ? `color-mix(in oklch, var(--success) ${Math.round((p - 50) * 2)}%, var(--warning))`
      : `color-mix(in oklch, var(--warning) ${Math.round(p * 2)}%, var(--danger))`
  return { bg: `color-mix(in oklch, ${stop} 28%, transparent)`, fg: `color-mix(in oklch, ${stop} 70%, var(--foreground))` }
}

/** Tiny inline sparkline of a row's headline series. */
function Sparkline({ points }: { points: (number | null)[] }) {
  const vals = points.filter((p): p is number => p != null)
  if (vals.length < 2) return <span className="text-chrome-text/25">—</span>
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const w = 64
  const h = 16
  const step = w / Math.max(points.length - 1, 1)
  const pts = points
    .map((p, i) => (p == null ? null : `${(i * step).toFixed(1)},${(h - ((p - min) / span) * (h - 2) - 1).toFixed(1)}`))
    .filter(Boolean)
    .join(" ")
  return (
    <svg width={w} height={h} className="text-amber-300/70">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function MetricBoardWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  windowId,
  onOpenInspector,
  onOpenSqlData,
  onEmitParam,
  onChangePayload,
}: MetricBoardWindowProps) {
  const wsActive = useWorkspaceActive()
  // Present mode: the control bar (range/rollup/mode/def-time/refresh) and the
  // footer legend are board-configuration chrome — drop them; the KPI matrix,
  // cell drill popovers, and what-if slider all stay live.
  const present = usePresentMode()
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [cells, setCells] = useState<MetricBoardCell[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [rangeIdx, setRangeIdx] = useState(payload.rangeIdx ?? 1)
  const range = RANGES[Math.min(rangeIdx, RANGES.length - 1)]
  const [showAll, setShowAll] = useState(payload.showAll ?? false)
  // Effective column grain: "raw" shows every materialization; otherwise the
  // range's date_trunc bucket.
  const bucket: BoardBucket = showAll ? "raw" : range.bucket
  const [sel, setSel] = useState<{ cell: MetricBoardCell; x: number; y: number } | null>(null)
  const [drilling, setDrilling] = useState(false)
  // group the matrix by category › subcategory; each group header shows a rolled-up
  // health "temperature" (% of its KPIs passing) per bucket. Collapse = roll up.
  const [groupBy, setGroupBy] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const [mode, setMode] = useState<"value" | "restate">(payload.mode ?? "value")
  const [defDate, setDefDate] = useState<string>(payload.defDate ?? "")
  const [recompute, setRecompute] = useState<Map<string, Recomputed>>(new Map())
  const [whatIf, setWhatIf] = useState<{ metric: string; target: number } | null>(null)
  const [whatIfVerdicts, setWhatIfVerdicts] = useState<Map<string, boolean | null>>(new Map())
  const defActive = mode === "value" && defDate !== ""
  const clearWhatIf = useCallback(() => {
    setWhatIf(null)
    setWhatIfVerdicts(new Map())
  }, [])

  const selectRange = useCallback(
    (i: number) => {
      setRangeIdx(i)
      onChangePayload?.((p) => ({ ...p, rangeIdx: i }))
    },
    [onChangePayload],
  )
  const toggleShowAll = useCallback(() => {
    setShowAll((v) => {
      const next = !v
      onChangePayload?.((p) => ({ ...p, showAll: next }))
      return next
    })
  }, [onChangePayload])
  const chooseMode = useCallback(
    (m: "value" | "restate") => {
      setMode(m)
      onChangePayload?.((p) => ({ ...p, mode: m }))
    },
    [onChangePayload],
  )
  const chooseDefDate = useCallback(
    (d: string) => {
      setDefDate(d)
      onChangePayload?.((p) => ({ ...p, defDate: d }))
    },
    [onChangePayload],
  )

  // Drill: resolve the exact metric SQL at this cell's definition + params,
  // prefixed with the rvbbit AS OF for its data-time, and open it as a real,
  // runnable query window — the reproducible query behind a historical number.
  const drill = useCallback(
    async (cell: MetricBoardCell) => {
      if (!activeConnectionId) return
      setDrilling(true)
      const defIso = cell.defAsOf ? new Date(cell.defAsOf).toISOString() : null
      const { sql, error: e } = await resolveMetricSql(activeConnectionId, cell.metric, cell.params ?? {}, defIso)
      setDrilling(false)
      if (e || !sql) {
        setError(e ?? "Could not resolve SQL")
        return
      }
      const dataIso = cell.dataAsOf ? new Date(cell.dataAsOf).toISOString() : null
      const composed = dataIso ? `-- rvbbit: as_of ${dataIso}\n${sql}` : sql
      onOpenSqlData?.(composed, `${cell.metric} @ ${fmtCol(cell.bucketMs, bucket)}`)
      setSel(null)
    },
    [activeConnectionId, onOpenSqlData, bucket],
  )

  const emit = useCallback(
    (cell: MetricBoardCell) => {
      onEmitParam?.({
        sourceWindowId: windowId,
        sourceBlockName: cell.metric,
        sourceTitle: "KPI Board",
        field: cell.metric,
        value: boardCellHeadline(cell),
        type: "number",
      })
      setSel(null)
    },
    [onEmitParam, windowId],
  )

  const load = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    const [m, b] = await Promise.all([
      listMetrics(activeConnectionId),
      fetchMetricBoard(activeConnectionId, { days: range.days, bucket }),
    ])
    setMetrics(m.metrics)
    setCells(b.cells)
    setError(m.error ?? b.error)
    setLoaded(true)
  }, [activeConnectionId, hasRvbbit, range.days, bucket])

  // Load on mount / connection / range, and refresh when the desktop is shown.
  useEffect(() => {
    if (!wsActive) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await load()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [wsActive, load])

  // Live recompute — Restatement (vs the stored observation, at the cell's OWN
  // def so only DATA changes show) or def-time scrub (recompute under the chosen
  // definition). Cancelable + progressive; here it's per-cell client-side, which
  // is fine at this scale (batch on the server when grids get large).
  useEffect(() => {
    const needs = mode === "restate" || defActive
    if (!needs || !activeConnectionId || cells.length === 0) return
    let cancelled = false
    const out = new Map<string, Recomputed>()
    void (async () => {
      for (const c of cells) {
        if (cancelled) return
        const dataIso = c.dataAsOf ? new Date(c.dataAsOf).toISOString() : null
        const defIso =
          mode === "restate"
            ? c.defAsOf ? new Date(c.defAsOf).toISOString() : null
            : defDate ? new Date(`${defDate}T23:59:59.999Z`).toISOString() : null // end-of-day: "as defined by the end of that date"
        const r = await recomputeCell(activeConnectionId, c.metric, c.params ?? {}, defIso, dataIso)
        if (cancelled) return
        out.set(`${c.metric} ${c.bucketMs}`, { headline: r.headline, verdict: r.verdict, stored: boardCellHeadline(c) })
        setRecompute(new Map(out))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, defActive, defDate, cells, activeConnectionId])

  // Threshold what-if: recolor a KPI's whole row by re-running its check with an
  // overridden {target} (debounced). The metric value is unchanged — only the
  // verdict moves — answering "how many past periods breach at target X?".
  useEffect(() => {
    if (!whatIf || !activeConnectionId) return
    const { metric, target } = whatIf
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        const out = new Map<string, boolean | null>()
        for (const c of cells) {
          if (cancelled) return
          if (c.metric !== metric) continue
          const dataIso = c.dataAsOf ? new Date(c.dataAsOf).toISOString() : null
          const defIso = c.defAsOf ? new Date(c.defAsOf).toISOString() : null
          const { verdict } = await checkMetric(activeConnectionId, metric, { ...(c.params ?? {}), target }, defIso, dataIso)
          if (cancelled) return
          out.set(`${c.metric} ${c.bucketMs}`, verdict?.ok ?? null)
          setWhatIfVerdicts(new Map(out))
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [whatIf, cells, activeConnectionId])

  const { columns, byKey } = useMemo(() => {
    const colSet = new Set<number>()
    const byKey = new Map<string, MetricBoardCell>()
    for (const c of cells) {
      colSet.add(c.bucketMs)
      byKey.set(`${c.metric} ${c.bucketMs}`, c)
    }
    return { columns: [...colSet].sort((a, b) => a - b), byKey }
  }, [cells])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const fromCatalog = metrics.map((m) => m.name)
    const fromCells = [...new Set(cells.map((c) => c.metric))]
    const all = [...new Set([...fromCatalog, ...fromCells])].sort()
    return all.filter((n) => !q || n.toLowerCase().includes(q))
  }, [metrics, cells, search])

  const anyCategorized = useMemo(() => metrics.some((m) => m.category), [metrics])

  // Ordered render list: category/subcategory group headers interleaved with their
  // metric rows. A null category sorts last as "(uncategorized)"; a category-only
  // metric (no subcategory) sits directly under its category.
  type RR =
    | { type: "group"; depth: 0 | 1; key: string; label: string; members: string[] }
    | { type: "metric"; name: string; depth: number }
  const renderRows = useMemo<RR[]>(() => {
    if (!groupBy) return rows.map((name) => ({ type: "metric", name, depth: 0 }))
    const metaOf = (n: string) => metrics.find((m) => m.name === n)
    const cmpNull = (a: string | null, b: string | null) => (a == null ? 1 : b == null ? -1 : a.localeCompare(b))
    const cats = [...new Set(rows.map((n) => metaOf(n)?.category ?? null))].sort(cmpNull)
    const out: RR[] = []
    for (const cat of cats) {
      const catKey = cat ?? " uncat"
      const catMembers = rows.filter((n) => (metaOf(n)?.category ?? null) === cat)
      out.push({ type: "group", depth: 0, key: catKey, label: cat ?? "(uncategorized)", members: catMembers })
      if (collapsed.has(catKey)) continue
      const subs = [...new Set(catMembers.map((n) => metaOf(n)?.subcategory ?? null))].sort(cmpNull)
      for (const sub of subs) {
        const subMembers = catMembers.filter((n) => (metaOf(n)?.subcategory ?? null) === sub)
        if (sub == null) {
          for (const n of subMembers) out.push({ type: "metric", name: n, depth: 1 })
        } else {
          const subKey = `${catKey} ${sub}`
          out.push({ type: "group", depth: 1, key: subKey, label: sub, members: subMembers })
          if (collapsed.has(subKey)) continue
          for (const n of subMembers) out.push({ type: "metric", name: n, depth: 2 })
        }
      }
    }
    return out
  }, [groupBy, rows, metrics, collapsed])

  // % of a group's KPIs passing their check at a bucket (the roll-up temperature).
  const rollup = (members: string[], col: number): { pct: number | null; passing: number; total: number } => {
    let passing = 0
    let total = 0
    for (const name of members) {
      const c = byKey.get(`${name} ${col}`) // byKey keys use a NUL separator
      if (c?.verdict && c.verdict.ok != null) {
        total++
        if (c.verdict.ok) passing++
      }
    }
    return total > 0 ? { pct: (passing / total) * 100, passing, total } : { pct: null, passing: 0, total: 0 }
  }

  const categoryKeys = useMemo(
    () => new Set(rows.map((n) => (metrics.find((m) => m.name === n)?.category ?? null) ?? " uncat")),
    [rows, metrics],
  )
  const toggleCollapse = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const rollUp = () => setCollapsed(new Set(categoryKeys)) // collapse every category
  const rollDown = () => setCollapsed(new Set()) // expand everything

  // What a cell shows, given the mode: stored value, def-scrubbed recompute,
  // or restatement (recomputed-now, tinted amber when it diverges from what
  // was reported — i.e. the underlying data was backfilled/corrected).
  const cellDisp = (c: MetricBoardCell | undefined) => {
    if (!c) return { text: <span className="text-chrome-text/20">·</span>, cls: "text-chrome-text/20", title: undefined as string | undefined }
    const key = `${c.metric} ${c.bucketMs}`
    const baseTitle = `${c.metric} @ ${fmtCol(c.bucketMs, bucket)}${c.dataGeneration != null ? ` · gen ${c.dataGeneration}` : ""}`
    if (whatIf && c.metric === whatIf.metric) {
      const ok = whatIfVerdicts.get(key)
      const h = boardCellHeadline(c)
      return {
        text: h != null ? compactNum(h) : <span className="text-chrome-text/20">·</span>,
        cls: cn(tint(ok), "ring-1 ring-inset ring-amber-400/50"),
        title: `${baseTitle} · what-if target ${whatIf.target}: ${ok === false ? "BREACH" : ok === true ? "ok" : "…"}`,
      }
    }
    if (mode === "restate") {
      const r = recompute.get(key)
      if (!r) return { text: "…", cls: "text-chrome-text/30", title: "computing…" }
      const stored = r.stored
      const now = r.headline
      const changed = stored != null && now != null && Math.abs(now - stored) > Math.max(1e-9, Math.abs(stored) * 1e-6)
      return {
        text: now != null ? compactNum(now) : "—",
        cls: changed ? "bg-amber-500/25 font-medium text-amber-50" : "text-chrome-text/45",
        title: `reported ${stored != null ? compactNum(stored) : "—"} → now ${now != null ? compactNum(now) : "—"}${changed ? "  ·  RESTATED" : "  ·  unchanged"}`,
      }
    }
    if (defActive) {
      const r = recompute.get(key)
      if (!r) return { text: "…", cls: "text-chrome-text/30", title: "computing…" }
      return {
        text: r.headline != null ? compactNum(r.headline) : "—",
        cls: cn(tint(r.verdict?.ok), "italic"),
        title: `${baseTitle} · recomputed as defined on ${defDate}`,
      }
    }
    const h = boardCellHeadline(c)
    return {
      text: h != null ? compactNum(h) : <span className="text-chrome-text/20">·</span>,
      cls: tint(c.verdict?.ok),
      title: `${baseTitle}${c.verdict?.target != null ? ` · target ${c.verdict.target}` : ""}`,
    }
  }

  // Popover-scoped derivations for the selected cell (explain + what-if).
  const selMeta = sel ? metrics.find((m) => m.name === sel.cell.metric) ?? null : null
  const selIsKpi = !!selMeta?.checkSql
  const selRowCells = sel ? cells.filter((c) => c.metric === sel.cell.metric) : []
  const selTarget = sel?.cell.verdict?.target != null ? Number(sel.cell.verdict.target) : 0
  const whatIfOnSel = !!(whatIf && sel && whatIf.metric === sel.cell.metric)
  const whatIfTarget = whatIfOnSel ? whatIf!.target : selTarget
  const sliderMax = Math.max(selTarget * 2, ...selRowCells.map((c) => boardCellHeadline(c) ?? 0), 1)
  const breaches = whatIfOnSel
    ? selRowCells.filter((c) => whatIfVerdicts.get(`${c.metric} ${c.bucketMs}`) === false).length
    : 0

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text/70">
        No pg_rvbbit extension on this connection.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* header / controls */}
      {present ? null : (
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Table2 className="h-4 w-4 text-amber-300/80" />
        <span className="font-medium">KPI Board</span>
        <div className="relative ml-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter metrics…"
            className={cn(inputCls, "h-7 w-44 pl-7")}
          />
        </div>
        <div className="flex items-center overflow-hidden rounded border border-chrome-border">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => selectRange(i)}
              className={cn(
                "px-2 py-1 text-[11px] transition-colors",
                i === rangeIdx ? "bg-amber-400/20 text-amber-100" : "text-chrome-text/70 hover:bg-chrome-bg/60",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        {/* rollup vs every materialization */}
        <button
          onClick={toggleShowAll}
          title={
            showAll
              ? "Showing every materialization — one column per observation. Click to roll up by day/week/month."
              : "Rolled up to the range's bucket (multiple same-bucket materializations collapse to the latest). Click to show ALL materializations."
          }
          className={cn(
            "rounded border px-2 py-1 text-[11px] transition-colors",
            showAll
              ? "border-amber-400/50 bg-amber-400/20 text-amber-100"
              : "border-chrome-border text-chrome-text/70 hover:bg-chrome-bg/60",
          )}
        >
          {showAll ? "All materializations" : "Roll up"}
        </button>
        {/* mode: stored value/def-scrub vs restatement */}
        <div className="flex items-center overflow-hidden rounded border border-chrome-border">
          {(["value", "restate"] as const).map((m) => (
            <button
              key={m}
              onClick={() => chooseMode(m)}
              title={
                m === "restate"
                  ? "Reported value vs a live recompute at the same axes — exposes silent backfills/corrections"
                  : "Stored observations (or, with a def-time set, recomputed under that definition)"
              }
              className={cn(
                "px-2 py-1 text-[11px] transition-colors",
                mode === m ? "bg-amber-400/20 text-amber-100" : "text-chrome-text/70 hover:bg-chrome-bg/60",
              )}
            >
              {m === "value" ? "Value" : "Restate"}
            </button>
          ))}
        </div>
        {/* def-time scrub */}
        <label
          className={cn(
            "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
            mode === "restate"
              ? "border-chrome-border opacity-40"
              : defActive
                ? "border-amber-400/50 text-amber-100"
                : "border-chrome-border text-chrome-text/70",
          )}
          title="Recompute the whole board as the metrics & thresholds were defined on this date"
        >
          <Clock className="h-3.5 w-3.5" />
          <span>def</span>
          <input
            type="date"
            disabled={mode === "restate"}
            value={defDate}
            onChange={(e) => chooseDefDate(e.target.value)}
            className="bg-transparent text-[11px] text-inherit outline-none [color-scheme:dark]"
          />
          {defActive ? (
            <button onClick={() => chooseDefDate("")} className="text-chrome-text/50 hover:text-chrome-text" title="back to current definition">
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </label>
        {/* category grouping + roll-up health heatmap */}
        {anyCategorized ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setGroupBy((v) => !v)}
              title="Group rows by category › subcategory, with a rolled-up health heatmap (% of KPIs passing) per group"
              className={cn(
                "rounded border px-2 py-1 text-[11px] transition-colors",
                groupBy ? "border-amber-400/50 bg-amber-400/20 text-amber-100" : "border-chrome-border text-chrome-text/70 hover:bg-chrome-bg/60",
              )}
            >
              Group
            </button>
            {groupBy ? (
              <div className="flex items-center overflow-hidden rounded border border-chrome-border">
                <button onClick={rollUp} title="Collapse all categories (roll up to the heatmap)" className="px-2 py-1 text-[11px] text-chrome-text/70 hover:bg-chrome-bg/60">
                  roll up
                </button>
                <button onClick={rollDown} title="Expand all categories (roll down to metrics)" className="px-2 py-1 text-[11px] text-chrome-text/70 hover:bg-chrome-bg/60">
                  roll down
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {whatIf ? (
          <span className="flex items-center gap-1 rounded border border-amber-400/50 bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-100">
            what-if: {whatIf.metric} @ {compactNum(whatIf.target)}
            <button onClick={clearWhatIf} className="text-amber-200/70 hover:text-amber-100" title="clear what-if">
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : null}
        <button
          onClick={() => void load()}
          className="ml-auto flex items-center gap-1 rounded border border-chrome-border px-2 py-1 text-[11px] text-chrome-text/80 hover:bg-chrome-bg/60"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>
      )}

      {error ? (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200">{error}</div>
      ) : null}

      {/* matrix */}
      <div className="relative flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/60">
            {!loaded ? "Loading…" : "No metrics yet — define one in the Creator."}
          </div>
        ) : (
          <table className="border-separate border-spacing-0 text-[11px]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border-b border-r border-chrome-border bg-chrome-bg px-2 py-1.5 text-left font-medium text-chrome-text/70">
                  metric
                </th>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="sticky top-0 z-10 whitespace-nowrap border-b border-chrome-border bg-chrome-bg px-2.5 py-1.5 text-right font-medium tabular-nums text-chrome-text/60"
                  >
                    {fmtCol(col, bucket)}
                  </th>
                ))}
                <th className="sticky top-0 z-10 border-b border-l border-chrome-border bg-chrome-bg px-2 py-1.5 text-left font-medium text-chrome-text/50">
                  trend
                </th>
              </tr>
            </thead>
            <tbody>
              {renderRows.map((rr) => {
                if (rr.type === "group") {
                  const expanded = !collapsed.has(rr.key)
                  const kpiCount = rr.members.filter((n) => metrics.find((m) => m.name === n)?.checkSql).length
                  return (
                    <tr key={`g:${rr.key}`}>
                      <th
                        onClick={() => toggleCollapse(rr.key)}
                        style={{ paddingLeft: rr.depth * 12 + 6 }}
                        className={cn(
                          "sticky left-0 z-10 cursor-pointer select-none border-b border-r border-chrome-border bg-chrome-bg py-1 pr-2 text-left hover:bg-chrome-bg/70",
                          rr.depth === 0 ? "font-semibold text-foreground" : "font-medium text-chrome-text/85",
                        )}
                      >
                        <span className="flex items-center gap-1">
                          <ChevronRight className={cn("h-3 w-3 shrink-0 text-chrome-text/50 transition-transform", expanded && "rotate-90")} />
                          <span className="truncate">{rr.label}</span>
                          <span className="ml-1 shrink-0 text-[9px] uppercase tracking-wide text-chrome-text/40">{kpiCount} kpi</span>
                        </span>
                      </th>
                      {columns.map((col) => {
                        const r = rollup(rr.members, col)
                        const heat = heatColor(r.pct)
                        return (
                          <td
                            key={col}
                            title={r.pct != null ? `${rr.label} @ ${fmtCol(col, bucket)} · ${r.passing}/${r.total} KPIs passing (${Math.round(r.pct)}%)` : "no KPI data this period"}
                            style={heat ? { background: heat.bg, color: heat.fg } : undefined}
                            className={cn("border-b border-chrome-border/60 px-2.5 py-1 text-right text-[10px] font-medium tabular-nums", !heat && "text-chrome-text/20")}
                          >
                            {r.pct != null ? `${Math.round(r.pct)}%` : "·"}
                          </td>
                        )
                      })}
                      <td className="border-b border-l border-chrome-border/60 px-2 py-1">
                        <Sparkline points={columns.map((col) => rollup(rr.members, col).pct)} />
                      </td>
                    </tr>
                  )
                }
                const name = rr.name
                const meta = metrics.find((m) => m.name === name)
                const isKpi = !!meta?.checkSql
                const series = columns.map((col) => {
                  const c = byKey.get(`${name} ${col}`)
                  return c ? boardCellHeadline(c) : null
                })
                return (
                  <tr key={name} className="group">
                    <th
                      title={meta?.description ?? name}
                      onClick={() => onOpenInspector?.(name)}
                      style={{ paddingLeft: rr.depth * 12 + 8 }}
                      className="sticky left-0 z-10 cursor-pointer border-b border-r border-chrome-border bg-chrome-bg py-1 pr-2 text-left font-normal text-chrome-text/90 group-hover:bg-chrome-bg/70"
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            isKpi ? "bg-amber-300/80" : "bg-chrome-text/25",
                          )}
                          title={isKpi ? "KPI (has a check)" : "metric"}
                        />
                        <span className="truncate">{name}</span>
                      </span>
                    </th>
                    {columns.map((col) => {
                      const c = byKey.get(`${name} ${col}`)
                      const disp = cellDisp(c)
                      return (
                        <td
                          key={col}
                          title={disp.title}
                          onClick={
                            c
                              ? (e) => {
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setSel({ cell: c, x: rect.left, y: rect.bottom })
                                }
                              : undefined
                          }
                          className={cn(
                            "border-b border-chrome-border/60 px-2.5 py-1 text-right tabular-nums",
                            disp.cls,
                            c && "cursor-pointer hover:brightness-150",
                          )}
                        >
                          {disp.text}
                        </td>
                      )
                    })}
                    <td className="border-b border-l border-chrome-border/60 px-2 py-1">
                      <Sparkline points={series} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* cell popover — provenance + reproducible drill + param emit */}
      {sel ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setSel(null)} />
          <div
            className="fixed z-50 w-60 overflow-hidden rounded-md border border-chrome-border bg-chrome-bg shadow-2xl"
            style={{ left: Math.max(8, Math.min(sel.x, window.innerWidth - 248)), top: sel.y + 4 }}
          >
            <div className="flex items-center justify-between border-b border-chrome-border px-2.5 py-1.5">
              <span className="truncate text-[11px] font-medium">{sel.cell.metric}</span>
              <button onClick={() => setSel(null)} className="text-chrome-text/50 hover:text-chrome-text">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1 px-2.5 py-2 text-[11px]">
              <Row k="value" v={(() => { const h = boardCellHeadline(sel.cell); return h != null ? compactNum(h) : "—" })()} />
              {sel.cell.verdict ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-chrome-text/50">verdict</span>
                  <VerdictBadge verdict={sel.cell.verdict} />
                </div>
              ) : null}
              <Row k="data-time" v={fmtTime(sel.cell.dataAsOf)} />
              {sel.cell.dataGeneration != null ? <Row k="generation" v={`#${sel.cell.dataGeneration}`} /> : null}
              <Row k="def version" v={sel.cell.metricVersion != null ? `v${sel.cell.metricVersion}` : "—"} />
              <Row k="trigger" v={sel.cell.trigger} />
            </div>
            {/* explain-the-red + threshold what-if (KPI cells only) */}
            {selIsKpi ? (
              <div className="border-t border-chrome-border px-2.5 py-2 text-[11px]">
                <div className="mb-1 text-chrome-text/50">check</div>
                <code className="block whitespace-pre-wrap break-words rounded bg-black/25 px-1.5 py-1 text-[10px] leading-snug text-chrome-text/80">
                  {selMeta?.checkSql}
                </code>
                {sel.cell.verdict ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-chrome-text/70">
                    <span className="tabular-nums">value {sel.cell.verdict.value != null ? String(sel.cell.verdict.value) : "—"}</span>
                    <span className="text-chrome-text/30">·</span>
                    <span className="tabular-nums">target {sel.cell.verdict.target != null ? String(sel.cell.verdict.target) : "—"}</span>
                    <span className="text-chrome-text/30">→</span>
                    <span className={sel.cell.verdict.ok === false ? "font-medium text-red-300" : "font-medium text-emerald-300"}>
                      {sel.cell.verdict.ok === false ? "FAIL" : "PASS"}
                    </span>
                  </div>
                ) : null}
                <div className="mt-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-chrome-text/50">what-if target</span>
                    <input
                      type="number"
                      value={whatIfTarget}
                      onChange={(e) => setWhatIf({ metric: sel.cell.metric, target: Number(e.target.value) })}
                      className={cn(inputCls, "h-6 w-24 text-right")}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={sliderMax}
                    step={sliderMax / 100 || 1}
                    value={whatIfTarget}
                    onChange={(e) => setWhatIf({ metric: sel.cell.metric, target: Number(e.target.value) })}
                    className="w-full accent-amber-400"
                  />
                  {whatIfOnSel ? (
                    <div className="mt-1 flex items-center justify-between text-[10px]">
                      <span className="text-amber-200/80">
                        {breaches}/{selRowCells.length} period{selRowCells.length === 1 ? "" : "s"} breach at {compactNum(whatIfTarget)}
                      </span>
                      <button onClick={clearWhatIf} className="text-chrome-text/50 hover:text-chrome-text">
                        reset
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="flex flex-col border-t border-chrome-border text-[11px]">
              <button
                onClick={() => void drill(sel.cell)}
                className="flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-amber-400/10"
              >
                <span className="text-amber-100">{drilling ? "Resolving…" : "Open SQL & data"}</span>
                <ChevronRight className="h-3.5 w-3.5 text-amber-300/70" />
              </button>
              {onEmitParam ? (
                <button onClick={() => emit(sel.cell)} className="px-2.5 py-1.5 text-left hover:bg-chrome-bg/60">
                  Emit as param
                </button>
              ) : null}
              <button
                onClick={() => {
                  const h = boardCellHeadline(sel.cell)
                  void navigator.clipboard?.writeText(h != null ? String(h) : "")
                  setSel(null)
                }}
                className="px-2.5 py-1.5 text-left hover:bg-chrome-bg/60"
              >
                Copy value
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* footer */}
      {present ? null : (
      <div className="flex items-center gap-3 border-t border-chrome-border bg-chrome-bg/40 px-3 py-1 text-[10px] text-chrome-text/50">
        <span>{rows.length} metrics</span>
        <span>
          {columns.length} {bucket === "raw" ? "materializations" : `${bucket} buckets`}
        </span>
        {mode === "restate" ? (
          <span className="text-amber-200/70">restatement — reported vs recomputed-now</span>
        ) : defActive ? (
          <span className="text-amber-200/70">recomputed as defined on {defDate}</span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1">
          {mode === "restate" ? (
            <>
              <span className="h-2 w-2 rounded-sm bg-amber-500/50" /> restated
              <span className="ml-1.5 text-chrome-text/40">·</span>
              <span className="text-chrome-text/40">unchanged</span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-sm bg-emerald-500/40" /> pass
              <span className="ml-1.5 h-2 w-2 rounded-sm bg-red-500/40" /> fail
            </>
          )}
        </span>
      </div>
      )}
    </div>
  )
}
