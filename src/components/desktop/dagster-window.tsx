"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CheckCircle2,
  Clock,
  Database,
  GitBranch,
  LineChart,
  Pause,
  PieChart,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Table2,
} from "@/lib/icons"
import {
  fetchDagsterSnapshot,
  type DagsterAssetRow,
  type DagsterAutomationRow,
  type DagsterAutomationTick,
  type DagsterCheckRow,
  type DagsterEventRow,
  type DagsterFlowEdge,
  type DagsterRunRow,
  type DagsterSnapshot,
} from "@/lib/dagster/metadata"
import { CompositionBar, HBars, Histogram, fmtAgo, fmtCount, fmtMs, Panel, percentile } from "./instruments"
import { Sparkline } from "./sparkline"
import { cn } from "@/lib/utils"

type Tab = "timeline" | "resources" | "runs" | "assets" | "checks" | "automation" | "events"
type TimelineRangeHours = 1 | 6 | 12 | 24

interface DagsterWindowProps {
  activeConnectionId: string | null
  workspaceActive: boolean
}

const TABS: { key: Tab; label: string }[] = [
  { key: "timeline", label: "Timeline" },
  { key: "resources", label: "Resources" },
  { key: "runs", label: "Runs" },
  { key: "assets", label: "Assets" },
  { key: "checks", label: "Checks" },
  { key: "automation", label: "Automations" },
  { key: "events", label: "Events" },
]

const TIMELINE_RANGES: TimelineRangeHours[] = [1, 6, 12, 24]
const REFRESH_INTERVAL_MS = 30_000

export function DagsterWindow({ activeConnectionId, workspaceActive }: DagsterWindowProps) {
  const [tab, setTab] = useState<Tab>("timeline")
  const [snapshot, setSnapshot] = useState<DagsterSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rangeHours, setRangeHours] = useState<TimelineRangeHours>(12)
  const [query, setQuery] = useState("")
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null)
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!activeConnectionId) {
      setSnapshot(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await fetchDagsterSnapshot(activeConnectionId)
      setSnapshot(next)
      setError(next.error ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLastRefreshAt(Date.now())
      setLoading(false)
    }
  }, [activeConnectionId])

  useEffect(() => {
    if (!workspaceActive) return
    queueMicrotask(() => {
      void refresh()
    })
  }, [refresh, workspaceActive])

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!workspaceActive || !activeConnectionId || !autoRefresh) return
    const id = window.setInterval(() => {
      void refresh()
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [activeConnectionId, autoRefresh, refresh, workspaceActive])

  const detected = !!snapshot?.detection.detected
  const schemas = snapshot?.detection.schemas.join(", ") || "-"
  const refreshCountdown = autoRefresh && lastRefreshAt
    ? Math.max(0, Math.ceil((lastRefreshAt + REFRESH_INTERVAL_MS - nowMs) / 1000))
    : null

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-block-bg/45 text-foreground backdrop-blur-md group-data-[focused=false]/window:bg-block-bg/25">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,var(--ambient-1),transparent_34%),radial-gradient(circle_at_86%_12%,var(--ambient-2),transparent_30%)] opacity-80" />
      <div className="relative flex h-11 shrink-0 items-center gap-2 border-b border-chrome-border/65 bg-chrome-bg/55 px-3 backdrop-blur-md">
        <div className="grid h-7 w-7 place-items-center rounded-md border border-chrome-border/65 bg-secondary-background/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          <GitBranch className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold leading-tight text-foreground">Dagster</div>
          <div className="truncate font-mono text-[9px] text-chrome-text/65">
            {detected ? `schemas: ${schemas}` : loading ? "scanning storage tables" : "not detected"}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {snapshot ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[9px]",
                detected
                  ? "border-success/35 bg-success/10 text-success"
                  : "border-chrome-border/65 bg-foreground/[0.035] text-chrome-text/70",
              )}
            >
              {snapshot.detection.confidence}%
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            title={autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 font-mono text-[10px] transition-colors",
              autoRefresh
                ? "border-success/25 bg-success/10 text-success hover:bg-success/15"
                : "border-chrome-border/65 bg-foreground/[0.035] text-chrome-text/70 hover:bg-foreground/[0.07] hover:text-foreground",
            )}
          >
            {autoRefresh ? <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} /> : <Pause className="h-3 w-3" />}
            {autoRefresh ? `${refreshCountdown ?? "--"}s` : "paused"}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || !activeConnectionId}
            title="Refresh"
            className="grid h-7 w-7 place-items-center rounded-md border border-chrome-border/65 bg-foreground/[0.025] text-chrome-text/70 transition-colors hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-45"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-11 shrink-0 items-center gap-2 border-b border-chrome-border/60 bg-chrome-bg/35 px-3 backdrop-blur">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "h-8 rounded-md px-2.5 text-[11px] font-medium transition-colors",
              tab === t.key
                ? "bg-foreground/[0.09] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-chrome-text/70 hover:bg-foreground/[0.055] hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <label className="relative hidden min-w-[220px] max-w-[520px] flex-1 md:block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text/45" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search and filter automations"
              className="h-8 w-full rounded-md border border-chrome-border/60 bg-block-bg/50 pl-8 pr-2 font-mono text-[11px] text-foreground outline-none placeholder:text-chrome-text/45 focus:border-rvbbit-accent/45"
            />
          </label>
          <div className="hidden items-center rounded-md border border-chrome-border/60 bg-block-bg/45 p-0.5 md:flex">
            {TIMELINE_RANGES.map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setRangeHours(range)}
                className={cn(
                  "h-7 rounded px-2 font-mono text-[10px] transition-colors",
                  rangeHours === range ? "bg-foreground/[0.11] text-foreground" : "text-chrome-text/70 hover:bg-foreground/[0.055] hover:text-foreground",
                )}
              >
                {range}h
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setNowMs(Date.now())}
            className="hidden h-8 rounded-md border border-chrome-border/60 bg-block-bg/45 px-2.5 font-mono text-[10px] text-chrome-text/80 transition-colors hover:bg-foreground/[0.055] hover:text-foreground md:inline-flex md:items-center"
          >
            Now
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto p-3">
        {!activeConnectionId ? (
          <Empty icon={Database} title="No active connection" detail="Open a connection to scan for Dagster storage." />
        ) : loading && !snapshot ? (
          <Loading />
        ) : error ? (
          <Empty icon={AlertTriangle} title="Dagster scan failed" detail={error} tone="danger" />
        ) : !detected || !snapshot ? (
          <Empty
            icon={GitBranch}
            title="No Dagster storage tables detected"
            detail={snapshot?.detection.missingCore.length ? `Missing: ${snapshot.detection.missingCore.join(", ")}` : "No recognized Dagster table set was found."}
          />
        ) : tab === "timeline" ? (
          <AutomationTimeline
            snapshot={snapshot}
            query={query}
            rangeHours={rangeHours}
            nowMs={nowMs}
            selectedLaneId={selectedLaneId}
            onSelectLane={setSelectedLaneId}
          />
        ) : tab === "resources" ? (
          <Overview snapshot={snapshot} />
        ) : tab === "runs" ? (
          <RunsTable rows={snapshot.runs} />
        ) : tab === "assets" ? (
          <AssetsTable rows={snapshot.assets} />
        ) : tab === "checks" ? (
          <ChecksTable rows={snapshot.checks} />
        ) : tab === "automation" ? (
          <AutomationTable rows={snapshot.automations} nowMs={nowMs} />
        ) : (
          <EventsTable rows={snapshot.events} />
        )}
      </div>
    </div>
  )
}

interface TimelineBounds {
  startMs: number
  endMs: number
}

