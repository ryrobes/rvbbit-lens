"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  Database,
  Eye,
  GitBranch,
  Globe,
  Pause,
  Play,
  RefreshCw,
  TreeStructure,
  Wand2,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  Metric,
  Panel,
  Readout,
  useElementWidth,
} from "./instruments"
import {
  eventIdentity,
  fetchLensOverview,
  fetchLensTrace,
  fetchRecentQueryIds,
  SURFACE_COLOR,
  SURFACE_LABEL,
  type LensEvent,
  type LensOverview,
  type LensSurface,
  type LensTrace,
  type RecentQuery,
} from "@/lib/rvbbit/lens"
import { QueryLensOverview } from "./query-lens-overview"
import { X } from "@/lib/icons"
import type { KgEntitySource, KgSourceContext, QueryLensPayload } from "@/lib/desktop/types"

interface QueryLensWindowProps {
  payload: QueryLensPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenOperator: (name: string, receiptId?: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenMcpServer: (name: string) => void
  onOpenRouting: () => void
  onOpenKgEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

export function QueryLensWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenOperator,
  onOpenSpecialist,
  onOpenMcpServer,
  onOpenRouting,
  onOpenKgEntity,
  onOpenSourceRow,
}: QueryLensWindowProps) {
  const [recent, setRecent] = useState<RecentQuery[]>([])
  const [selected, setSelected] = useState<string | null>(payload.queryId ?? null)
  const [trace, setTrace] = useState<LensTrace | null>(null)
  const [overview, setOverview] = useState<LensOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [pasteInput, setPasteInput] = useState("")
  const [traceLoading, setTraceLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0
  /** Rolling window for the empty-state overview dashboard. */
  const overviewHours = 24

  const loadRecent = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchRecentQueryIds(activeConnectionId)
    setRecent(r.rows)
    setError(r.error ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId])

  const loadTrace = useCallback(
    async (queryId: string) => {
      if (!activeConnectionId) return
      setTraceLoading(true)
      const r = await fetchLensTrace(activeConnectionId, queryId)
      setTrace(r.trace)
      setError(r.error ?? null)
      setTraceLoading(false)
    },
    [activeConnectionId],
  )

  const loadOverview = useCallback(async () => {
    if (!activeConnectionId) return
    setOverviewLoading(true)
    const r = await fetchLensOverview(activeConnectionId, overviewHours)
    setOverview(r.overview)
    // Don't clobber the global error if only the overview failed; it
    // can degrade independently of the trace path.
    if (r.error && !selected) setError(r.error)
    setOverviewLoading(false)
  }, [activeConnectionId, overviewHours, selected])

  // Initial load
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await loadRecent()
      await loadOverview()
      if (selected) await loadTrace(selected)
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, hasRvbbit])

  // Poll recent list (the trace is historical, so it only refreshes
  // when the user picks a different query or hits reload).
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void loadRecent(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, loadRecent])

  // Poll overview on a longer cadence — it aggregates a 24h window, so
  // a tight refresh would mostly redraw the same chart. 15s keeps the
  // dashboard feeling alive without thrashing.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void loadOverview(), 15_000)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, loadOverview])

  const selectQuery = (qid: string) => {
    // Clicking the already-selected row toggles back to the overview
    // dashboard — same affordance as a tab close.
    if (selected === qid) {
      setSelected(null)
      setTrace(null)
      return
    }
    setSelected(qid)
    void loadTrace(qid)
  }

  const clearSelection = () => {
    setSelected(null)
    setTrace(null)
  }

  const handlePaste = () => {
    const v = pasteInput.trim()
    if (v) {
      selectQuery(v)
      setPasteInput("")
    }
  }

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Eye className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
            paused ? "bg-foreground/[0.05] text-chrome-text" : "bg-success/10 text-success",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              paused ? "bg-chrome-text" : "animate-pulse bg-success",
            )}
          />
          {paused ? "paused" : "live"}
        </span>
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Eye className="h-3.5 w-3.5 text-rvbbit-accent" />
          Query Lens
        </span>
        {selected ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span className="font-mono text-[11px] text-rvbbit-accent" title={selected}>
              {selected.slice(0, 8)}…
            </span>
            <button
              type="button"
              onClick={clearSelection}
              title="Back to the 24h overview dashboard"
              className="inline-flex h-5 items-center gap-1 rounded-full border border-chrome-border/60 bg-secondary-background px-1.5 text-[9px] uppercase tracking-wider text-chrome-text/70 hover:border-rvbbit-accent/40 hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" />
              overview
            </button>
          </>
        ) : (
          <>
            <span className="text-chrome-text/40">·</span>
            <span className="text-chrome-text/55">
              {overviewHours}h overview · pick a query to drill in
            </span>
          </>
        )}
        {trace && trace.events.length > 0 ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span className="tabular-nums">
              {fmtMs(trace.span.durationMs)} span · {fmtCount(trace.events.length)} events
            </span>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            title="Recent-queries refresh interval"
            className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            {REFRESH_OPTIONS_MS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume" : "Pause"}
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => {
              void loadRecent()
              void loadOverview()
              if (selected) void loadTrace(selected)
            }}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* left rail */}
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-chrome-border bg-chrome-bg/20">
          <div className="border-b border-chrome-border/60 p-2">
            <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-chrome-text/55">
              <span>Recent queries</span>
              <span className="font-mono normal-case tracking-normal text-chrome-text/45">
                {recent.length}
              </span>
            </div>
            <input
              value={pasteInput}
              onChange={(e) => setPasteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handlePaste()
                }
              }}
              placeholder="paste a query_id…"
              className="h-6 w-full rounded border border-chrome-border bg-doc-bg px-1.5 font-mono text-[10px] text-foreground outline-none focus:border-main/60"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {loading ? (
              <p className="px-2 py-3 text-center text-[10px] text-chrome-text/45">
                loading…
              </p>
            ) : recent.length === 0 ? (
              <p className="px-2 py-4 text-center text-[10px] leading-snug text-chrome-text/45">
                No queries with a query_id yet.
                <br />
                Run an rvbbit operator from SQL to populate.
              </p>
            ) : (
              recent.map((q) => (
                <RecentRow
                  key={q.queryId}
                  q={q}
                  active={q.queryId === selected}
                  onClick={() => selectQuery(q.queryId)}
                />
              ))
            )}
          </div>
        </aside>

        {/* main */}
        <main className="min-w-0 flex-1 overflow-auto">
          {!selected ? (
            <QueryLensOverview
              overview={overview}
              loading={overviewLoading}
              windowHours={overviewHours}
              onPickQuery={selectQuery}
            />
          ) : traceLoading && !trace ? (
            <div className="grid h-40 place-items-center text-[11px] text-chrome-text/55">
              loading trace…
            </div>
          ) : trace && trace.events.length === 0 ? (
            <div className="grid h-40 place-items-center text-center text-[11px] text-chrome-text/55">
              <div>
                <Eye className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
                No receipts or MCP calls found for this query_id.
              </div>
            </div>
          ) : trace ? (
            <LensView
              trace={trace}
              onOpenOperator={onOpenOperator}
              onOpenSpecialist={onOpenSpecialist}
              onOpenMcpServer={onOpenMcpServer}
              onOpenRouting={onOpenRouting}
              onOpenKgEntity={onOpenKgEntity}
              onOpenSourceRow={onOpenSourceRow}
            />
          ) : null}
        </main>
      </div>
    </div>
  )
}

