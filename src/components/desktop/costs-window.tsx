"use client"

/**
 * Costs window. One workspace, five linked zones:
 *   - Header (range + filter chips + total)
 *   - Brushable timeline (Vega-Lite interval selection)
 *   - Operator breakdown (HTML bars)
 *   - Backend/model breakdown (HTML bars)
 *   - Audit health bar (one-line summary, segments clickable)
 *   - Receipts table (row → Query Lens, status → filter)
 *
 * Every panel reads from + writes to a single CostsFilter. The
 * timeline brush updates `brushRange`; clicking anywhere else toggles
 * one of the single-axis filters (operator/model/auditStatus).
 *
 * See /rvbbit/docs/COSTS_UI_CONTRACT.md for the data contract.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { VegaEmbed } from "react-vega"
import type { Result as VegaEmbedResult } from "vega-embed"
import { DollarSign, RefreshCw, X } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { CostsPayload, DesktopWindowState } from "@/lib/desktop/types"
import {
  DEFAULT_FILTER,
  fetchCostsBundle,
  statusColor,
  type AuditStatus,
  type CostStatus,
  type CostByBackendModelRow,
  type CostByOperatorRow,
  type CostReceiptRow,
  type CostsBundle,
  type CostsFilter,
  type CostsWindowDays,
} from "@/lib/rvbbit/costs"
import { themeFingerprint, vegaConfigFromTheme } from "@/lib/desktop/chart-theme"

interface CostsWindowProps {
  window: DesktopWindowState
  payload: CostsPayload
  activeConnectionId: string | null
  onOpenQueryLens: (queryId: string) => void
  onOpenOperator: (operatorName: string) => void
  onChangePayload: (mutate: (payload: CostsPayload) => CostsPayload) => void
}

export function CostsWindow({
  payload,
  activeConnectionId,
  onOpenQueryLens,
  onOpenOperator,
}: CostsWindowProps) {
  const [filter, setFilter] = useState<CostsFilter>(() => {
    const init = payload.initialFilter
    return init
      ? { ...DEFAULT_FILTER, ...init, operator: init.operator ?? null, model: init.model ?? null, auditStatus: (init.auditStatus as AuditStatus | null) ?? null, queryId: init.queryId ?? null }
      : DEFAULT_FILTER
  })
  const [bundle, setBundle] = useState<CostsBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    setError(null)
    try {
      const b = await fetchCostsBundle(activeConnectionId, filter)
      setBundle(b)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId, filter])

  // Refetch on filter change.
  useEffect(() => {
    void reload()
  }, [reload])

  // Mutators — each panel calls these.
  const setWindowDays = (d: CostsWindowDays) =>
    setFilter((f) => ({ ...f, windowDays: d, brushRange: null }))
  const setBrush = (range: { startIso: string; endIso: string } | null) =>
    setFilter((f) => ({ ...f, brushRange: range }))
  const toggleOperator = (name: string) =>
    setFilter((f) => ({ ...f, operator: f.operator === name ? null : name }))
  const toggleModel = (name: string) =>
    setFilter((f) => ({ ...f, model: f.model === name ? null : name }))
  const toggleAuditStatus = (s: AuditStatus) =>
    setFilter((f) => ({ ...f, auditStatus: f.auditStatus === s ? null : s }))
  const clearFilters = () =>
    setFilter((f) => ({
      ...f,
      brushRange: null,
      operator: null,
      model: null,
      auditStatus: null,
      costStatus: null,
      queryId: null,
    }))

  const hasFilters =
    filter.brushRange != null ||
    filter.operator != null ||
    filter.model != null ||
    filter.auditStatus != null ||
    filter.costStatus != null ||
    filter.queryId != null

  return (
    <div className="flex h-full min-h-0 flex-col text-foreground">
      <CostsHeader
        filter={filter}
        total={bundle?.total.total_cost_usd ?? 0}
        receipts={bundle?.total.receipts ?? 0}
        loading={loading}
        onSetWindowDays={setWindowDays}
        onClearFilters={clearFilters}
        onRefresh={() => void reload()}
        hasFilters={hasFilters}
        onClearOperator={() => setFilter((f) => ({ ...f, operator: null }))}
        onClearModel={() => setFilter((f) => ({ ...f, model: null }))}
        onClearAuditStatus={() => setFilter((f) => ({ ...f, auditStatus: null }))}
        onClearBrush={() => setBrush(null)}
        onClearQueryId={() => setFilter((f) => ({ ...f, queryId: null }))}
      />

      {error ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <TimelinePanel byBucket={bundle?.byBucket ?? []} filter={filter} onBrush={setBrush} />

      <div className="grid min-h-0 grid-cols-2 gap-px bg-chrome-border/40">
        <OperatorPanel
          rows={bundle?.byOperator ?? []}
          selected={filter.operator}
          onToggle={toggleOperator}
          onOpenInspector={onOpenOperator}
        />
        <BackendPanel
          rows={bundle?.byBackendModel ?? []}
          selectedModel={filter.model}
          onToggleModel={toggleModel}
        />
      </div>

      <HealthBar
        summary={bundle?.summary ?? null}
        selected={filter.auditStatus}
        onToggle={toggleAuditStatus}
      />

      <ReceiptsTable
        rows={bundle?.receipts ?? []}
        loading={loading}
        onOpenQueryLens={onOpenQueryLens}
        onOpenOperator={onOpenOperator}
        onToggleAuditStatus={toggleAuditStatus}
        selectedAudit={filter.auditStatus}
      />
    </div>
  )
}

// ─── Header ──────────────────────────────────────────────────────────

function CostsHeader({
  filter,
  total,
  receipts,
  loading,
  hasFilters,
  onSetWindowDays,
  onClearFilters,
  onRefresh,
  onClearOperator,
  onClearModel,
  onClearAuditStatus,
  onClearBrush,
  onClearQueryId,
}: {
  filter: CostsFilter
  total: number
  receipts: number
  loading: boolean
  hasFilters: boolean
  onSetWindowDays: (d: CostsWindowDays) => void
  onClearFilters: () => void
  onRefresh: () => void
  onClearOperator: () => void
  onClearModel: () => void
  onClearAuditStatus: () => void
  onClearBrush: () => void
  onClearQueryId: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px]">
      <DollarSign className="h-3.5 w-3.5 text-rvbbit-accent" />
      <span className="text-chrome-text">last</span>
      <RangePicker
        value={filter.windowDays}
        onChange={onSetWindowDays}
        disabled={filter.brushRange != null}
      />

      {filter.brushRange ? (
        <FilterChip
          label="brush"
          value={`${filter.brushRange.startIso.slice(0, 10)} → ${filter.brushRange.endIso.slice(0, 10)}`}
          onClear={onClearBrush}
        />
      ) : null}
      {filter.operator ? (
        <FilterChip label="operator" value={filter.operator} onClear={onClearOperator} />
      ) : null}
      {filter.model ? <FilterChip label="model" value={filter.model} onClear={onClearModel} /> : null}
      {filter.auditStatus ? (
        <FilterChip label="status" value={filter.auditStatus} onClear={onClearAuditStatus} />
      ) : null}
      {filter.queryId ? (
        <FilterChip label="query" value={filter.queryId.slice(0, 8)} onClear={onClearQueryId} />
      ) : null}
      {hasFilters ? (
        <button
          onClick={onClearFilters}
          className="ml-1 text-[10px] uppercase tracking-wider text-chrome-text hover:text-foreground"
        >
          clear all
        </button>
      ) : null}

      <div className="flex-1" />

      <span className="tabular-nums text-chrome-text">
        {fmtCost(total)} · {receipts.toLocaleString()} receipts
      </span>
      <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading} title="Refresh">
        <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
      </Button>
    </div>
  )
}

function RangePicker({
  value,
  onChange,
  disabled,
}: {
  value: CostsWindowDays
  onChange: (d: CostsWindowDays) => void
  disabled?: boolean
}) {
  const opts: { value: CostsWindowDays; label: string }[] = [
    { value: 1, label: "1d" },
    { value: 7, label: "7d" },
    { value: 30, label: "30d" },
  ]
  return (
    <div className={cn("flex gap-0.5 rounded border border-chrome-border/60", disabled && "opacity-40")}>
      {opts.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2 py-0.5 text-[10px] uppercase tracking-wider",
            value === o.value && !disabled
              ? "bg-main/15 text-foreground"
              : "text-chrome-text hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string
  value: string
  onClear: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-main/40 bg-main/10 px-2 py-0.5 text-[10px] text-foreground">
      <span className="text-chrome-text">{label}</span>
      <span className="font-medium">{value}</span>
      <button onClick={onClear} className="hover:text-danger" aria-label={`Clear ${label}`}>
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}

// ─── Timeline (Vega-Lite, brushable) ─────────────────────────────────

interface TimelinePanelProps {
  byBucket: Array<{ bucket: string; total_cost_usd: number; calls: number; pending_calls: number; estimated_calls: number; uncosted_calls: number; error_calls: number }>
  filter: CostsFilter
  onBrush: (range: { startIso: string; endIso: string } | null) => void
}

function TimelinePanel({ byBucket, filter, onBrush }: TimelinePanelProps) {
  const [themeStamp, setThemeStamp] = useState(0)
  useEffect(() => {
    if (typeof window === "undefined") return
    const o = new MutationObserver(() => setThemeStamp((n) => n + 1))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] })
    return () => o.disconnect()
  }, [])

  const themeConfig = useMemo(() => {
    themeFingerprint()
    return vegaConfigFromTheme()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeStamp])

  const values = useMemo(
    () =>
      byBucket
        .map((r) => ({ bucket: r.bucket, cost: r.total_cost_usd }))
        .filter((r) => Number.isFinite(Date.parse(r.bucket)) && Number.isFinite(r.cost)),
    [byBucket],
  )
  const hasTimelineData = values.length > 0

  // Axis configuration — adapts to the chosen window so labels never
  // collapse into "May 24" repeating. The labelExpr inspects each
  // tick's value and switches between a date format and a time format
  // based on whether the tick lands at midnight (day boundary) or
  // inside a day (hour position). Tick count + interval are set
  // per-window so we don't oversample.
  const xAxis = useMemo(() => {
    const win = filter.windowDays
    if (win === 1) {
      // 24h view: ~6 ticks across the day. tickMinStep keeps the
      // spacing to at least 1 hour so we don't get "6 PM" twice in
      // a row from sub-hour subdivision. labelExpr swaps to a date
      // label whenever the tick lands on midnight so a multi-day
      // brush still reads clearly.
      return {
        title: null,
        grid: false,
        tickCount: 6,
        tickMinStep: 3600000,
        labelExpr:
          "timeFormat(datum.value, '%H%M') === '0000' ? timeFormat(datum.value, '%b %-d') : timeFormat(datum.value, '%-I %p')",
      }
    }
    if (win === 7) {
      // 7d view: ~7 daily ticks (one per day). Each tick lands at
      // midnight; "Mon 24" gives weekday + day without repeating
      // the month name. First day of the month gets the month name
      // for orientation.
      return {
        title: null,
        grid: false,
        tickCount: 7,
        tickMinStep: 86400000,
        labelExpr:
          "timeFormat(datum.value, '%d') === '01' ? timeFormat(datum.value, '%b %-d') : timeFormat(datum.value, '%a %-d')",
      }
    }
    // 30d view: ~6 ticks across the month. Show month name when the
    // tick lands on the 1st (month rollover), day-of-month otherwise.
    return {
      title: null,
      grid: false,
      tickCount: 6,
      tickMinStep: 86400000 * 3,
      labelExpr:
        "timeFormat(datum.value, '%d') === '01' ? timeFormat(datum.value, '%b %-d') : timeFormat(datum.value, '%b %-d')",
    }
  }, [filter.windowDays])

  const tooltipFormat = filter.windowDays === 1 ? "%a %-d %b · %-I %p" : "%a %b %-d"

  const spec = useMemo(() => {
    return {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      config: themeConfig,
      data: { values },
      width: "container",
      height: 80,
      autosize: { type: "fit", contains: "padding", resize: true },
      params: [{ name: "brush", select: { type: "interval", encodings: ["x"] } }],
      mark: { type: "area", interpolate: "monotone", line: true, opacity: 0.85 },
      encoding: {
        x: { field: "bucket", type: "temporal", axis: xAxis },
        y: { field: "cost", type: "quantitative", axis: { title: null, format: "$.2f", tickCount: 3 } },
        tooltip: [
          { field: "bucket", type: "temporal", title: "when", format: tooltipFormat },
          { field: "cost", type: "quantitative", title: "spend", format: "$.4f" },
        ],
      },
    } as Record<string, unknown>
  }, [values, themeConfig, xAxis, tooltipFormat])

  // Brush signal listener
  const viewRef = useRef<VegaEmbedResult | null>(null)
  const onBrushRef = useRef(onBrush)
  useEffect(() => {
    onBrushRef.current = onBrush
  }, [onBrush])

  const handleEmbed = useCallback((res: VegaEmbedResult) => {
    viewRef.current = res
    try {
      res.view.addSignalListener("brush", (_name, value) => {
        const v = value as { bucket?: [number | string, number | string] } | undefined
        if (!v || !v.bucket || !Array.isArray(v.bucket) || v.bucket.length !== 2) {
          onBrushRef.current(null)
          return
        }
        const [a, b] = v.bucket
        const startIso = new Date(a).toISOString()
        const endIso = new Date(b).toISOString()
        onBrushRef.current({ startIso, endIso })
      })
    } catch {
      // Signal absent — ignore.
    }
  }, [])

  // ResizeObserver to keep the area chart fitting its container.
  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === "undefined") return
    let rafId = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const view = viewRef.current?.view
        if (!view) return
        try {
          const host = (view.container?.() ?? null) as HTMLElement | null
          if (host) {
            view.signal("width", host.clientWidth).signal("height", host.clientHeight)
          }
          view.resize()
          void view.runAsync()
        } catch {
          // ignore
        }
      })
    })
    observer.observe(el)
  }, [])

  if (!hasTimelineData) {
    return (
      <div className="border-b border-chrome-border bg-doc-bg px-2 pt-1">
        <div className="flex items-center justify-between px-1 pb-0.5 text-[10px] uppercase tracking-wider text-chrome-text">
          <span>30-day cost timeline · no buckets in this range</span>
        </div>
        <div className="grid h-[100px] place-items-center text-[11px] text-chrome-text/70">
          no cost timeline data in this range
        </div>
      </div>
    )
  }

  return (
    <div className="border-b border-chrome-border bg-doc-bg px-2 pt-1">
      <div className="flex items-center justify-between px-1 pb-0.5 text-[10px] uppercase tracking-wider text-chrome-text">
        <span>30-day cost timeline · drag to brush, click outside to clear</span>
        {filter.brushRange ? (
          <button
            onClick={() => onBrush(null)}
            className="text-[10px] uppercase tracking-wider text-main hover:text-foreground"
          >
            clear brush
          </button>
        ) : null}
      </div>
      <div ref={containerRefCallback} className="relative h-[100px] w-full">
        <VegaEmbed
          spec={spec as Parameters<typeof VegaEmbed>[0]["spec"]}
          options={{ actions: false, renderer: "svg", tooltip: { theme: "dark" } }}
          onEmbed={handleEmbed}
          className="absolute inset-0"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  )
}

// ─── Operator breakdown ──────────────────────────────────────────────

function OperatorPanel({
  rows,
  selected,
  onToggle,
  onOpenInspector,
}: {
  rows: CostByOperatorRow[]
  selected: string | null
  onToggle: (name: string) => void
  onOpenInspector: (name: string) => void
}) {
  const max = rows[0]?.total_cost_usd ?? 0
  return (
    <PanelFrame title="by operator">
      {rows.length === 0 ? (
        <EmptyHint>no operator activity in this range</EmptyHint>
      ) : (
        <ul className="divide-y divide-chrome-border/30">
          {rows.map((r) => (
            <li
              key={r.operator}
              className={cn(
                "group flex items-center gap-2 px-3 py-1 hover:bg-foreground/[0.04]",
                selected === r.operator && "bg-main/10",
              )}
            >
              <button
                onClick={() => onToggle(r.operator)}
                className="min-w-0 flex-1 text-left"
                title={selected === r.operator ? "Click to clear filter" : "Click to filter by this operator"}
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[12px] text-foreground">{r.operator}</span>
                  <span className="text-[10px] text-chrome-text tabular-nums">{r.receipts.toLocaleString()}</span>
                </div>
                <Bar
                  total={r.total_cost_usd}
                  max={max}
                  segments={[
                    {
                      value: Math.max(r.total_cost_usd, 0),
                      color: r.estimated_calls > 0 && r.total_cost_usd > 0 ? "var(--info)" : "var(--success)",
                    },
                  ]}
                  pendingCount={r.pending_calls}
                  uncostedCount={r.uncosted_calls}
                  errorCount={r.error_calls}
                  estimatedCount={r.estimated_calls}
                />
              </button>
              <span className="w-20 shrink-0 text-right text-[11px] tabular-nums">
                {fmtCost(r.total_cost_usd)}
              </span>
              <button
                onClick={() => onOpenInspector(r.operator)}
                className="opacity-0 transition-opacity group-hover:opacity-100 text-[10px] uppercase tracking-wider text-main hover:underline"
                title="Open operator inspector"
              >
                inspect
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelFrame>
  )
}

// ─── Backend / model breakdown ───────────────────────────────────────

function BackendPanel({
  rows,
  selectedModel,
  onToggleModel,
}: {
  rows: CostByBackendModelRow[]
  selectedModel: string | null
  onToggleModel: (name: string) => void
}) {
  // Group by (backend, model) — sum across statuses for the bar, but
  // keep the status breakdown for the segment colors.
  type Group = { backend: string; model: string; total: number; statuses: Map<CostStatus, { calls: number; cost: number }> }
  const grouped = useMemo(() => {
    const m = new Map<string, Group>()
    for (const r of rows) {
      const key = `${r.backend}\u001f${r.model_or_tool}`
      let g = m.get(key)
      if (!g) {
        g = { backend: r.backend, model: r.model_or_tool, total: 0, statuses: new Map() }
        m.set(key, g)
      }
      g.total += r.total_cost_usd
      const cur = g.statuses.get(r.status) ?? { calls: 0, cost: 0 }
      cur.calls += r.calls
      cur.cost += r.total_cost_usd
      g.statuses.set(r.status, cur)
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total)
  }, [rows])

  const max = grouped[0]?.total ?? 0
  return (
    <PanelFrame title="by backend · model">
      {grouped.length === 0 ? (
        <EmptyHint>no backend traffic in this range</EmptyHint>
      ) : (
        <ul className="divide-y divide-chrome-border/30">
          {grouped.map((g) => {
            const key = `${g.backend}/${g.model}`
            const isSelected = selectedModel === g.model
            const segments: { value: number; color: string }[] = []
            for (const status of ["settled", "estimated", "pending", "uncosted", "free", "error"] as CostStatus[]) {
              const v = g.statuses.get(status)
              if (v && v.cost > 0) segments.push({ value: v.cost, color: statusColor(status) })
            }
            // For uncosted/free where cost is zero, encode call count as a width hint
            const zeroSegments: { calls: number; color: string }[] = []
            for (const status of ["uncosted", "free"] as CostStatus[]) {
              const v = g.statuses.get(status)
              if (v && v.cost === 0 && v.calls > 0) zeroSegments.push({ calls: v.calls, color: statusColor(status) })
            }
            const callsTotal = Array.from(g.statuses.values()).reduce((a, b) => a + b.calls, 0)
            return (
              <li
                key={key}
                className={cn(
                  "group px-3 py-1 hover:bg-foreground/[0.04]",
                  isSelected && "bg-main/10",
                )}
              >
                <button
                  onClick={() => onToggleModel(g.model)}
                  className="block w-full text-left"
                  title={isSelected ? "Click to clear" : "Click to filter by this model"}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[12px] text-foreground">{g.model}</span>
                    <span className="text-[10px] text-chrome-text">{g.backend}</span>
                    <span className="ml-auto text-[10px] text-chrome-text tabular-nums">{callsTotal.toLocaleString()}</span>
                    <span className="w-20 text-right text-[11px] tabular-nums">
                      {g.total > 0 ? fmtCost(g.total) : <span className="text-chrome-text/60">—</span>}
                    </span>
                  </div>
                  <Bar
                    total={g.total}
                    max={max}
                    segments={segments}
                    zeroCostSegments={zeroSegments}
                  />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </PanelFrame>
  )
}

// ─── Audit health bar ────────────────────────────────────────────────

function HealthBar({
  summary,
  selected,
  onToggle,
}: {
  summary: CostsBundle["summary"]
  selected: AuditStatus | null
  onToggle: (s: AuditStatus) => void
}) {
  if (!summary) {
    return <div className="border-y border-chrome-border bg-chrome-bg/30 px-3 py-1 text-[10px] uppercase tracking-wider text-chrome-text/60">audit · loading</div>
  }
  const r = summary.receipts
  const total = r.total || 1
  type Seg = { key: AuditStatus | "no_chargeable_sub_calls"; label: string; n: number; color: string }
  const segs: Seg[] = [
    { key: "ok", label: "ok", n: r.ok, color: statusColor("ok") },
    { key: "missing_cost_events", label: "missing", n: r.missing_cost_events, color: statusColor("missing_cost_events") },
    { key: "stale_pending", label: "stale", n: r.stale_pending, color: statusColor("stale_pending") },
    { key: "pending", label: "pending", n: r.pending, color: statusColor("pending") },
    { key: "uncosted", label: "uncosted", n: r.uncosted, color: statusColor("uncosted") },
    { key: "errors", label: "errors", n: r.errors, color: statusColor("errors") },
    { key: "no_chargeable_sub_calls", label: "no-charge", n: r.no_chargeable_sub_calls, color: statusColor("no_chargeable_sub_calls") },
  ]
  return (
    <div className="border-y border-chrome-border bg-chrome-bg/30">
      {/* Visual bar */}
      <div className="flex h-1.5 w-full">
        {segs
          .filter((s) => s.n > 0)
          .map((s) => (
            <div
              key={s.key}
              style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
              title={`${s.label} · ${s.n}`}
            />
          ))}
      </div>
      {/* Clickable legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1 text-[10px] uppercase tracking-wider">
        <span className="text-chrome-text">audit</span>
        {segs.map((s) => {
          const filterable = s.key !== "no_chargeable_sub_calls"
          const isSelected = selected === s.key && filterable
          return (
            <button
              key={s.key}
              disabled={!filterable || s.n === 0}
              onClick={() => filterable && onToggle(s.key as AuditStatus)}
              className={cn(
                "flex items-center gap-1 transition-colors",
                s.n === 0 ? "opacity-40" : "hover:text-foreground",
                isSelected ? "text-foreground" : "text-chrome-text",
                filterable && s.n > 0 ? "cursor-pointer" : "cursor-default",
              )}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.color, outline: isSelected ? "1px solid var(--foreground)" : "none", outlineOffset: "1px" }}
              />
              <span className="tabular-nums">{s.n.toLocaleString()}</span>
              <span>{s.label}</span>
            </button>
          )
        })}
        {summary.receipt_queue_pending > 0 ? (
          <span className="text-warning">queue {summary.receipt_queue_pending}</span>
        ) : null}
      </div>
    </div>
  )
}

// ─── Receipts table ──────────────────────────────────────────────────

function ReceiptsTable({
  rows,
  loading,
  onOpenQueryLens,
  onOpenOperator,
  onToggleAuditStatus,
  selectedAudit,
}: {
  rows: CostReceiptRow[]
  loading: boolean
  onOpenQueryLens: (queryId: string) => void
  onOpenOperator: (operatorName: string) => void
  onToggleAuditStatus: (s: AuditStatus) => void
  selectedAudit: AuditStatus | null
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-chrome-border bg-chrome-bg/30 px-3 py-1 text-[10px] uppercase tracking-wider text-chrome-text">
        <span>receipts ({rows.length} shown)</span>
        {loading ? <span>loading…</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <EmptyHint>no receipts in this filter</EmptyHint>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 z-10 bg-doc-bg text-[10px] uppercase tracking-wider text-chrome-text">
              <tr className="border-b border-chrome-border/60">
                <th className="px-3 py-1 text-left font-normal">operator</th>
                <th className="px-2 py-1 text-left font-normal">model</th>
                <th className="px-2 py-1 text-right font-normal">cost</th>
                <th className="px-2 py-1 text-right font-normal">tokens in/out</th>
                <th className="px-2 py-1 text-right font-normal">ms</th>
                <th className="px-2 py-1 text-left font-normal">status</th>
                <th className="px-2 py-1 text-right font-normal">age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const status = (r.audit_status ?? (r.error ? "errors" : "no_chargeable_sub_calls")) as AuditStatus
                const isSelectedStatus = selectedAudit === status
                return (
                  <tr
                    key={r.receipt_id}
                    onClick={() => {
                      if (r.query_id) onOpenQueryLens(r.query_id)
                    }}
                    className={cn(
                      "border-b border-chrome-border/20 hover:bg-foreground/[0.04]",
                      r.query_id ? "cursor-pointer" : "cursor-default",
                      r.error && "bg-danger/[0.05]",
                    )}
                    title={r.query_id ? "Click row to open in Query Lens" : "No query_id — row not deep-linkable"}
                  >
                    <td className="px-3 py-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenOperator(r.operator)
                        }}
                        className="text-foreground hover:underline"
                      >
                        {r.operator}
                      </button>
                    </td>
                    <td className="truncate px-2 py-0.5 text-chrome-text">
                      {r.model ?? <span className="text-chrome-text/40">—</span>}
                    </td>
                    <td className="px-2 py-0.5 text-right tabular-nums">
                      {r.total_cost_usd > 0 ? (
                        fmtCost(r.total_cost_usd)
                      ) : (
                        <span className="text-chrome-text/60">—</span>
                      )}
                      {r.estimated_calls > 0 ? (
                        <span className="ml-1 text-[9px] uppercase text-info">est</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-0.5 text-right tabular-nums text-chrome-text">
                      {r.n_tokens_in.toLocaleString()}/{r.n_tokens_out.toLocaleString()}
                    </td>
                    <td className="px-2 py-0.5 text-right tabular-nums text-chrome-text">
                      {fmtMs(r.latency_ms)}
                    </td>
                    <td className="px-2 py-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (status !== "no_chargeable_sub_calls") onToggleAuditStatus(status)
                        }}
                        className={cn(
                          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
                          isSelectedStatus && "outline outline-1 outline-offset-1 outline-main",
                        )}
                        style={{ background: `${statusColor(status)}22`, color: statusColor(status) }}
                        title={`audit status: ${status}${status !== "no_chargeable_sub_calls" ? " · click to filter" : ""}`}
                      >
                        {status}
                      </button>
                    </td>
                    <td className="px-2 py-0.5 text-right text-chrome-text/70">
                      {fmtAge(r.invocation_at)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────

function PanelFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1 text-[10px] uppercase tracking-wider text-chrome-text">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" style={{ maxHeight: 260 }}>
        {children}
      </div>
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center px-3 py-4 text-[11px] text-chrome-text/70">{children}</div>
}

interface BarSegment {
  value: number
  color: string
}
function Bar({
  total,
  max,
  segments,
  pendingCount,
  uncostedCount,
  errorCount,
  estimatedCount,
  zeroCostSegments,
}: {
  total: number
  max: number
  segments: BarSegment[]
  pendingCount?: number
  uncostedCount?: number
  errorCount?: number
  estimatedCount?: number
  zeroCostSegments?: { calls: number; color: string }[]
}) {
  // Full bar width is proportional to (this row's cost) / (max cost).
  // Zero-cost rows still get a small visual via zeroCostSegments so they
  // don't disappear (uncosted/free have cost=0 but matter).
  const wPct = max > 0 ? Math.max((total / max) * 100, 1) : 0
  const showZeroHint = zeroCostSegments && zeroCostSegments.length > 0 && total === 0
  return (
    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-chrome-border/30">
      {showZeroHint ? (
        <div className="flex h-full" style={{ width: "30%" }}>
          {zeroCostSegments.map((s, i) => (
            <div key={i} style={{ flex: s.calls, background: s.color, opacity: 0.5 }} />
          ))}
        </div>
      ) : (
        <div className="flex h-full" style={{ width: `${wPct}%` }}>
          {segments.map((s, i) => (
            <div key={i} style={{ flex: Math.max(s.value, 0.0001), background: s.color }} />
          ))}
        </div>
      )}
      {(pendingCount || uncostedCount || errorCount || estimatedCount) && total > 0 ? (
        // tiny right-aligned hint dots for sub-call status counts
        <div className="-mt-1.5 flex justify-end gap-0.5 pr-0.5">
          {estimatedCount! > 0 ? <span className="h-1 w-1 rounded-full" style={{ background: statusColor("estimated") }} title={`${estimatedCount} estimated`} /> : null}
          {pendingCount! > 0 ? <span className="h-1 w-1 rounded-full" style={{ background: statusColor("pending") }} title={`${pendingCount} pending`} /> : null}
          {uncostedCount! > 0 ? <span className="h-1 w-1 rounded-full" style={{ background: statusColor("uncosted") }} title={`${uncostedCount} uncosted`} /> : null}
          {errorCount! > 0 ? <span className="h-1 w-1 rounded-full" style={{ background: statusColor("error") }} title={`${errorCount} errored`} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`
  if (usd < 1) return `$${usd.toFixed(4)}`
  if (usd < 10) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtAge(iso: string): string {
  const now = Date.now()
  const t = new Date(iso).getTime()
  const dMs = now - t
  if (dMs < 60_000) return `${Math.max(1, Math.round(dMs / 1000))}s`
  if (dMs < 3_600_000) return `${Math.round(dMs / 60_000)}m`
  if (dMs < 86_400_000) return `${Math.round(dMs / 3_600_000)}h`
  return `${Math.round(dMs / 86_400_000)}d`
}