interface TimelineRunBlock {
  run: DagsterRunRow
  startMs: number
  endMs: number
}

interface TimelineLane {
  id: string
  name: string
  type: string
  status: string
  updatedAt: number | null
  lastTickAt: number | null
  lastTickStatus: string | null
  lastActivityAt: number | null
  ticks: DagsterAutomationTick[]
  runs: TimelineRunBlock[]
  events: DagsterEventRow[]
  activityCount: number
}

function AutomationTimeline({
  snapshot,
  query,
  rangeHours,
  nowMs,
  selectedLaneId,
  onSelectLane,
}: {
  snapshot: DagsterSnapshot
  query: string
  rangeHours: TimelineRangeHours
  nowMs: number
  selectedLaneId: string | null
  onSelectLane: (id: string) => void
}) {
  const bounds = useMemo(() => timelineBounds(nowMs, rangeHours), [nowMs, rangeHours])
  const axisTicks = useMemo(() => timelineAxisTicks(bounds, rangeHours), [bounds, rangeHours])
  const lanes = useMemo(
    () => buildTimelineLanes(snapshot, bounds, nowMs, query),
    [bounds, nowMs, query, snapshot],
  )
  const selectedLane = lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0] ?? null
  const nowPct = timePct(nowMs, bounds)
  const timelineHeight = lanes.length === 0
    ? 220
    : Math.min(560, 79 + lanes.length * 42)

  return (
    <div className="flex min-h-full flex-col gap-3">
      <TimelineSummary lanes={lanes} bounds={bounds} />

      <div
        className="shrink-0 overflow-hidden rounded-md border border-chrome-border/60 bg-block-bg/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur"
        style={{ height: timelineHeight }}
      >
        {lanes.length === 0 ? (
          <TinyEmpty label="No recent automation activity" />
        ) : (
          <div className="h-full overflow-auto">
            <div className="min-w-[1080px]">
              <div className="sticky top-0 z-30 grid grid-cols-[310px_minmax(760px,1fr)] border-b border-chrome-border/60 bg-chrome-bg/70 backdrop-blur">
                <div className="flex h-[78px] items-end border-r border-chrome-border/60 px-4 pb-3">
                  <div>
                    <div className="text-[12px] font-semibold text-foreground">Runs</div>
                    <div className="mt-1 font-mono text-[9px] text-chrome-text/55">
                      {formatTimelineWindow(bounds)}
                    </div>
                  </div>
                </div>
                <div className="relative h-[78px]">
                  <div className="absolute left-0 right-0 top-3 text-center font-mono text-[11px] text-chrome-text/55">
                    {formatTimelineDate(bounds.endMs)}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 top-9">
                    {axisTicks.map((tick) => {
                      const left = timePct(tick, bounds)
                      return (
                        <div
                          key={tick}
                          className="absolute bottom-0 top-0 border-l border-chrome-border/45"
                          style={{ left: `${left}%` }}
                        >
                          <div className="ml-2 mt-1 font-mono text-[10px] text-chrome-text/55">
                            {formatAxisLabel(tick, rangeHours)}
                          </div>
                        </div>
                      )
                    })}
                    <div
                      className="absolute bottom-0 top-0 z-20 border-l border-foreground/90"
                      style={{ left: `${nowPct}%` }}
                    >
                      <div className="-ml-3 mt-1 rounded-sm bg-foreground px-1 py-0.5 font-mono text-[9px] leading-none text-background">
                        Now
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                {lanes.map((lane) => (
                  <TimelineLaneRow
                    key={lane.id}
                    lane={lane}
                    bounds={bounds}
                    axisTicks={axisTicks}
                    nowMs={nowMs}
                    nowPct={nowPct}
                    selected={lane.id === selectedLane?.id}
                    onSelect={() => onSelectLane(lane.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {selectedLane ? <TimelineLaneDetail lane={selectedLane} bounds={bounds} nowMs={nowMs} /> : null}
    </div>
  )
}

function TimelineSummary({ lanes, bounds }: { lanes: TimelineLane[]; bounds: TimelineBounds }) {
  const counts = useMemo(() => {
    let ticks = 0
    let failedTicks = 0
    let runs = 0
    let running = 0
    let stale = 0
    for (const lane of lanes) {
      ticks += lane.ticks.length
      failedTicks += lane.ticks.filter((tick) => isDangerStatus(tick.status)).length
      runs += lane.runs.length
      running += lane.runs.filter((block) => isRunningStatus(block.run.status)).length
      if (!lane.lastActivityAt || lane.lastActivityAt < bounds.startMs) stale += 1
    }
    return { ticks, failedTicks, runs, running, stale }
  }, [bounds.startMs, lanes])

  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-5">
      <TimelineStat label="lanes" value={fmtCount(lanes.length)} />
      <TimelineStat label="ticks in range" value={fmtCount(counts.ticks)} tone={counts.failedTicks > 0 ? "warning" : undefined} />
      <TimelineStat label="failed ticks" value={fmtCount(counts.failedTicks)} tone={counts.failedTicks > 0 ? "danger" : undefined} />
      <TimelineStat label="run bars" value={fmtCount(counts.runs)} tone={counts.running > 0 ? "success" : undefined} />
      <TimelineStat label="quiet lanes" value={fmtCount(counts.stale)} tone={counts.stale > 0 ? "muted" : undefined} />
    </div>
  )
}

function TimelineStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "danger" | "warning" | "success" | "muted"
}) {
  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/35 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur">
      <div
        className={cn(
          "font-mono text-[17px] leading-none tabular-nums",
          tone === "danger"
            ? "text-danger"
            : tone === "warning"
              ? "text-warning"
            : tone === "success"
              ? "text-success"
              : tone === "muted"
                  ? "text-chrome-text/65"
                  : "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</div>
    </div>
  )
}

function TimelineLaneRow({
  lane,
  bounds,
  axisTicks,
  nowMs,
  nowPct,
  selected,
  onSelect,
}: {
  lane: TimelineLane
  bounds: TimelineBounds
  axisTicks: number[]
  nowMs: number
  nowPct: number
  selected: boolean
  onSelect: () => void
}) {
  const quiet = !lane.lastActivityAt || lane.lastActivityAt < bounds.startMs
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect()
      }}
      className={cn(
        "grid grid-cols-[310px_minmax(760px,1fr)] border-b border-chrome-border/35 outline-none transition-colors",
        selected ? "bg-rvbbit-accent/10 ring-1 ring-inset ring-rvbbit-accent/25" : "hover:bg-foreground/[0.025]",
        quiet && !selected && "opacity-60",
      )}
    >
      <div className="flex h-[42px] min-w-0 items-center gap-2 border-r border-chrome-border/55 px-3">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass(lane.lastTickStatus ?? lane.status))} />
        <Clock className="h-3.5 w-3.5 shrink-0 text-chrome-text/60" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground" title={lane.name}>
            {lane.name}
          </div>
          <div className="truncate font-mono text-[9px] text-chrome-text/55">
            {lane.type} · {lane.lastActivityAt ? fmtAgo(lane.lastActivityAt) : "no activity"}
          </div>
        </div>
        <Pill className={statusClass(lane.lastTickStatus ?? lane.status)}>{short(lane.lastTickStatus ?? lane.status, 14)}</Pill>
      </div>
      <div className="relative h-[42px] overflow-hidden">
        {axisTicks.map((tick) => (
          <span
            key={tick}
            className="absolute bottom-0 top-0 border-l border-chrome-border/30"
            style={{ left: `${timePct(tick, bounds)}%` }}
          />
        ))}
        <span
          className="absolute bottom-0 top-0 z-20 border-l border-foreground/85"
          style={{ left: `${nowPct}%` }}
        />
        {lane.runs.map((block) => {
          const left = timePct(Math.max(block.startMs, bounds.startMs), bounds)
          const right = timePct(Math.min(block.endMs, bounds.endMs), bounds)
          const width = Math.max(0.7, right - left)
          return (
            <span
              key={block.run.runId}
              title={runBlockTitle(block)}
              className="absolute top-[12px] z-10 h-[18px] overflow-hidden rounded-[4px] border px-1 font-mono text-[9px] leading-[17px] text-main-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.18)]"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: statusFillColor(block.run.status),
                borderColor: statusStrokeColor(block.run.status),
              }}
            >
              <span className="block truncate">{short(block.run.jobName, 32)}</span>
            </span>
          )
        })}
        {lane.ticks.map((tick, index) => {
          const tickAt = tick.timestamp ?? tick.updatedAt
          if (!tickAt) return null
          const left = timePct(tickAt, bounds)
          const endAt = tick.updatedAt && tick.updatedAt > tickAt ? tick.updatedAt : tickAt + 90_000
          const widthPct = ((Math.min(endAt, bounds.endMs) - Math.max(tickAt, bounds.startMs)) / (bounds.endMs - bounds.startMs)) * 100
          const width = tick.updatedAt && tick.updatedAt - tickAt > 60_000 ? `${Math.max(0.3, widthPct)}%` : "4px"
          const future = tickAt > nowMs
          return (
            <span
              key={`${tick.id ?? tickAt}:${index}`}
              title={tickTitle(tick)}
              className={cn("absolute top-[7px] z-30 h-[28px] rounded-[3px] border", tickSquareClass(tick.status, future))}
              style={{ left: `${left}%`, width, maxWidth: "28px" }}
            />
          )
        })}
      </div>
    </div>
  )
}