// ── Recent rail row ─────────────────────────────────────────────────

function RecentRow({
  q,
  active,
  onClick,
}: {
  q: RecentQuery
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full border-b border-chrome-border/30 px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]",
        active && "bg-rvbbit-bg/60",
      )}
      title={q.queryId}
    >
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="font-mono tabular-nums text-chrome-text/70">
          {fmtAgo(q.lastAt)}
        </span>
        <span className="font-mono text-[9px] text-chrome-text/45">
          {q.queryId.slice(0, 8)}
        </span>
        <div className="flex-1" />
        {q.errorCount > 0 ? (
          <span className="text-danger">{q.errorCount} err</span>
        ) : null}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-foreground">
        {q.operators.map((o) => `rvbbit.${o}`).join(", ") || "—"}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[9px] tabular-nums text-chrome-text/55">
        <span>{q.receiptCount} receipt{q.receiptCount === 1 ? "" : "s"}</span>
        <span className="text-chrome-text/30">·</span>
        <span>{fmtMs(q.totalLatencyMs)}</span>
      </div>
    </button>
  )
}

// ── Main view ───────────────────────────────────────────────────────

function LensView({
  trace,
  onOpenOperator,
  onOpenSpecialist,
  onOpenMcpServer,
  onOpenRouting,
  onOpenKgEntity,
  onOpenSourceRow,
}: {
  trace: LensTrace
  onOpenOperator: (name: string, receiptId?: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenMcpServer: (name: string) => void
  onOpenRouting: () => void
  onOpenKgEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Peak concurrency over the span (max overlapping events) — surfaced in the
  // header so the chart's lane count has a number to read against.
  const peakConcurrency = useMemo(() => {
    const pts: Array<[number, number]> = []
    for (const e of trace.events) {
      pts.push([e.startAt, 1])
      pts.push([Math.max(e.endAt, e.startAt + 1), -1])
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let cur = 0
    let peak = 0
    for (const p of pts) {
      cur += p[1]
      if (cur > peak) peak = cur
    }
    return peak
  }, [trace.events])

  // The chronological list can be thousands of rows; render a capped window
  // (the flame above already shows everything) plus the expanded event.
  const TIMELINE_CAP = 60
  const timelineEvents = useMemo(() => {
    if (trace.events.length <= TIMELINE_CAP) return trace.events
    const head = trace.events.slice(0, TIMELINE_CAP)
    if (expandedId && !head.some((e) => e.id === expandedId)) {
      const sel = trace.events.find((e) => e.id === expandedId)
      if (sel) return [sel, ...head]
    }
    return head
  }, [trace.events, expandedId])

  return (
    <div className="space-y-2.5 p-2.5">
      <SummaryStrip trace={trace} />
      <Panel
        icon={Activity}
        title="Trace timeline"
        right={
          <span>
            {fmtMs(trace.span.durationMs)} · {trace.events.length} events · peak{" "}
            {peakConcurrency}× concurrent
          </span>
        }
      >
        <FlameStrip
          trace={trace}
          hoveredId={hoveredId}
          onHover={setHoveredId}
          onPick={(id) => setExpandedId((cur) => (cur === id ? null : id))}
        />
        <FlameLegend trace={trace} />
      </Panel>

      <Panel
        icon={Eye}
        title="Timeline"
        right={<span>chronological</span>}
      >
        <div className="space-y-1">
          {timelineEvents.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              spanStart={trace.span.min}
              hovered={e.id === hoveredId}
              expanded={e.id === expandedId}
              onHover={(h) => setHoveredId(h ? e.id : null)}
              onToggle={() =>
                setExpandedId((cur) => (cur === e.id ? null : e.id))
              }
              onOpenOperator={onOpenOperator}
              onOpenSpecialist={onOpenSpecialist}
              onOpenMcpServer={onOpenMcpServer}
              onOpenRouting={onOpenRouting}
              onOpenKgEntity={onOpenKgEntity}
              onOpenSourceRow={onOpenSourceRow}
              queryId={trace.queryId}
            />
          ))}
        </div>
        {timelineEvents.length < trace.events.length ? (
          <p className="mt-1.5 text-[10px] text-chrome-text/60">
            Showing first {timelineEvents.length} of {trace.events.length} events — the
            timeline above plots all of them; click a bar to inspect one here.
          </p>
        ) : null}
        <p className="mt-2 text-[10px] leading-snug text-chrome-text/50">
          Sub-call timings are stacked sequentially within their receipt — concurrent
          ensemble or take steps may overlap in reality. Routing events have no
          query_id; they are time-correlated within the query span and marked
          accordingly.
        </p>
      </Panel>
    </div>
  )
}

// ── Summary strip ───────────────────────────────────────────────────

function SummaryStrip({ trace }: { trace: LensTrace }) {
  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <Readout value={fmtMs(trace.span.durationMs)} unit="span" label="wall time" accent />
        <Metric label="receipts" value={fmtCount(trace.counts.receipt)} />
        <Metric label="sub-calls" value={fmtCount(trace.counts.subcall)} />
        <Metric label="mcp calls" value={fmtCount(trace.counts.mcp)} />
        <Metric
          label="route decisions"
          value={fmtCount(trace.counts.route_decision)}
          tone="muted"
        />
        <Metric
          label="route executions"
          value={fmtCount(trace.counts.route_execution)}
          tone="muted"
        />
        <Metric label="kg writes" value={fmtCount(trace.counts.kg_write)} />
        <Metric label="tokens" value={`${fmtCount(trace.totalTokensIn)}/${fmtCount(trace.totalTokensOut)}`} />
        <Metric
          label="cost"
          value={trace.totalCostUsd > 0 ? `$${trace.totalCostUsd.toFixed(4)}` : "—"}
        />
        <Metric
          label="errors"
          value={String(trace.errorCount)}
          tone={trace.errorCount > 0 ? "danger" : undefined}
        />
        <Metric label="cache hits" value={String(trace.cacheHitCount)} />
      </div>
    </div>
  )
}

// ── Flame chart ─────────────────────────────────────────────────────

const ROW_H = 9
const ROW_GAP = 1
/** Max packed lanes (= peak concurrency rows) before height is capped. */
const MAX_LANES = 48

function FlameStrip({
  trace,
  hoveredId,
  onHover,
  onPick,
}: {
  trace: LensTrace
  hoveredId: string | null
  onHover: (id: string | null) => void
  onPick: (id: string) => void
}) {
  const [ref, w] = useElementWidth<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const events = trace.events
  const span = Math.max(1, trace.span.durationMs)
  const min = trace.span.min

  // Greedy lane packing (interval scheduling): each event drops into the lowest
  // lane that is free at its start time. The number of lanes used therefore
  // equals the *peak concurrency* — so the chart shows parallelism directly and
  // its height stays bounded no matter how many thousands of events there are
  // (vs. the old one-row-per-event layout that grew to N×9px and N SVG nodes).
  const { laneOf, laneCount } = useMemo(() => {
    const order = events.map((_, i) => i).sort((a, b) => events[a].startAt - events[b].startAt)
    const laneEnds: number[] = []
    const laneOf = new Int16Array(events.length)
    for (const idx of order) {
      const e = events[idx]
      let lane = -1
      const cap = Math.min(laneEnds.length, MAX_LANES)
      for (let l = 0; l < cap; l++) {
        if (laneEnds[l] <= e.startAt) {
          lane = l
          break
        }
      }
      if (lane === -1) {
        lane = laneEnds.length < MAX_LANES ? laneEnds.length : MAX_LANES - 1
        if (laneEnds.length < MAX_LANES) laneEnds.push(0)
      }
      laneEnds[lane] = Math.max(e.endAt, e.startAt + 1)
      laneOf[idx] = lane
    }
    return { laneOf, laneCount: Math.max(1, laneEnds.length) }
  }, [events])

  const height = laneCount * (ROW_H + ROW_GAP) + 2

  // Single canvas, drawn in one O(events) pass — no per-bar DOM/React nodes.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || w === 0) return
    const cs = getComputedStyle(cv)
    const resolve = (val: string): string => {
      const m = /var\((--[\w-]+)\)/.exec(val)
      return m ? cs.getPropertyValue(m[1]).trim() || "#8899aa" : val
    }
    const colorCache: Record<string, string> = {}
    const colorFor = (surface: string): string =>
      (colorCache[surface] ??= resolve(SURFACE_COLOR[surface as LensSurface]))
    const foreground = resolve("var(--foreground)")

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = Math.max(1, Math.floor(w * dpr))
    cv.height = Math.max(1, Math.floor(height * dpr))
    cv.style.width = `${w}px`
    cv.style.height = `${height}px`
    const ctx = cv.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, height)

    for (let i = 0; i < events.length; i++) {
      const lane = laneOf[i]
      const e = events[i]
      const x = ((e.startAt - min) / span) * w
      const barW = Math.max(1.5, (e.durationMs / span) * w)
      const y = lane * (ROW_H + ROW_GAP)
      const isHover = e.id === hoveredId
      ctx.globalAlpha = e.linkage === "time" ? 0.3 : isHover ? 1 : 0.88
      ctx.fillStyle = colorFor(e.surface)
      ctx.fillRect(x, y, barW, ROW_H - 1)
      if (isHover) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = foreground
        ctx.lineWidth = 1
        ctx.strokeRect(x - 0.5, y - 0.5, barW + 1, ROW_H)
      }
    }
    ctx.globalAlpha = 1
  }, [w, events, laneOf, hoveredId, height, span, min])

  // Hit-test against the packed lanes on mousemove (one handler, not N).
  const eventAt = useCallback(
    (clientX: number, clientY: number): LensEvent | null => {
      const cv = canvasRef.current
      if (!cv || w === 0) return null
      const rect = cv.getBoundingClientRect()
      const mx = clientX - rect.left
      const my = clientY - rect.top
      const lane = Math.floor(my / (ROW_H + ROW_GAP))
      for (let i = 0; i < events.length; i++) {
        if (laneOf[i] !== lane) continue
        const e = events[i]
        const x = ((e.startAt - min) / span) * w
        const barW = Math.max(1.5, (e.durationMs / span) * w)
        if (mx >= x - 1.5 && mx <= x + barW + 1.5) return e
      }
      return null
    },
    [events, laneOf, w, span, min],
  )

  const hovered = hoveredId ? events.find((e) => e.id === hoveredId) ?? null : null
  const hoveredX = hovered ? ((hovered.startAt - min) / span) * w : 0
  const hoveredLane = hovered ? laneOf[events.indexOf(hovered)] : 0

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <canvas
        ref={canvasRef}
        className="block cursor-pointer"
        onMouseMove={(ev) => {
          const e = eventAt(ev.clientX, ev.clientY)
          onHover(e?.id ?? null)
        }}
        onMouseLeave={() => onHover(null)}
        onClick={(ev) => {
          const e = eventAt(ev.clientX, ev.clientY)
          if (e) onPick(e.id)
        }}
      />
      {hovered && w > 0 ? (
        <div
          className="pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded border border-chrome-border bg-chrome-bg px-1.5 py-0.5 font-mono text-[9px] text-foreground shadow"
          style={{
            left: Math.min(Math.max(hoveredX + 4, 4), Math.max(4, w - 220)),
            top: Math.max(10, hoveredLane * (ROW_H + ROW_GAP) - 2),
          }}
        >
          {eventIdentity(hovered)} · {fmtMs(hovered.durationMs)}
        </div>
      ) : null}
    </div>
  )
}