function TimelineLaneDetail({ lane, bounds, nowMs }: { lane: TimelineLane; bounds: TimelineBounds; nowMs: number }) {
  const latestRuns = lane.runs.slice().sort((a, b) => b.startMs - a.startMs).slice(0, 6)
  const latestTicks = lane.ticks.slice().sort((a, b) => (b.timestamp ?? b.updatedAt ?? 0) - (a.timestamp ?? a.updatedAt ?? 0)).slice(0, 14)
  const runningBlock = latestRuns.find((block) => isRunningStatus(block.run.status)) ?? null
  const focusBlock = runningBlock ?? latestRuns[0] ?? null
  const focusEvents = focusBlock
    ? lane.events.filter((event) => event.runId === focusBlock.run.runId).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id - b.id)
    : lane.events.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id - b.id)
  const stepRows = buildStepRows(focusEvents)
  const currentStep = focusEvents.slice().reverse().find((event) => !!event.stepKey) ?? null
  const recentEvents = focusEvents.slice(-10).reverse()
  const durationValues = lane.runs
    .map((block) => Math.max(0, block.endMs - block.startMs))
    .filter((value) => value > 0)
  const sortedDurations = durationValues.slice().sort((a, b) => a - b)
  const durationP50 = sortedDurations.length > 0 ? percentile(sortedDurations, 0.5) : 0
  const durationP95 = sortedDurations.length > 0 ? percentile(sortedDurations, 0.95) : 0
  const cadence = tickCadenceSeries(lane.ticks, bounds, 18)
  const statusSegments = laneStatusSegments(lane)
  const topHistory = topHistoryRows(lane.events)
  const expectedMs = Math.max(durationP50 || durationP95 || 1, 1)
  const runningElapsedMs = runningBlock ? Math.max(0, nowMs - runningBlock.startMs) : 0
  const runningPct = runningBlock ? Math.min(98, Math.max(3, (runningElapsedMs / expectedMs) * 100)) : null
  const inspectionTitle = runningBlock ? "Live Inspection" : "Historical Inspection"

  return (
    <Panel
      icon={runningBlock ? Activity : LineChart}
      title={inspectionTitle}
      right={<span className="font-mono text-[9px] text-chrome-text/60">{formatTimelineWindow(bounds)}</span>}
      className="min-h-0 shrink-0 border-chrome-border/60 bg-secondary-background/35 backdrop-blur"
    >
      <div className="space-y-3">
        <div className="grid gap-3 xl:grid-cols-[minmax(250px,0.85fr)_minmax(360px,1.25fr)_minmax(300px,1fr)]">
          <div className="min-w-0 space-y-3">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-foreground" title={lane.name}>{lane.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Pill className={statusClass(lane.lastTickStatus ?? lane.status)}>{lane.lastTickStatus ?? lane.status}</Pill>
                <span className="font-mono text-[10px] text-chrome-text/65">{lane.type}</span>
                <span className="font-mono text-[10px] text-chrome-text/50">
                  last {lane.lastActivityAt ? fmtAgo(lane.lastActivityAt) : "never"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <DetailMetric label="runs" value={fmtCount(lane.runs.length)} />
              <DetailMetric label="ticks" value={fmtCount(lane.ticks.length)} />
              <DetailMetric label="events" value={fmtCount(lane.events.length)} />
            </div>

            <div>
              <MiniHeading icon={PieChart} label="Status Mix" />
              {statusSegments.length === 0 ? (
                <TinyEmpty label="No status samples" />
              ) : (
                <>
                  <CompositionBar segments={statusSegments} height={12} />
                  <div className="mt-1 flex flex-wrap gap-1">
                    {statusSegments.map((segment) => (
                      <span key={segment.label} className="inline-flex items-center gap-1 font-mono text-[9px] text-chrome-text/60">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: segment.color }} />
                        {short(segment.label, 12)} {segment.value}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            {runningBlock ? (
              <div>
                <MiniHeading icon={Activity} label="Running Progress" />
                <div className="relative h-2 overflow-hidden rounded-sm bg-foreground/[0.06]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-sm bg-rvbbit-accent shadow-[0_0_16px_var(--rvbbit-accent)]"
                    style={{ width: `${runningPct ?? 0}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[9px] text-chrome-text/55">
                  <span>{fmtMs(runningElapsedMs)} elapsed</span>
                  <span>median {durationP50 ? fmtMs(durationP50) : "unknown"}</span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="min-w-0 space-y-3">
            <LaneActivityRibbon lane={lane} bounds={bounds} nowMs={nowMs} />

            <div>
              <MiniHeading
                icon={Sparkles}
                label={runningBlock ? "Current Step Trace" : "Last Run Trace"}
                right={focusBlock ? <span className="font-mono text-[9px] text-chrome-text/50">{short(focusBlock.run.runId, 18)}</span> : null}
              />
              {focusBlock ? (
                <div className="mb-2 flex min-w-0 items-center gap-2 border-b border-chrome-border/35 pb-2">
                  <Pill className={statusClass(focusBlock.run.status)}>{short(focusBlock.run.status, 13)}</Pill>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-foreground" title={focusBlock.run.jobName}>{focusBlock.run.jobName}</div>
                    <div className="font-mono text-[9px] text-chrome-text/50">
                      {formatRunDuration(focusBlock)}
                      {focusBlock.run.partition ? ` · ${focusBlock.run.partition}` : ""}
                    </div>
                  </div>
                </div>
              ) : null}

              {currentStep ? (
                <div className="mb-2 rounded border border-rvbbit-accent/25 bg-rvbbit-accent/10 px-2 py-1.5">
                  <div className="text-[9px] uppercase tracking-wider text-rvbbit-accent/85">
                    {runningBlock ? "active step" : "latest step"}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-foreground" title={currentStep.stepKey ?? undefined}>
                    {currentStep.stepKey}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1.5 font-mono text-[9px] text-chrome-text/55">
                    <span>{currentStep.eventType ?? "event"}</span>
                    {currentStep.assetLabel ? <span>{currentStep.assetLabel}</span> : null}
                    <span>{currentStep.timestamp ? fmtAgo(currentStep.timestamp) : "no time"}</span>
                  </div>
                </div>
              ) : null}

              <StepLadder rows={stepRows} currentStep={currentStep?.stepKey ?? null} />
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <div>
              <MiniHeading icon={LineChart} label="Tick Cadence" />
              <Sparkline values={cadence} height={36} color="var(--rvbbit-accent)" fillOpacity={0.16} yMin={0} />
              <div className="mt-1 font-mono text-[9px] text-chrome-text/50">
                {fmtCount(lane.ticks.length)} ticks across this window
              </div>
            </div>

            <div>
              <MiniHeading icon={BarChart3} label="Run Duration Spread" right={durationP95 ? <span>p95 {fmtMs(durationP95)}</span> : null} />
              {durationValues.length === 0 ? (
                <TinyEmpty label="No duration samples" />
              ) : (
                <Histogram
                  values={durationValues}
                  bins={14}
                  height={46}
                  markers={[
                    { value: durationP50, label: "p50", color: "var(--foreground)" },
                    { value: durationP95, label: "p95", color: "var(--warning)" },
                  ]}
                  barColor="var(--rvbbit-accent)"
                />
              )}
            </div>

            <div>
              <MiniHeading icon={Table2} label="Historical Hotspots" />
              {topHistory.length === 0 ? (
                <TinyEmpty label="No step or asset history" />
              ) : (
                <HBars rows={topHistory} />
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="min-w-0">
            <MiniHeading icon={Play} label="Latest Runs" />
            <div className="space-y-1">
              {latestRuns.length === 0 ? (
                <div className="font-mono text-[10px] text-chrome-text/55">none in window</div>
              ) : (
                latestRuns.map((block) => (
                  <div key={block.run.runId} className="flex min-w-0 items-center gap-2 rounded border border-chrome-border/40 bg-foreground/[0.025] px-2 py-1">
                    <Pill className={statusClass(block.run.status)}>{short(block.run.status, 12)}</Pill>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{block.run.jobName}</span>
                    <span className="font-mono text-[10px] text-chrome-text/65">{formatRunDuration(block)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="min-w-0">
            <MiniHeading icon={Clock} label="Latest Ticks" />
            {latestTicks.length === 0 ? (
              <div className="font-mono text-[10px] text-chrome-text/55">none in window</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {latestTicks.map((tick, i) => {
                  const tickAt = tick.timestamp ?? tick.updatedAt ?? 0
                  return (
                    <span
                      key={`${tick.id ?? "tick"}:${i}`}
                      title={tickTitle(tick)}
                      className={cn("inline-flex h-5 items-center rounded border px-1.5 font-mono text-[9px]", tickSquareClass(tick.status, tickAt > nowMs))}
                    >
                      {tick.timestamp ? formatShortClock(tick.timestamp) : short(tick.status, 10)}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {recentEvents.length > 0 ? (
          <div>
            <MiniHeading icon={Bell} label="Recent Events" />
            <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-3">
              {recentEvents.map((event) => (
                <EventChip key={event.id} event={event} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-l border-chrome-border/45 pl-2">
      <div className="font-mono text-[15px] leading-none tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</div>
    </div>
  )
}

function MiniHeading({
  icon: Icon,
  label,
  right,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  right?: ReactNode
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
      <Icon className="h-3 w-3 text-rvbbit-accent" />
      <span>{label}</span>
      {right ? <span className="ml-auto normal-case tracking-normal text-chrome-text/55">{right}</span> : null}
    </div>
  )
}

function LaneActivityRibbon({ lane, bounds, nowMs }: { lane: TimelineLane; bounds: TimelineBounds; nowMs: number }) {
  const eventDots = lane.events
    .filter((event) => !!event.timestamp && event.timestamp >= bounds.startMs && event.timestamp <= bounds.endMs)
    .slice(-80)
  return (
    <div className="relative h-16 overflow-hidden rounded border border-chrome-border/45 bg-block-bg/35">
      {[0, 25, 50, 75, 100].map((left) => (
        <span key={left} className="absolute bottom-0 top-0 border-l border-chrome-border/20" style={{ left: `${left}%` }} />
      ))}
      {lane.runs.map((block) => {
        const left = timePct(Math.max(block.startMs, bounds.startMs), bounds)
        const right = timePct(Math.min(block.endMs, bounds.endMs), bounds)
        const width = Math.max(0.7, right - left)
        return (
          <span
            key={block.run.runId}
            className="absolute top-3 h-3 rounded-sm opacity-90"
            title={runBlockTitle(block)}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: statusFillColor(block.run.status),
              boxShadow: "0 0 16px color-mix(in oklch, currentColor 45%, transparent)",
            }}
          />
        )
      })}
      {lane.ticks.map((tick, i) => {
        const tickAt = tick.timestamp ?? tick.updatedAt
        if (!tickAt) return null
        const future = tickAt > nowMs
        return (
          <span
            key={`${tick.id ?? "tick"}:${i}`}
            className={cn("absolute top-7 h-5 w-1 rounded-sm border", tickSquareClass(tick.status, future))}
            title={tickTitle(tick)}
            style={{ left: `${timePct(tickAt, bounds)}%` }}
          />
        )
      })}
      {eventDots.map((event) => (
        <span
          key={event.id}
          className={cn("absolute bottom-3 h-1.5 w-1.5 -translate-x-1/2 rounded-full", eventDotClass(event.eventType))}
          title={eventTitle(event)}
          style={{ left: `${timePct(event.timestamp ?? bounds.startMs, bounds)}%` }}
        />
      ))}
      <span className="absolute bottom-0 top-0 z-10 border-l border-foreground/80" style={{ left: `${timePct(nowMs, bounds)}%` }} />
      <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 pb-1 font-mono text-[8px] text-chrome-text/45">
        <span>{formatShortClock(bounds.startMs)}</span>
        <span>{formatShortClock(bounds.endMs)}</span>
      </div>
    </div>
  )
}

interface StepRow {
  stepKey: string
  firstAt: number | null
  lastAt: number | null
  status: string
  count: number
  assetLabel: string | null
}

function StepLadder({ rows, currentStep }: { rows: StepRow[]; currentStep: string | null }) {
  if (rows.length === 0) {
    return <TinyEmpty label="No step events for this run" />
  }
  return (
    <div className="max-h-[178px] space-y-1 overflow-auto pr-1">
      {rows.slice(-10).map((row, index) => {
        const active = row.stepKey === currentStep
        return (
          <div
            key={row.stepKey}
            className={cn(
              "grid grid-cols-[22px_1fr_auto] items-center gap-2 border-l px-1.5 py-1",
              active ? "border-rvbbit-accent bg-rvbbit-accent/10" : "border-chrome-border/45",
            )}
          >
            <span className="font-mono text-[9px] tabular-nums text-chrome-text/45">{index + 1}</span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[10px] text-foreground" title={row.stepKey}>{row.stepKey}</div>
              <div className="truncate text-[9px] text-chrome-text/50">
                {row.assetLabel ?? row.status}
                {row.lastAt ? ` · ${fmtAgo(row.lastAt)}` : ""}
              </div>
            </div>
            <Pill className={eventClass(row.status)}>{short(row.status, 13)}</Pill>
          </div>
        )
      })}
    </div>
  )
}

function EventChip({ event }: { event: DagsterEventRow }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded border border-chrome-border/35 bg-foreground/[0.02] px-2 py-1">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", eventDotClass(event.eventType))} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[10px] text-foreground" title={event.eventType ?? undefined}>
          {short(event.eventType ?? "LOG", 24)}
        </div>
        <div className="truncate text-[9px] text-chrome-text/50">
          {event.stepKey ?? event.assetLabel ?? event.runId ?? `event ${event.id}`}
        </div>
      </div>
      <span className="font-mono text-[9px] text-chrome-text/45">{event.timestamp ? formatShortClock(event.timestamp) : "-"}</span>
    </div>
  )
}

function buildStepRows(events: DagsterEventRow[]): StepRow[] {
  const rows = new Map<string, StepRow>()
  for (const event of events) {
    if (!event.stepKey) continue
    const prev = rows.get(event.stepKey)
    if (!prev) {
      rows.set(event.stepKey, {
        stepKey: event.stepKey,
        firstAt: event.timestamp,
        lastAt: event.timestamp,
        status: event.eventType ?? "STEP",
        count: 1,
        assetLabel: event.assetLabel,
      })
      continue
    }
    prev.count += 1
    if ((event.timestamp ?? 0) >= (prev.lastAt ?? 0)) {
      prev.lastAt = event.timestamp
      prev.status = event.eventType ?? prev.status
      prev.assetLabel = event.assetLabel ?? prev.assetLabel
    }
    if ((event.timestamp ?? Number.POSITIVE_INFINITY) < (prev.firstAt ?? Number.POSITIVE_INFINITY)) {
      prev.firstAt = event.timestamp
    }
  }
  return [...rows.values()].sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0))
}

function tickCadenceSeries(ticks: DagsterAutomationTick[], bounds: TimelineBounds, buckets: number): number[] {
  const counts = new Array<number>(buckets).fill(0)
  const span = Math.max(1, bounds.endMs - bounds.startMs)
  for (const tick of ticks) {
    const at = tick.timestamp ?? tick.updatedAt
    if (!at || at < bounds.startMs || at > bounds.endMs) continue
    const index = Math.min(buckets - 1, Math.max(0, Math.floor(((at - bounds.startMs) / span) * buckets)))
    counts[index] += 1
  }
  return counts
}

function laneStatusSegments(lane: TimelineLane): { label: string; value: number; color: string }[] {
  const counts = new Map<string, number>()
  for (const block of lane.runs) {
    counts.set(block.run.status, (counts.get(block.run.status) ?? 0) + 1)
  }
  for (const tick of lane.ticks) {
    counts.set(tick.status, (counts.get(tick.status) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({ label, value, color: statusFillColor(label) }))
}

function topHistoryRows(events: DagsterEventRow[]) {
  const counts = new Map<string, { count: number; sub: string }>()
  for (const event of events) {
    const label = event.stepKey ?? event.assetLabel ?? event.eventType
    if (!label) continue
    const prev = counts.get(label) ?? { count: 0, sub: event.stepKey ? "step" : event.assetLabel ? "asset" : "event" }
    prev.count += 1
    counts.set(label, prev)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, value]) => ({
      label: short(label, 28),
      value: value.count,
      valueLabel: fmtCount(value.count),
      sub: value.sub,
      color: value.sub === "asset" ? "var(--success)" : value.sub === "step" ? "var(--rvbbit-accent)" : "var(--chrome-text)",
      title: label,
    }))
}

function eventTitle(event: DagsterEventRow): string {
  const lines = [event.eventType ?? "LOG"]
  if (event.stepKey) lines.push(`step: ${event.stepKey}`)
  if (event.assetLabel) lines.push(`asset: ${event.assetLabel}`)
  if (event.timestamp) lines.push(new Date(event.timestamp).toLocaleString())
  return lines.join("\n")
}

function eventDotClass(type: string | null): string {
  if (!type) return "bg-chrome-text/45"
  if (type.includes("FAIL")) return "bg-danger shadow-[0_0_8px_var(--danger)]"
  if (type.includes("SUCCESS") || type.includes("MATERIALIZATION")) return "bg-success"
  if (type.includes("CHECK")) return "bg-warning"
  if (type.includes("STEP")) return "bg-rvbbit-accent"
  return "bg-info"
}

function Overview({ snapshot }: { snapshot: DagsterSnapshot }) {
  const latestRuns = snapshot.runs.slice(0, 6)
  const latestEvents = snapshot.events.slice(0, 8)
  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="runs" value={fmtCount(snapshot.overview.runsTotal)} />
        <Stat label="events" value={fmtCount(snapshot.overview.eventsTotal)} />
        <Stat label="assets" value={fmtCount(snapshot.overview.assetsTotal)} />
        <Stat label="checks" value={fmtCount(snapshot.overview.checksTotal)} />
        <Stat label="failed checks" value={fmtCount(snapshot.overview.checksFailed)} tone={snapshot.overview.checksFailed > 0 ? "danger" : undefined} />
        <Stat label="automation" value={fmtCount(snapshot.overview.automationsTotal)} />
        <Stat label="heartbeats" value={fmtCount(snapshot.overview.daemonHeartbeats)} />
        <Stat label="latest event" value={snapshot.overview.latestEventAt ? fmtAgo(snapshot.overview.latestEventAt) : "never"} />
      </div>

      <div className="grid min-h-[420px] flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.9fr)]">
        <Panel icon={GitBranch} title="Asset Flow" right={<StatusCounts counts={snapshot.overview.statusCounts} />} className="flex min-h-[340px] flex-col">
          <DagsterFlowGraph flows={snapshot.flows} />
        </Panel>
        <Panel icon={Activity} title="Recent Runs" className="flex min-h-[300px] flex-col overflow-hidden">
          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
            {latestRuns.length === 0 ? <TinyEmpty label="No runs" /> : latestRuns.map((r) => <RunLine key={r.runId} run={r} />)}
          </div>
        </Panel>
      </div>

      <Panel icon={Bell} title="Recent Events" className="shrink-0">
        <div className="grid gap-1.5 md:grid-cols-2">
          {latestEvents.length === 0 ? <TinyEmpty label="No events" /> : latestEvents.map((e) => <EventLine key={e.id} event={e} />)}
        </div>
      </Panel>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warning" }) {
  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 px-2.5 py-2">
      <div className={cn("font-mono text-[16px] leading-none tabular-nums", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-foreground")}>
        {value}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</div>
    </div>
  )
}

function StatusCounts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
  if (entries.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([status, n]) => (
        <span key={status} className={cn("rounded border px-1 py-0.5 font-mono text-[9px]", statusClass(status))}>
          {status}: {fmtCount(n)}
        </span>
      ))}
    </span>
  )
}

function DagsterFlowGraph({ flows }: { flows: DagsterFlowEdge[] }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const data = useMemo(() => {
    const sources = [...new Set(flows.map((f) => f.source))].slice(0, 8)
    const assets = [...new Set(flows.map((f) => f.assetLabel))].slice(0, 12)
    const naturalHeight = Math.max(260, sources.length * 42 + 72, assets.length * 32 + 72)
    const containerHeight = size.width > 0 && size.height > 0 ? Math.round(760 * (size.height / size.width)) : 0
    const height = Math.max(naturalHeight, containerHeight)
    const spread = (count: number, top: number, bottom: number) => {
      if (count <= 1) return [Math.round(height / 2)]
      const usable = Math.max(1, height - top - bottom)
      return Array.from({ length: count }, (_, i) => Math.round(top + (usable * i) / (count - 1)))
    }
    const sourceY = new Map(sources.map((s, i) => [s, spread(sources.length, 36, 36)[i]]))
    const assetY = new Map(assets.map((a, i) => [a, spread(assets.length, 32, 32)[i]]))
    const edges = flows
      .filter((f) => sourceY.has(f.source) && assetY.has(f.assetLabel))
      .slice(0, 60)
    return { sources, assets, sourceY, assetY, edges, height }
  }, [flows, size.height, size.width])

  if (flows.length === 0) {
    return <TinyEmpty label="No asset event flow found" />
  }

  return (
    <div ref={ref} className="min-h-[300px] flex-1 overflow-hidden rounded border border-chrome-border/50 bg-block-bg/45">
      <svg viewBox={`0 0 760 ${data.height}`} className="block h-full min-h-[300px] w-full" preserveAspectRatio="xMidYMid meet">
        {data.edges.map((e, i) => {
          const y1 = data.sourceY.get(e.source) ?? 0
          const y2 = data.assetY.get(e.assetLabel) ?? 0
          const width = Math.max(1.2, Math.min(5, Math.log10(e.count + 1) * 1.7))
          const color = e.eventType === "ASSET_FAILED_TO_MATERIALIZE" ? "var(--danger)" : e.eventType === "ASSET_CHECK_EVALUATION" ? "var(--warning)" : "var(--rvbbit-accent)"
          return (
            <path
              key={`${e.source}:${e.assetKey}:${e.eventType}:${i}`}
              d={`M 178 ${y1} C 300 ${y1}, 430 ${y2}, 572 ${y2}`}
              fill="none"
              stroke={color}
              strokeWidth={width}
              opacity={0.42}
            />
          )
        })}
        {data.sources.map((s) => {
          const y = data.sourceY.get(s) ?? 0
          return (
            <g key={s}>
              <rect x="12" y={y - 12} width="160" height="24" rx="5" fill="color-mix(in oklch, var(--secondary-background) 92%, black)" stroke="var(--chrome-border)" />
              <text x="22" y={y + 4} fill="var(--foreground)" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                {short(s, 24)}
              </text>
            </g>
          )
        })}
        {data.assets.map((a) => {
          const y = data.assetY.get(a) ?? 0
          return (
            <g key={a}>
              <rect x="586" y={y - 11} width="162" height="22" rx="5" fill="color-mix(in oklch, var(--secondary-background) 92%, black)" stroke="var(--rvbbit-accent)" />
              <text x="596" y={y + 4} fill="var(--foreground)" fontSize="9.5" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                {short(a, 25)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function RunsTable({ rows }: { rows: DagsterRunRow[] }) {
  return (
    <Panel icon={Play} title="Runs">
      <DataTable
        empty="No runs"
        head={["status", "job", "duration", "updated", "partition", "run"]}
        rows={rows.map((r) => [
          <Pill key="status" className={statusClass(r.status)}>{r.status}</Pill>,
          <div key="job" className="truncate text-foreground">{r.jobName}</div>,
          r.durationMs != null ? fmtMs(r.durationMs) : "-",
          r.updatedAt ? fmtAgo(r.updatedAt) : "-",
          r.partition ?? r.partitionSet ?? "-",
          <span key="run" className="font-mono text-chrome-text/65">{short(r.runId, 18)}</span>,
        ])}
      />
    </Panel>
  )
}

function AssetsTable({ rows }: { rows: DagsterAssetRow[] }) {
  return (
    <Panel icon={Table2} title="Assets">
      <DataTable
        empty="No assets"
        head={["asset", "last event", "materialized", "observed", "checks", "last run"]}
        rows={rows.map((a) => [
          <div key="asset" className="truncate text-foreground" title={a.assetKey}>{a.label}</div>,
          a.lastEventAt ? fmtAgo(a.lastEventAt) : "never",
          <span key="mat" className={a.failedMaterializations > 0 ? "text-warning" : undefined}>{fmtCount(a.materializations)}</span>,
          fmtCount(a.observations),
          fmtCount(a.checks),
          a.lastRunId ? <span key="run" className="font-mono text-chrome-text/65">{short(a.lastRunId, 18)}</span> : "-",
        ])}
      />
    </Panel>
  )
}

function ChecksTable({ rows }: { rows: DagsterCheckRow[] }) {
  return (
    <Panel icon={CheckCircle2} title="Checks">
      <DataTable
        empty="No asset checks"
        head={["status", "check", "asset", "evaluated", "partition", "run"]}
        rows={rows.map((c) => [
          <Pill key="status" className={statusClass(c.status)}>{c.status}</Pill>,
          <div key="check" className="truncate text-foreground">{c.checkName}</div>,
          <div key="asset" className="truncate">{c.assetLabel}</div>,
          c.evaluatedAt ? fmtAgo(c.evaluatedAt) : "-",
          c.partition ?? "-",
          c.runId ? <span key="run" className="font-mono text-chrome-text/65">{short(c.runId, 18)}</span> : "-",
        ])}
      />
    </Panel>
  )
}

function AutomationTable({ rows, nowMs }: { rows: DagsterAutomationRow[]; nowMs: number }) {
  return (
    <Panel icon={Clock} title="Automation">
      <DataTable
        empty="No schedules or sensors"
        head={["status", "automation", "type", "recent ticks", "updated", "last tick"]}
        rows={rows.map((a) => [
          <Pill key="status" className={statusClass(a.status)}>{a.status}</Pill>,
          <div key="name" className="min-w-0">
            <div className="truncate text-foreground" title={a.name}>{a.name}</div>
            <div className="truncate font-mono text-[9px] text-chrome-text/45" title={a.id}>{short(a.id, 44)}</div>
          </div>,
          a.type,
          <TickStrip key="ticks" ticks={a.ticks} nowMs={nowMs} />,
          a.updatedAt ? fmtAgo(a.updatedAt) : "-",
          a.lastTickAt ? fmtAgo(a.lastTickAt) : "-",
        ])}
      />
    </Panel>
  )
}

function TickStrip({ ticks, nowMs }: { ticks: DagsterAutomationTick[]; nowMs: number }) {
  if (ticks.length === 0) return <span className="text-chrome-text/35">no ticks</span>
  return (
    <div className="flex max-w-[280px] items-center gap-[3px]">
      {ticks.map((tick, i) => {
        const tickAt = tick.timestamp ?? tick.updatedAt ?? 0
        return (
          <span
            key={`${tick.id ?? "tick"}:${i}`}
            title={tickTitle(tick)}
            className={cn("h-2 w-2 shrink-0 rounded-[2px] border", tickSquareClass(tick.status, tickAt > nowMs))}
          />
        )
      })}
    </div>
  )
}

function EventsTable({ rows }: { rows: DagsterEventRow[] }) {
  return (
    <Panel icon={Bell} title="Events">
      <DataTable
        empty="No events"
        head={["type", "time", "asset", "step", "partition", "run"]}
        rows={rows.map((e) => [
          <Pill key="type" className={eventClass(e.eventType)}>{e.eventType ?? "LOG"}</Pill>,
          e.timestamp ? fmtAgo(e.timestamp) : "-",
          e.assetLabel ? <span key="asset" title={e.assetKey ?? undefined}>{e.assetLabel}</span> : "-",
          e.stepKey ?? "-",
          e.partition ?? "-",
          e.runId ? <span key="run" className="font-mono text-chrome-text/65">{short(e.runId, 18)}</span> : "-",
        ])}
      />
    </Panel>
  )
}

function DataTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <TinyEmpty label={empty} />
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-[11px]">
        <thead className="sticky top-0 z-10 bg-secondary-background">
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-chrome-border px-2 py-1.5 font-normal uppercase tracking-wider text-chrome-text/55">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="odd:bg-foreground/[0.018] hover:bg-foreground/[0.045]">
              {r.map((cell, j) => (
                <td key={j} className="max-w-[260px] truncate border-b border-chrome-border/30 px-2 py-1.5 align-middle text-chrome-text/80">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RunLine({ run }: { run: DagsterRunRow }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded border border-chrome-border/45 bg-foreground/[0.025] px-2 py-1.5">
      <Pill className={statusClass(run.status)}>{run.status}</Pill>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-foreground">{run.jobName}</div>
        <div className="font-mono text-[9px] text-chrome-text/45">{short(run.runId, 22)}</div>
      </div>
      <div className="text-right font-mono text-[10px] text-chrome-text/55">
        {run.updatedAt ? fmtAgo(run.updatedAt) : "-"}
      </div>
    </div>
  )
}

function EventLine({ event }: { event: DagsterEventRow }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded border border-chrome-border/45 bg-foreground/[0.025] px-2 py-1.5">
      <Pill className={eventClass(event.eventType)}>{short(event.eventType ?? "LOG", 24)}</Pill>
      <div className="min-w-0 flex-1 truncate text-[11px] text-chrome-text/80">
        {event.assetLabel ?? event.stepKey ?? event.runId ?? `event ${event.id}`}
      </div>
      <div className="font-mono text-[10px] text-chrome-text/50">{event.timestamp ? fmtAgo(event.timestamp) : "-"}</div>
    </div>
  )
}

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center rounded border px-1.5 py-0.5 font-mono text-[9px] leading-none", className)}>
      <span className="truncate">{children}</span>
    </span>
  )
}

function Empty({
  icon: Icon,
  title,
  detail,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
  tone?: "danger"
}) {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-sm rounded-md border border-chrome-border bg-secondary-background/45 p-4 text-center">
        <Icon className={cn("mx-auto h-6 w-6", tone === "danger" ? "text-danger" : "text-chrome-text/60")} />
        <div className="mt-2 text-[13px] font-medium text-foreground">{title}</div>
        <div className="mt-1 text-[11px] leading-snug text-chrome-text/60">{detail}</div>
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div className="grid h-full place-items-center text-[11px] text-chrome-text/60">
      <span className="inline-flex items-center gap-2">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        Loading Dagster metadata
      </span>
    </div>
  )
}

function TinyEmpty({ label }: { label: string }) {
  return <div className="rounded border border-dashed border-chrome-border/55 px-3 py-6 text-center text-[11px] text-chrome-text/45">{label}</div>
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      setSize((prev) => {
        const width = Math.round(rect.width)
        const height = Math.round(rect.height)
        return prev.width === width && prev.height === height ? prev : { width, height }
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

function timelineBounds(nowMs: number, rangeHours: TimelineRangeHours): TimelineBounds {
  const hour = 60 * 60 * 1000
  const endMs = Math.ceil(nowMs / hour) * hour
  return { startMs: endMs - rangeHours * hour, endMs }
}

function timelineAxisTicks(bounds: TimelineBounds, rangeHours: TimelineRangeHours): number[] {
  const minute = 60 * 1000
  const hour = 60 * minute
  const step = rangeHours === 1 ? 15 * minute : rangeHours === 24 ? 2 * hour : hour
  const first = Math.ceil(bounds.startMs / step) * step
  const ticks: number[] = []
  for (let t = first; t <= bounds.endMs; t += step) ticks.push(t)
  return ticks
}

function buildTimelineLanes(
  snapshot: DagsterSnapshot,
  bounds: TimelineBounds,
  nowMs: number,
  query: string,
): TimelineLane[] {
  const normalizedQuery = query.trim().toLowerCase()
  const lanes = snapshot.automations.length > 0
    ? snapshot.automations.map((automation) => {
      const runs = matchingRunBlocks(automation, snapshot.runs, bounds, nowMs)
      const events = eventsForRunBlocks(snapshot.events, runs)
      const ticks = automation.ticks
        .filter((tick) => {
          const t = tick.timestamp ?? tick.updatedAt
          return !!t && t >= bounds.startMs && t <= bounds.endMs
        })
        .sort((a, b) => (a.timestamp ?? a.updatedAt ?? 0) - (b.timestamp ?? b.updatedAt ?? 0))
      const runActivity = runs.map((block) => Math.max(block.endMs, block.run.updatedAt ?? 0))
      const tickActivity = automation.ticks.map((tick) => tick.updatedAt ?? tick.timestamp ?? 0)
      const lastActivityAt = maxEpoch([
        automation.lastTickAt,
        automation.updatedAt,
        ...runActivity,
        ...tickActivity,
      ])
      return {
        id: `automation:${automation.id}`,
        name: automation.name,
        type: automation.type,
        status: automation.status,
        updatedAt: automation.updatedAt,
        lastTickAt: automation.lastTickAt,
        lastTickStatus: automation.lastTickStatus,
        lastActivityAt,
        ticks,
        runs,
        events,
        activityCount: ticks.length + runs.length + events.length,
      } satisfies TimelineLane
    })
    : buildRunOnlyLanes(snapshot.runs, snapshot.events, bounds, nowMs)

  return lanes
    .filter((lane) => {
      if (!normalizedQuery) return true
      const haystack = [
        lane.name,
        lane.type,
        lane.status,
        lane.lastTickStatus ?? "",
        ...lane.runs.map((block) => block.run.jobName),
      ].join(" ").toLowerCase()
      return haystack.includes(normalizedQuery)
    })
    .sort((a, b) => {
      const aActive = a.activityCount > 0 ? 1 : 0
      const bActive = b.activityCount > 0 ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name)
    })
    .slice(0, 120)
}

function matchingRunBlocks(
  automation: DagsterAutomationRow,
  runs: DagsterRunRow[],
  bounds: TimelineBounds,
  nowMs: number,
): TimelineRunBlock[] {
  const aliases = automationAliases(automation)
  return runs
    .filter((run) => {
      const jobKey = normalizeTimelineKey(run.jobName)
      return aliases.some((alias) => alias === jobKey || (alias.length > 4 && jobKey.includes(alias)) || (jobKey.length > 4 && alias.includes(jobKey)))
    })
    .map((run) => runToBlock(run, bounds, nowMs))
    .filter((block): block is TimelineRunBlock => !!block)
    .sort((a, b) => a.startMs - b.startMs)
}

function buildRunOnlyLanes(runs: DagsterRunRow[], events: DagsterEventRow[], bounds: TimelineBounds, nowMs: number): TimelineLane[] {
  const groups = new Map<string, DagsterRunRow[]>()
  for (const run of runs) {
    const key = run.jobName || "(unknown)"
    const list = groups.get(key) ?? []
    list.push(run)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([jobName, jobRuns]) => {
    const blocks = jobRuns
      .map((run) => runToBlock(run, bounds, nowMs))
      .filter((block): block is TimelineRunBlock => !!block)
      .sort((a, b) => a.startMs - b.startMs)
    const latest = jobRuns.slice().sort((a, b) => (b.updatedAt ?? b.endedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.endedAt ?? a.startedAt ?? 0))[0]
    const laneEvents = eventsForRunBlocks(events, blocks)
    return {
      id: `job:${normalizeTimelineKey(jobName)}`,
      name: jobName,
      type: "job",
      status: latest?.status ?? "UNKNOWN",
      updatedAt: latest?.updatedAt ?? null,
      lastTickAt: null,
      lastTickStatus: null,
      lastActivityAt: maxEpoch(jobRuns.map((run) => run.updatedAt ?? run.endedAt ?? run.startedAt ?? run.createdAt ?? 0)),
      ticks: [],
      runs: blocks,
      events: laneEvents,
      activityCount: blocks.length + laneEvents.length,
    } satisfies TimelineLane
  })
}

function eventsForRunBlocks(events: DagsterEventRow[], runs: TimelineRunBlock[]): DagsterEventRow[] {
  if (runs.length === 0 || events.length === 0) return []
  const runIds = new Set(runs.map((block) => block.run.runId))
  return events
    .filter((event) => !!event.runId && runIds.has(event.runId))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id - b.id)
}

function runToBlock(run: DagsterRunRow, bounds: TimelineBounds, nowMs: number): TimelineRunBlock | null {
  const startMs = run.startedAt ?? run.createdAt ?? run.updatedAt
  if (!startMs) return null
  const naturalEnd = run.endedAt ?? (isRunningStatus(run.status) ? nowMs : run.updatedAt) ?? startMs
  const minVisibleEnd = startMs + 4 * 60 * 1000
  const endMs = Math.max(naturalEnd, minVisibleEnd)
  if (endMs < bounds.startMs || startMs > bounds.endMs) return null
  return { run, startMs, endMs }
}

function automationAliases(automation: DagsterAutomationRow): string[] {
  const trimmedName = automation.name
    .replace(/_(job_)?schedule$/i, "")
    .replace(/_(schedule|sensor)$/i, "")
    .replace(/_job$/i, "")
  return [...new Set([automation.name, trimmedName, automation.id].map(normalizeTimelineKey).filter(Boolean))]
}

function normalizeTimelineKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function maxEpoch(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
  return finite.length ? Math.max(...finite) : null
}

function timePct(epochMs: number, bounds: TimelineBounds): number {
  const span = bounds.endMs - bounds.startMs
  if (span <= 0) return 0
  return Math.max(0, Math.min(100, ((epochMs - bounds.startMs) / span) * 100))
}

function formatTimelineDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  })
}

function formatTimelineWindow(bounds: TimelineBounds): string {
  return `${formatShortClock(bounds.startMs)}-${formatShortClock(bounds.endMs)}`
}

function formatAxisLabel(epochMs: number, rangeHours: TimelineRangeHours): string {
  const opts: Intl.DateTimeFormatOptions = rangeHours === 1
    ? { hour: "numeric", minute: "2-digit" }
    : { hour: "numeric" }
  return new Date(epochMs).toLocaleTimeString([], opts).replace(/\s/g, "")
}

function formatShortClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  }).replace(/\s/g, "")
}

function runBlockTitle(block: TimelineRunBlock): string {
  const lines = [
    block.run.jobName,
    `status: ${block.run.status}`,
    `start: ${new Date(block.startMs).toLocaleString()}`,
    `duration: ${formatRunDuration(block)}`,
  ]
  if (block.run.runId) lines.push(`run: ${block.run.runId}`)
  if (block.run.partition) lines.push(`partition: ${block.run.partition}`)
  return lines.join("\n")
}

function formatRunDuration(block: TimelineRunBlock): string {
  return fmtMs(Math.max(0, block.endMs - block.startMs))
}

function isDangerStatus(status: string): boolean {
  const s = status.toUpperCase()
  return s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")
}

function isRunningStatus(status: string): boolean {
  const s = status.toUpperCase()
  return s.includes("RUN") || s.includes("START")
}

function statusFillColor(status: string): string {
  const s = status.toUpperCase()
  if (s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")) return "var(--danger)"
  if (s.includes("SKIP") || s.includes("WARN")) return "var(--warning)"
  if (s.includes("QUEU") || s.includes("START") || s.includes("RUN")) return "var(--rvbbit-accent)"
  if (s.includes("SUCCESS")) return "var(--success)"
  return "oklch(62% 0.045 245)"
}

function statusStrokeColor(status: string): string {
  const s = status.toUpperCase()
  if (s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")) return "color-mix(in oklch, var(--danger) 78%, white)"
  if (s.includes("SKIP") || s.includes("WARN")) return "color-mix(in oklch, var(--warning) 78%, white)"
  if (s.includes("QUEU") || s.includes("START") || s.includes("RUN")) return "color-mix(in oklch, var(--rvbbit-accent) 78%, white)"
  if (s.includes("SUCCESS")) return "color-mix(in oklch, var(--success) 78%, white)"
  return "oklch(72% 0.05 245)"
}

function statusDotClass(status: string): string {
  const s = status.toUpperCase()
  if (s.includes("FAIL") || s.includes("ERROR") || s.includes("CANCEL")) return "bg-danger shadow-[0_0_10px_var(--danger)]"
  if (s.includes("SKIP") || s.includes("WARN")) return "bg-warning shadow-[0_0_10px_var(--warning)]"
  if (s.includes("QUEU") || s.includes("START") || s.includes("RUN")) return "bg-rvbbit-accent shadow-[0_0_10px_var(--rvbbit-accent)]"
  if (s.includes("SUCCESS")) return "bg-success shadow-[0_0_10px_var(--success)]"
  return "bg-chrome-text/55"
}

function tickTitle(tick: DagsterAutomationTick): string {
  const lines = [`status: ${tick.status}`]
  if (tick.type) lines.push(`type: ${tick.type}`)
  if (tick.timestamp) lines.push(`time: ${fmtAgo(tick.timestamp)} (${new Date(tick.timestamp).toLocaleString()})`)
  if (tick.updatedAt) lines.push(`updated: ${fmtAgo(tick.updatedAt)}`)
  if (tick.id) lines.push(`tick: ${tick.id}`)
  return lines.join("\n")
}

function tickSquareClass(status: string, future = false): string {
  if (future) return "border-info/70 bg-info/25 text-info shadow-[0_0_10px_var(--info)]"
  const s = status.toUpperCase()
  if (s.includes("FAIL") || s.includes("ERROR")) return "border-danger/70 bg-danger"
  if (s.includes("SUCCESS")) return "border-success/70 bg-success"
  if (s.includes("SKIP")) return "border-warning/70 bg-warning"
  if (s.includes("START") || s.includes("RUN")) return "border-rvbbit-accent/70 bg-rvbbit-accent"
  return "border-chrome-border bg-chrome-text/35"
}

function statusClass(status: string): string {
  const s = status.toUpperCase()
  if (s.includes("FAIL") || s.includes("CANCEL")) return "border-danger/35 bg-danger/10 text-danger"
  if (s.includes("SUCCESS")) return "border-success/35 bg-success/10 text-success"
  if (s.includes("QUEU") || s.includes("START") || s.includes("PLANNED")) return "border-rvbbit-accent/35 bg-rvbbit-accent/10 text-rvbbit-accent"
  if (s.includes("RUN")) return "border-rvbbit-accent/35 bg-rvbbit-accent/10 text-rvbbit-accent"
  if (s.includes("SKIP") || s.includes("WARN")) return "border-warning/35 bg-warning/10 text-warning"
  return "border-chrome-border/70 bg-foreground/[0.04] text-chrome-text/75"
}

function eventClass(type: string | null): string {
  if (!type) return "border-chrome-border/70 bg-foreground/[0.04] text-chrome-text/75"
  if (type.includes("FAIL")) return "border-danger/35 bg-danger/10 text-danger"
  if (type.includes("MATERIALIZATION")) return "border-success/35 bg-success/10 text-success"
  if (type.includes("CHECK")) return "border-warning/35 bg-warning/10 text-warning"
  if (type.includes("STEP")) return "border-rvbbit-accent/35 bg-rvbbit-accent/10 text-rvbbit-accent"
  return "border-chrome-border/70 bg-foreground/[0.04] text-chrome-text/75"
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(1, max - 3))}...` : value
}