function FlameLegend({ trace }: { trace: LensTrace }) {
  const present: LensSurface[] = (
    [
      "receipt",
      "subcall",
      "mcp",
      "kg_write",
      "route_decision",
      "route_execution",
    ] as LensSurface[]
  ).filter((s) => trace.counts[s] > 0)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {present.map((s) => (
        <span key={s} className="inline-flex items-center gap-1 text-[9px]">
          <span
            className="h-2 w-2 rounded-[2px]"
            style={{ background: SURFACE_COLOR[s] }}
          />
          <span className="text-chrome-text/80">{SURFACE_LABEL[s]}</span>
          <span className="font-mono tabular-nums text-chrome-text/45">{trace.counts[s]}</span>
        </span>
      ))}
      <span className="ml-3 inline-flex items-center gap-1 text-[9px] text-chrome-text/55">
        <span
          className="inline-block h-2 w-3 rounded-[2px] border border-chrome-text/55"
          style={{ borderStyle: "dashed" }}
        />
        time-correlated (not linked by query_id)
      </span>
    </div>
  )
}

// ── Event row ───────────────────────────────────────────────────────

function fmtClock(epochMs: number): string {
  if (!epochMs) return "—"
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${ms}`
}

function fmtRel(epochMs: number, base: number): string {
  if (epochMs === base) return "+0ms"
  const delta = epochMs - base
  if (delta < 1000) return `+${delta}ms`
  return `+${(delta / 1000).toFixed(2)}s`
}

function EventRow({
  event,
  spanStart,
  hovered,
  expanded,
  onHover,
  onToggle,
  onOpenOperator,
  onOpenSpecialist,
  onOpenMcpServer,
  onOpenRouting,
  onOpenKgEntity,
  onOpenSourceRow,
  queryId,
}: {
  event: LensEvent
  spanStart: number
  hovered: boolean
  expanded: boolean
  onHover: (h: boolean) => void
  onToggle: () => void
  onOpenOperator: (name: string, receiptId?: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenMcpServer: (name: string) => void
  onOpenRouting: () => void
  onOpenKgEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
  queryId: string
}) {
  const color = SURFACE_COLOR[event.surface]
  const isTime = event.linkage === "time"
  return (
    <div
      className={cn(
        "rounded border bg-secondary-background/60",
        hovered ? "border-rvbbit-accent/40" : "border-chrome-border/40",
      )}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="flex w-full items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="w-[88px] shrink-0 font-mono text-[10px] tabular-nums text-chrome-text/70">
            {fmtClock(event.startAt)}
          </span>
          <span className="w-[44px] shrink-0 font-mono text-[9px] tabular-nums text-chrome-text/45">
            {fmtRel(event.startAt, spanStart)}
          </span>
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider"
            style={{
              color,
              background: `color-mix(in oklch, ${color} ${isTime ? 8 : 16}%, transparent)`,
              ...(isTime
                ? { border: `1px dashed color-mix(in oklch, ${color} 50%, transparent)` }
                : {}),
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {SURFACE_LABEL[event.surface]}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
            {eventIdentity(event)}
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-chrome-text/70">
            {fmtMs(event.durationMs)}
          </span>
        </button>
        <EventLinkButton
          event={event}
          onOpenOperator={onOpenOperator}
          onOpenSpecialist={onOpenSpecialist}
          onOpenMcpServer={onOpenMcpServer}
          onOpenRouting={onOpenRouting}
          onOpenKgEntity={onOpenKgEntity}
          queryId={queryId}
        />
        {event.surface === "kg_write" && event.sourceTable && event.sourcePk ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpenSourceRow({
                sourceTable: event.sourceTable!,
                sourcePk: event.sourcePk!,
                sourceColumn: event.sourceColumn,
              })
            }}
            title={`Open source row ${event.sourceTable}#${event.sourcePk}`}
            className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Database className="h-2.5 w-2.5" />
            row
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          className="w-3 shrink-0 text-[9px] text-chrome-text/40 hover:text-foreground"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▼" : "▶"}
        </button>
      </div>
      {expanded ? <EventDetail event={event} /> : null}
    </div>
  )
}

function EventLinkButton({
  event,
  onOpenOperator,
  onOpenSpecialist,
  onOpenMcpServer,
  onOpenRouting,
  onOpenKgEntity,
  queryId,
}: {
  event: LensEvent
  onOpenOperator: (name: string, receiptId?: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenMcpServer: (name: string) => void
  onOpenRouting: () => void
  onOpenKgEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  queryId: string
}) {
  let label: string | null = null
  let Icon: React.ComponentType<{ className?: string }> | null = null
  let onClick: (() => void) | null = null
  if (event.surface === "receipt") {
    label = "operator"
    Icon = Wand2
    onClick = () => onOpenOperator(event.operator, event.receiptId)
  } else if (event.surface === "mcp") {
    label = "server"
    Icon = Globe
    onClick = () => onOpenMcpServer(event.server)
  } else if (event.surface === "subcall" && event.kind === "mcp" && event.model) {
    // mcp sub-calls carry "server.tool" in model
    const server = event.model.split(".")[0]
    if (server) {
      label = "server"
      Icon = Globe
      onClick = () => onOpenMcpServer(server)
    }
  } else if (
    event.surface === "subcall" &&
    event.kind === "specialist" &&
    event.model
  ) {
    // specialist sub-calls carry the backend name in model
    label = "backend"
    Icon = Brain
    const backend = event.model
    onClick = () => onOpenSpecialist(backend)
  } else if (event.surface === "route_decision" || event.surface === "route_execution") {
    label = "routing"
    Icon = GitBranch
    onClick = onOpenRouting
  } else if (
    event.surface === "kg_write" &&
    event.graphId &&
    event.subjectKind &&
    event.subjectLabel
  ) {
    label = "node"
    Icon = TreeStructure
    const graphId = event.graphId
    const kind = event.subjectKind
    const lbl = event.subjectLabel
    const nodeId = event.subjectNodeId
    onClick = () =>
      onOpenKgEntity(
        kind,
        lbl,
        graphId,
        { kind: "lens", queryId, label: `Lens · ${queryId.slice(0, 8)}` },
        nodeId,
      )
  }
  if (!label || !Icon || !onClick) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick!()
      }}
      title={`Open ${label}`}
      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
    </button>
  )
}

// ── Event detail (expanded) ─────────────────────────────────────────

function EventDetail({ event }: { event: LensEvent }) {
  if (event.surface === "receipt") {
    return (
      <div className="border-t border-chrome-border/40 px-2 py-2">
        <div className="grid grid-cols-4 gap-2">
          <KV k="model" v={event.model ?? "—"} mono />
          <KV k="tokens" v={`${fmtCount(event.tokensIn)} → ${fmtCount(event.tokensOut)}`} />
          <KV k="cost" v={event.costUsd != null ? `$${event.costUsd.toFixed(6)}` : "—"} />
          <KV k="sub-calls" v={String(event.subCallCount)} />
          {event.takeIndex != null ? (
            <KV k="take" v={`${event.takeIndex} · ${event.takeVerdict ?? "?"}`} />
          ) : null}
        </div>
        {event.error ? <ErrorBlock text={event.error} /> : null}
      </div>
    )
  }
  if (event.surface === "subcall") {
    return (
      <div className="border-t border-chrome-border/40 px-2 py-2">
        <div className="grid grid-cols-4 gap-2">
          <KV k="step" v={event.step || "—"} mono />
          <KV k="kind" v={event.kind || "—"} />
          <KV k="model" v={event.model ?? "—"} mono />
          <KV k="tokens" v={`${fmtCount(event.tokensIn)} → ${fmtCount(event.tokensOut)}`} />
        </div>
        {event.error ? <ErrorBlock text={event.error} /> : null}
      </div>
    )
  }
  if (event.surface === "mcp") {
    return (
      <div className="border-t border-chrome-border/40 px-2 py-2">
        <div className="grid grid-cols-3 gap-2">
          <KV k="server" v={event.server} mono />
          <KV k="tool" v={event.tool} mono />
          <KV k="cache" v={event.cacheHit ? "hit" : "miss"} />
        </div>
        <div className="mt-2">
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">args</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] text-chrome-text/85">
            {JSON.stringify(event.args, null, 2)}
          </pre>
        </div>
        {event.error ? <ErrorBlock text={event.error} /> : null}
      </div>
    )
  }
  if (event.surface === "route_decision") {
    return (
      <div className="border-t border-chrome-border/40 px-2 py-2">
        <div className="grid grid-cols-3 gap-2">
          <KV k="route" v={event.route} mono />
          <KV k="source" v={event.routeSource} mono />
          <KV k="confidence" v={event.confidence != null ? `${(event.confidence * 100).toFixed(0)}%` : "—"} />
          <KV k="cache" v={event.cacheHit ? "hit" : "miss"} />
        </div>
        {event.reason ? (
          <p className="mt-1 text-[10px] leading-snug text-chrome-text/65">{event.reason}</p>
        ) : null}
        <p className="mt-1 text-[9px] text-chrome-text/45">
          shape_family: <span className="font-mono">{event.shapeFamily}</span>
        </p>
      </div>
    )
  }
  if (event.surface === "kg_write") {
    return (
      <div className="border-t border-chrome-border/40 px-2 py-2">
        <div className="grid grid-cols-4 gap-2">
          {event.predicate ? (
            <>
              <KV
                k="subject"
                v={`${event.subjectKind ?? "?"} · ${event.subjectLabel ?? "?"}`}
                mono
              />
              <KV k="predicate" v={event.predicate} mono />
              <KV
                k="object"
                v={`${event.objectKind ?? "?"} · ${event.objectLabel ?? "?"}`}
                mono
              />
            </>
          ) : (
            <KV
              k="node"
              v={`${event.subjectKind ?? "?"} · ${event.subjectLabel ?? "?"}`}
              mono
            />
          )}
          <KV
            k="confidence"
            v={
              event.confidence != null
                ? `${(event.confidence * 100).toFixed(0)}%`
                : "—"
            }
          />
        </div>
        {event.evidenceText ? (
          <div className="mt-2">
            <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
              evidence text
            </div>
            <p className="rounded border border-chrome-border bg-doc-bg p-1.5 text-[10px] leading-snug text-chrome-text/85">
              {event.evidenceText}
            </p>
          </div>
        ) : null}
        {event.sourceTable ? (
          <div className="mt-1.5 text-[10px] text-chrome-text/55">
            source:{" "}
            <span className="font-mono text-foreground">{event.sourceTable}</span>
            {event.sourceColumn ? (
              <span>
                {" "}
                · column <span className="font-mono">{event.sourceColumn}</span>
              </span>
            ) : null}
            {event.sourcePk ? (
              <span>
                {" "}
                · pk <span className="font-mono">{event.sourcePk}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }
  // route_execution
  return (
    <div className="border-t border-chrome-border/40 px-2 py-2">
      <div className="grid grid-cols-4 gap-2">
        <KV k="candidate" v={event.candidate} mono />
        <KV k="source" v={event.routeSource} mono />
        <KV k="rows" v={fmtCount(event.rowsReturned)} />
        <KV k="cache" v={event.cacheHit ? "hit" : "miss"} />
      </div>
      {event.reason ? (
        <p className="mt-1 text-[10px] leading-snug text-chrome-text/65">{event.reason}</p>
      ) : null}
      <p className="mt-1 text-[9px] text-chrome-text/45">
        shape_family: <span className="font-mono">{event.shapeFamily}</span>
      </p>
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">{k}</div>
      <div className={cn("truncate text-[11px] text-foreground", mono && "font-mono text-[10px]")}>
        {v}
      </div>
    </div>
  )
}

function ErrorBlock({ text }: { text: string }) {
  return (
    <div className="mt-2 flex items-start gap-1.5 rounded border border-danger/40 bg-danger/10 px-1.5 py-1 text-[10px] text-danger">
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
      <span className="font-mono leading-snug">{text}</span>
    </div>
  )
}
