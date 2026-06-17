"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ComponentType } from "react"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCode2,
  Filter,
  Globe,
  Pause,
  Play,
  RefreshCw,
  Search,
  Table2,
  Users,
  X,
} from "@/lib/icons"
import {
  fetchMcpIncomingSnapshot,
  type McpIncomingActivity,
  type McpIncomingBucket,
  type McpIncomingCaller,
  type McpIncomingError,
  type McpIncomingObject,
  type McpIncomingRange,
  type McpIncomingSnapshot,
  type McpIncomingTool,
} from "@/lib/rvbbit/mcp-incoming"
import { fmtAgo, fmtCount, fmtMs, Panel } from "./instruments"
import { CodePreview } from "./code-preview"
import { cn } from "@/lib/utils"

type StatusFilter = "all" | "ok" | "error"

interface McpIncomingWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  workspaceActive: boolean
  onOpenSql: (sql: string, title: string) => void
}

const RANGES: { key: McpIncomingRange; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
]

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ok", label: "OK" },
  { key: "error", label: "Errors" },
]

const TOOL_COLORS = [
  "oklch(71% 0.17 205)",
  "oklch(73% 0.16 150)",
  "oklch(76% 0.16 82)",
  "oklch(69% 0.18 27)",
  "oklch(70% 0.16 300)",
  "oklch(72% 0.12 245)",
  "oklch(76% 0.15 120)",
]

export function McpIncomingWindow({
  activeConnectionId,
  hasRvbbit,
  workspaceActive,
  onOpenSql,
}: McpIncomingWindowProps) {
  const [range, setRange] = useState<McpIncomingRange>("24h")
  const [snapshot, setSnapshot] = useState<McpIncomingSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [callerFilter, setCallerFilter] = useState<string | null>(null)
  const [toolFilter, setToolFilter] = useState<string | null>(null)
  const [objectFilter, setObjectFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) {
      setSnapshot(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await fetchMcpIncomingSnapshot(activeConnectionId, range)
      setSnapshot(next)
      setError(next.error ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId, hasRvbbit, range])

  useEffect(() => {
    if (!workspaceActive) return
    queueMicrotask(() => {
      void refresh()
    })
  }, [refresh, workspaceActive])

  useEffect(() => {
    if (!workspaceActive || paused || !activeConnectionId || !hasRvbbit) return
    const id = window.setInterval(() => {
      void refresh()
    }, 30_000)
    return () => window.clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, refresh, workspaceActive])

  const activities = useMemo(() => snapshot?.activities ?? [], [snapshot])
  const statusScopedActivities = useMemo(
    () => activities.filter((a) => statusMatches(a, statusFilter)),
    [activities, statusFilter],
  )
  const filteredActivities = useMemo(
    () =>
      statusScopedActivities.filter((a) => {
        if (callerFilter && a.actor !== callerFilter) return false
        if (toolFilter && a.tool !== toolFilter) return false
        if (objectFilter && !a.objects.includes(objectFilter)) return false
        return true
      }),
    [callerFilter, objectFilter, statusScopedActivities, toolFilter],
  )

  const selected = useMemo(
    () => filteredActivities.find((a) => a.id === selectedId) ?? filteredActivities[0] ?? null,
    [filteredActivities, selectedId],
  )

  const hasFilters = !!callerFilter || !!toolFilter || !!objectFilter || statusFilter !== "all"
  const clearFilters = () => {
    setCallerFilter(null)
    setToolFilter(null)
    setObjectFilter(null)
    setStatusFilter("all")
  }

  const openSelectedSql = useCallback(
    (activity: McpIncomingActivity) => {
      if (!activity.sql) return
      const title = `MCP SQL · ${activity.tool}`
      onOpenSql(activity.sql, title)
    },
    [onOpenSql],
  )

  const detected = !!snapshot?.detected
  const subtitle = !activeConnectionId
    ? "no active connection"
    : !hasRvbbit
      ? "rvbbit unavailable"
      : loading && !snapshot
        ? "loading activity"
        : detected
          ? `${fmtCount(snapshot.overview.calls)} calls · ${snapshot.overview.lastSeen ? fmtAgo(snapshot.overview.lastSeen) : "no events"}`
          : "rvbbit.mcp_activity not found"

  return (
    <div className="flex h-full flex-col bg-doc-bg text-foreground group-data-[focused=false]/window:bg-doc-bg/70">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/35 px-2">
        <div className="grid h-6 w-6 place-items-center rounded border border-chrome-border/60 bg-foreground/[0.04]">
          <Activity className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold leading-tight text-foreground">MCP Incoming</div>
          <div className="truncate font-mono text-[9px] text-chrome-text/55">{subtitle}</div>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <Segmented
            items={RANGES}
            value={range}
            onChange={(next) => setRange(next as McpIncomingRange)}
            title="Range"
          />
          <Segmented
            items={STATUS_FILTERS}
            value={statusFilter}
            onChange={(next) => setStatusFilter(next as StatusFilter)}
            title="Status"
          />
          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              title="Clear filters"
              className="grid h-7 w-7 place-items-center rounded text-chrome-text transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
            className="grid h-7 w-7 place-items-center rounded text-chrome-text transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || !activeConnectionId || !hasRvbbit}
            title="Refresh"
            className="grid h-7 w-7 place-items-center rounded text-chrome-text transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-45"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!activeConnectionId ? (
          <Empty icon={Database} title="No active connection" detail="Open a connection to read MCP activity." />
        ) : !hasRvbbit ? (
          <Empty icon={Globe} title="rvbbit unavailable" detail="MCP incoming activity is stored in rvbbit metadata tables." />
        ) : loading && !snapshot ? (
          <Loading />
        ) : error ? (
          <Empty icon={AlertTriangle} title="MCP activity failed" detail={error} tone="danger" />
        ) : !detected || !snapshot ? (
          <Empty icon={Activity} title="No MCP activity log" detail="rvbbit.mcp_activity was not found on this connection." />
        ) : (
          <div className="flex min-h-full flex-col gap-3">
            <OverviewStats snapshot={snapshot} filtered={filteredActivities.length} total={activities.length} />
            <ActiveFilters
              caller={callerFilter}
              tool={toolFilter}
              object={objectFilter}
              status={statusFilter}
              onClearCaller={() => setCallerFilter(null)}
              onClearTool={() => setToolFilter(null)}
              onClearObject={() => setObjectFilter(null)}
              onClearStatus={() => setStatusFilter("all")}
            />

            <div className="grid min-h-[540px] flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.8fr)]">
              <Panel
                icon={Filter}
                title="Flow"
                right={<BucketStrip buckets={snapshot.buckets} />}
                className="flex min-h-[420px] flex-col overflow-hidden"
              >
                <McpFlowGraph
                  activities={statusScopedActivities}
                  selected={selected}
                  callerFilter={callerFilter}
                  toolFilter={toolFilter}
                  objectFilter={objectFilter}
                  onCaller={(caller) => setCallerFilter((cur) => (cur === caller ? null : caller))}
                  onTool={(tool) => setToolFilter((cur) => (cur === tool ? null : tool))}
                  onObject={(object) => setObjectFilter((cur) => (cur === object ? null : object))}
                />
              </Panel>

              <div className="flex min-h-[420px] flex-col gap-3">
                <SelectedCall activity={selected} onOpenSql={openSelectedSql} />
                <PeoplePanel
                  callers={snapshot.callers}
                  activities={activities}
                  range={range}
                  selected={callerFilter}
                  onSelect={(actor) => setCallerFilter((cur) => (cur === actor ? null : actor))}
                />
              </div>
            </div>

            <div className="grid min-h-[420px] grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.8fr)]">
              <Panel
                icon={Activity}
                title="Activity"
                right={
                  <span className="font-mono text-[9px] text-chrome-text/60">
                    {fmtCount(filteredActivities.length)} / {fmtCount(activities.length)}
                  </span>
                }
                className="flex min-h-[360px] flex-col overflow-hidden"
              >
                <ActivityStream rows={filteredActivities} selectedId={selected?.id ?? null} onSelect={setSelectedId} onOpenSql={openSelectedSql} />
              </Panel>

              <div className="grid min-h-[360px] grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <ObjectsPanel
                  objects={snapshot.objects}
                  selected={objectFilter}
                  onSelect={(object) => setObjectFilter((cur) => (cur === object ? null : object))}
                />
                <ErrorsPanel errors={snapshot.errors} onOpenSql={(sql) => onOpenSql(sql, "MCP Error SQL")} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <ToolsPanel
                tools={snapshot.tools}
                selected={toolFilter}
                onSelect={(tool) => setToolFilter((cur) => (cur === tool ? null : tool))}
              />
              <ResultShapePanel activity={selected} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function OverviewStats({ snapshot, filtered, total }: { snapshot: McpIncomingSnapshot; filtered: number; total: number }) {
  const o = snapshot.overview
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-9">
      <Stat label="calls" value={fmtCount(o.calls)} />
      <Stat label="visible" value={`${fmtCount(filtered)}/${fmtCount(total)}`} />
      <Stat label="people" value={fmtCount(o.callers)} />
      <Stat label="tools" value={fmtCount(o.tools)} />
      <Stat label="objects" value={fmtCount(o.objects)} />
      <Stat label="errors" value={fmtCount(o.errors)} tone={o.errors > 0 ? "danger" : "success"} />
      <Stat label="sql" value={fmtCount(o.sqlCalls)} />
      <Stat label="rows" value={fmtCount(o.rowsReturned)} />
      <Stat label="p95" value={o.p95Ms == null ? "0ms" : fmtMs(o.p95Ms)} />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 px-2.5 py-2">
      <div className={cn("truncate font-mono text-[16px] leading-none tabular-nums", tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-foreground")}>
        {value}
      </div>
      <div className="mt-1 truncate text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</div>
    </div>
  )
}

function ActiveFilters({
  caller,
  tool,
  object,
  status,
  onClearCaller,
  onClearTool,
  onClearObject,
  onClearStatus,
}: {
  caller: string | null
  tool: string | null
  object: string | null
  status: StatusFilter
  onClearCaller: () => void
  onClearTool: () => void
  onClearObject: () => void
  onClearStatus: () => void
}) {
  if (!caller && !tool && !object && status === "all") return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      {caller ? <FilterChip label="person" value={caller} onClear={onClearCaller} /> : null}
      {tool ? <FilterChip label="tool" value={tool} onClear={onClearTool} /> : null}
      {object ? <FilterChip label="object" value={object} onClear={onClearObject} /> : null}
      {status !== "all" ? <FilterChip label="status" value={status} onClear={onClearStatus} /> : null}
    </div>
  )
}

function FilterChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={`Clear ${label}`}
      className="inline-flex max-w-[260px] items-center gap-1 rounded border border-rvbbit-accent/30 bg-rvbbit-accent/10 px-2 py-1 text-[10px] text-rvbbit-accent"
    >
      <span className="shrink-0 uppercase tracking-wider opacity-70">{label}</span>
      <span className="truncate font-mono">{value}</span>
      <X className="h-3 w-3 shrink-0" />
    </button>
  )
}

function McpFlowGraph({
  activities,
  selected,
  callerFilter,
  toolFilter,
  objectFilter,
  onCaller,
  onTool,
  onObject,
}: {
  activities: McpIncomingActivity[]
  selected: McpIncomingActivity | null
  callerFilter: string | null
  toolFilter: string | null
  objectFilter: string | null
  onCaller: (caller: string) => void
  onTool: (tool: string) => void
  onObject: (object: string) => void
}) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const graph = useMemo(
    () => buildFlow(activities, size.width, size.height, { callerFilter, toolFilter, objectFilter, selected }),
    [activities, callerFilter, objectFilter, selected, size.height, size.width, toolFilter],
  )

  return (
    <div ref={ref} className="relative min-h-[320px] flex-1 overflow-hidden">
      {size.width > 0 && size.height > 0 && graph.nodes.length > 0 ? (
        <>
          <svg className="absolute inset-0 h-full w-full" width={size.width} height={size.height} role="img">
            <defs>
              <linearGradient id="mcp-flow-ok" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="var(--rvbbit-accent)" stopOpacity="0.30" />
                <stop offset="100%" stopColor="var(--success)" stopOpacity="0.60" />
              </linearGradient>
              <linearGradient id="mcp-flow-err" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="var(--warning)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--danger)" stopOpacity="0.70" />
              </linearGradient>
            </defs>
            {graph.edges.map((e, i) => (
              <path
                key={`${e.from.key}:${e.to.key}:${i}`}
                d={curvePath(e.from.x, e.from.y, e.to.x, e.to.y)}
                fill="none"
                stroke={e.errors > 0 ? "url(#mcp-flow-err)" : "url(#mcp-flow-ok)"}
                strokeWidth={e.width}
                strokeLinecap="round"
                opacity={e.active ? 0.92 : 0.28}
              />
            ))}
          </svg>
          {graph.nodes.map((n) => (
            <button
              key={`${n.kind}:${n.key}`}
              type="button"
              onClick={() => {
                if (n.kind === "caller") onCaller(n.key)
                if (n.kind === "tool") onTool(n.key)
                if (n.kind === "object") onObject(n.key)
              }}
              title={`${n.label} · ${fmtCount(n.calls)} calls`}
              className={cn(
                "absolute flex h-[30px] items-center gap-1.5 rounded border px-2 text-left shadow-sm transition-colors",
                n.active
                  ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-foreground"
                  : "border-chrome-border/70 bg-chrome-bg/90 text-chrome-text hover:border-rvbbit-accent/45 hover:text-foreground",
              )}
              style={{
                left: n.x - n.w / 2,
                top: n.y - 15,
                width: n.w,
              }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: n.color }} />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{n.label}</span>
              <span className="shrink-0 font-mono text-[9px] text-chrome-text/55">{fmtCount(n.calls)}</span>
            </button>
          ))}
          <AxisLabel x={graph.axis.callers} label="People" />
          <AxisLabel x={graph.axis.tools} label="Tools" />
          <AxisLabel x={graph.axis.objects} label="Objects" />
        </>
      ) : (
        <TinyEmpty label="No activity" />
      )}
    </div>
  )
}

function AxisLabel({ x, label }: { x: number; label: string }) {
  return (
    <div
      className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-sm bg-doc-bg/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45"
      style={{ left: x }}
    >
      {label}
    </div>
  )
}

function SelectedCall({ activity, onOpenSql }: { activity: McpIncomingActivity | null; onOpenSql: (activity: McpIncomingActivity) => void }) {
  return (
    <Panel icon={FileCode2} title="Selected Call" className="flex min-h-[246px] flex-col overflow-hidden">
      {!activity ? (
        <TinyEmpty label="No call selected" />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
          <div className="flex items-start gap-2">
            <StatusPill ok={activity.ok} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px] text-foreground">{activity.tool}</div>
              <div className="truncate font-mono text-[10px] text-chrome-text/55">{activity.actor}</div>
            </div>
            {activity.sql ? (
              <button
                type="button"
                onClick={() => onOpenSql(activity)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-rvbbit-accent/35 bg-rvbbit-accent/10 px-2 py-1 text-[10px] text-rvbbit-accent transition-colors hover:bg-rvbbit-accent/15"
              >
                <FileCode2 className="h-3 w-3" />
                Open SQL
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <MiniMetric label="time" value={activity.ts ? fmtAgo(activity.ts) : "never"} />
            <MiniMetric label="latency" value={activity.elapsedMs == null ? "0ms" : fmtMs(activity.elapsedMs)} />
            <MiniMetric label="rows" value={activity.rows == null ? "-" : fmtCount(activity.rows)} />
          </div>

          {activity.subject ? (
            <div className="rounded border border-chrome-border/60 bg-foreground/[0.03] px-2 py-1.5">
              <div className="truncate font-mono text-[10px] text-foreground">{activity.subject}</div>
            </div>
          ) : null}

          {activity.objects.length ? (
            <div className="flex flex-wrap gap-1">
              {activity.objects.slice(0, 8).map((obj) => (
                <span key={obj} className="max-w-[220px] truncate rounded border border-chrome-border/60 bg-foreground/[0.03] px-1.5 py-0.5 font-mono text-[9px] text-chrome-text">
                  {obj}
                </span>
              ))}
            </div>
          ) : null}

          {activity.errorCode || activity.errorMessage ? (
            <div className="rounded border border-danger/30 bg-danger/10 px-2 py-1.5">
              <div className="font-mono text-[10px] text-danger">{activity.errorCode ?? "ERROR"}</div>
              {activity.errorMessage ? <div className="mt-1 text-[10px] text-danger/85">{activity.errorMessage}</div> : null}
            </div>
          ) : null}

          {activity.sql ? (
            <CodePreview
              code={activity.sql}
              lang="sql"
              className="max-h-36 rounded border border-chrome-border/60 bg-foreground/[0.035] p-2 text-[10px]"
            />
          ) : (
            <KeyValueBlock title="args" value={activity.args} />
          )}
        </div>
      )}
    </Panel>
  )
}

function PeoplePanel({
  callers,
  activities,
  range,
  selected,
  onSelect,
}: {
  callers: McpIncomingCaller[]
  activities: McpIncomingActivity[]
  range: McpIncomingRange
  selected: string | null
  onSelect: (actor: string) => void
}) {
  return (
    <Panel icon={Users} title="People" className="flex min-h-[160px] flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
        {callers.length === 0 ? (
          <TinyEmpty label="No callers" />
        ) : (
          callers.slice(0, 14).map((caller) => (
            <button
              key={caller.actor}
              type="button"
              onClick={() => onSelect(caller.actor)}
              className={cn(
                "grid w-full grid-cols-[minmax(0,1fr)_110px_54px] items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors",
                selected === caller.actor
                  ? "border-rvbbit-accent/55 bg-rvbbit-accent/10"
                  : "border-chrome-border/55 bg-foreground/[0.025] hover:border-rvbbit-accent/35",
              )}
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] text-foreground">{caller.actor}</div>
                <div className="truncate text-[9px] text-chrome-text/55">{caller.topTool ?? "-"} · {caller.lastSeen ? fmtAgo(caller.lastSeen) : "never"}</div>
              </div>
              <ActivityTicks activities={activities.filter((a) => a.actor === caller.actor)} range={range} count={18} />
              <div className="text-right font-mono text-[10px] tabular-nums text-chrome-text">
                {fmtCount(caller.calls)}
                {caller.errors > 0 ? <span className="ml-1 text-danger">{fmtCount(caller.errors)}</span> : null}
              </div>
            </button>
          ))
        )}
      </div>
    </Panel>
  )
}

function ActivityStream({
  rows,
  selectedId,
  onSelect,
  onOpenSql,
}: {
  rows: McpIncomingActivity[]
  selectedId: number | null
  onSelect: (id: number) => void
  onOpenSql: (activity: McpIncomingActivity) => void
}) {
  if (rows.length === 0) return <TinyEmpty label="No matching activity" />
  return (
    <div className="min-h-0 flex-1 overflow-auto pr-1">
      <div className="grid gap-1.5">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r.id)}
            className={cn(
              "grid w-full grid-cols-[86px_minmax(90px,0.8fr)_minmax(92px,0.75fr)_minmax(120px,1.2fr)_68px_32px] items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors",
              selectedId === r.id
                ? "border-rvbbit-accent/60 bg-rvbbit-accent/10"
                : "border-chrome-border/55 bg-foreground/[0.025] hover:border-rvbbit-accent/35",
            )}
          >
            <div className="truncate font-mono text-[10px] text-chrome-text/65">{r.ts ? fmtAgo(r.ts) : "never"}</div>
            <div className="truncate font-mono text-[10px] text-foreground">{r.actor}</div>
            <div className="truncate font-mono text-[10px] text-rvbbit-accent">{r.tool}</div>
            <div className="truncate text-[10px] text-chrome-text">{r.subject ?? objectSummary(r.objects) ?? "-"}</div>
            <div className={cn("text-right font-mono text-[10px] tabular-nums", r.ok === false ? "text-danger" : "text-chrome-text/70")}>
              {r.elapsedMs == null ? "0ms" : fmtMs(r.elapsedMs)}
            </div>
            <div className="flex items-center justify-end gap-1">
              {r.sql ? (
                <span
                  role="button"
                  tabIndex={0}
                  title="Open SQL"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenSql(r)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      e.stopPropagation()
                      onOpenSql(r)
                    }
                  }}
                  className="grid h-5 w-5 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-rvbbit-accent"
                >
                  <FileCode2 className="h-3 w-3" />
                </span>
              ) : null}
              <span className={cn("h-2 w-2 rounded-full", r.ok === false ? "bg-danger" : "bg-success")} />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function ObjectsPanel({ objects, selected, onSelect }: { objects: McpIncomingObject[]; selected: string | null; onSelect: (object: string) => void }) {
  const max = Math.max(1, ...objects.map((o) => o.touches))
  return (
    <Panel icon={Table2} title="Objects" className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
        {objects.length === 0 ? (
          <TinyEmpty label="No object touches" />
        ) : (
          objects.slice(0, 18).map((obj) => (
            <button
              key={obj.object}
              type="button"
              onClick={() => onSelect(obj.object)}
              className={cn(
                "grid w-full grid-cols-[minmax(0,1fr)_70px] items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors",
                selected === obj.object
                  ? "border-rvbbit-accent/55 bg-rvbbit-accent/10"
                  : "border-chrome-border/55 bg-foreground/[0.025] hover:border-rvbbit-accent/35",
              )}
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] text-foreground">{obj.object}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-foreground/[0.06]">
                  <div className="h-full rounded-sm bg-rvbbit-accent" style={{ width: `${Math.max(3, (obj.touches / max) * 100)}%` }} />
                </div>
              </div>
              <div className="text-right font-mono text-[10px] tabular-nums text-chrome-text">
                {fmtCount(obj.touches)}
                <div className="text-[9px] text-chrome-text/45">{fmtCount(obj.callers)} ppl</div>
              </div>
            </button>
          ))
        )}
      </div>
    </Panel>
  )
}

function ErrorsPanel({ errors, onOpenSql }: { errors: McpIncomingError[]; onOpenSql: (sql: string) => void }) {
  return (
    <Panel icon={AlertTriangle} title="Errors" className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
        {errors.length === 0 ? (
          <TinyEmpty label="No errors" />
        ) : (
          errors.slice(0, 14).map((e) => (
            <div key={`${e.tool}:${e.code}:${e.message}`} className="rounded border border-danger/25 bg-danger/[0.06] px-2 py-1.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[10px] text-danger">{e.code}</div>
                  <div className="truncate text-[10px] text-danger/85">{e.message}</div>
                  <div className="mt-1 truncate font-mono text-[9px] text-chrome-text/55">{e.tool} · {fmtCount(e.calls)} calls · {e.lastSeen ? fmtAgo(e.lastSeen) : "never"}</div>
                </div>
                {e.sampleSql ? (
                  <button
                    type="button"
                    title="Open SQL"
                    onClick={() => onOpenSql(e.sampleSql!)}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-danger hover:bg-danger/10"
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  )
}

function ToolsPanel({ tools, selected, onSelect }: { tools: McpIncomingTool[]; selected: string | null; onSelect: (tool: string) => void }) {
  const max = Math.max(1, ...tools.map((t) => t.calls))
  return (
    <Panel icon={Search} title="Tools">
      <div className="grid gap-1.5 md:grid-cols-2">
        {tools.length === 0 ? (
          <TinyEmpty label="No tools" />
        ) : (
          tools.slice(0, 16).map((tool, i) => (
            <button
              key={tool.tool}
              type="button"
              onClick={() => onSelect(tool.tool)}
              className={cn(
                "rounded border px-2 py-1.5 text-left transition-colors",
                selected === tool.tool
                  ? "border-rvbbit-accent/55 bg-rvbbit-accent/10"
                  : "border-chrome-border/55 bg-foreground/[0.025] hover:border-rvbbit-accent/35",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: TOOL_COLORS[i % TOOL_COLORS.length] }} />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">{tool.tool}</span>
                <span className="font-mono text-[10px] text-chrome-text">{fmtCount(tool.calls)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-foreground/[0.06]">
                <div className="h-full rounded-sm" style={{ width: `${Math.max(3, (tool.calls / max) * 100)}%`, background: TOOL_COLORS[i % TOOL_COLORS.length] }} />
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-chrome-text/55">
                <span>{fmtCount(tool.callers)} ppl</span>
                <span>{tool.errors > 0 ? `${fmtCount(tool.errors)} err` : "ok"}</span>
                <span>{tool.p95Ms == null ? "0ms" : fmtMs(tool.p95Ms)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </Panel>
  )
}

function ResultShapePanel({ activity }: { activity: McpIncomingActivity | null }) {
  return (
    <Panel icon={CheckCircle2} title="Result Shape">
      {!activity ? (
        <TinyEmpty label="No call selected" />
      ) : (
        <div className="grid gap-2 md:grid-cols-[0.9fr_1.1fr]">
          <KeyValueBlock title="summary" value={activity.resultSummary ?? {}} />
          <KeyValueBlock title="args" value={activity.args} />
        </div>
      )}
    </Panel>
  )
}

function ActivityTicks({ activities, range, count }: { activities: McpIncomingActivity[]; range: McpIncomingRange; count: number }) {
  const ticks = useMemo(() => buildTicks(activities, range, count), [activities, count, range])
  return (
    <div className="flex h-4 items-center gap-px">
      {ticks.map((t, i) => (
        <span
          key={i}
          title={t.title}
          className={cn(
            "h-3 flex-1 rounded-[1px]",
            t.calls === 0 ? "bg-foreground/[0.06]" : t.errors > 0 ? "bg-danger" : "bg-success",
          )}
          style={{ opacity: t.calls === 0 ? 1 : Math.min(1, 0.38 + t.calls / Math.max(1, ticks.maxCalls)) }}
        />
      ))}
    </div>
  )
}

function BucketStrip({ buckets }: { buckets: McpIncomingBucket[] }) {
  if (buckets.length === 0) return null
  const max = Math.max(1, ...buckets.map((b) => b.calls))
  return (
    <span className="flex h-3 w-28 items-end gap-px">
      {buckets.slice(-28).map((b, i) => (
        <span
          key={`${b.bucket ?? i}:${i}`}
          title={`${b.bucket ? new Date(b.bucket).toLocaleString() : ""} · ${b.calls} calls · ${b.errors} errors`}
          className={cn("w-1.5 rounded-[1px]", b.errors > 0 ? "bg-danger" : "bg-rvbbit-accent")}
          style={{
            height: `${Math.max(2, (b.calls / max) * 12)}px`,
            opacity: b.calls === 0 ? 0.25 : 0.85,
          }}
        />
      ))}
    </span>
  )
}

function KeyValueBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  const text = stringifyJson(value)
  return (
    <div className="min-w-0 rounded border border-chrome-border/60 bg-foreground/[0.025]">
      <div className="border-b border-chrome-border/45 px-2 py-1 text-[9px] uppercase tracking-wider text-chrome-text/55">{title}</div>
      <CodePreview code={text} lang="json" className="max-h-40 bg-transparent p-2 text-[10px]" />
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded border border-chrome-border/55 bg-foreground/[0.025] px-2 py-1.5">
      <div className="truncate font-mono text-[11px] tabular-nums text-foreground">{value}</div>
      <div className="truncate text-[9px] uppercase tracking-wider text-chrome-text/45">{label}</div>
    </div>
  )
}

function StatusPill({ ok }: { ok: boolean | null }) {
  const failed = ok === false
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px]", failed ? "border-danger/35 bg-danger/10 text-danger" : "border-success/35 bg-success/10 text-success")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", failed ? "bg-danger" : "bg-success")} />
      {failed ? "ERR" : "OK"}
    </span>
  )
}

function Segmented<T extends string>({
  items,
  value,
  onChange,
  title,
}: {
  items: { key: T; label: string }[]
  value: T
  onChange: (value: T) => void
  title: string
}) {
  return (
    <div title={title} className="flex overflow-hidden rounded border border-chrome-border/70 bg-foreground/[0.03]">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={cn(
            "px-2 py-1 font-mono text-[10px] transition-colors",
            value === item.key
              ? "bg-rvbbit-accent/15 text-rvbbit-accent"
              : "text-chrome-text/65 hover:bg-foreground/[0.05] hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
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
    <div className="grid min-h-full place-items-center p-6">
      <div className="max-w-md rounded-md border border-chrome-border bg-secondary-background/50 p-5 text-center">
        <div className={cn("mx-auto grid h-10 w-10 place-items-center rounded border", tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-chrome-border/70 bg-foreground/[0.04] text-rvbbit-accent")}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="mt-3 text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-1 text-[11px] text-chrome-text/65">{detail}</div>
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div className="grid min-h-full place-items-center text-chrome-text/60">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <RefreshCw className="h-4 w-4 animate-spin text-rvbbit-accent" />
        loading MCP activity
      </div>
    </div>
  )
}

function TinyEmpty({ label }: { label: string }) {
  return (
    <div className="grid min-h-[120px] place-items-center rounded border border-dashed border-chrome-border/60 text-[10px] text-chrome-text/45">
      {label}
    </div>
  )
}

interface FlowNode {
  kind: "caller" | "tool" | "object"
  key: string
  label: string
  calls: number
  x: number
  y: number
  w: number
  color: string
  active: boolean
}

interface FlowEdge {
  from: FlowNode
  to: FlowNode
  calls: number
  errors: number
  width: number
  active: boolean
}

function buildFlow(
  activities: McpIncomingActivity[],
  width: number,
  height: number,
  filters: {
    callerFilter: string | null
    toolFilter: string | null
    objectFilter: string | null
    selected: McpIncomingActivity | null
  },
): { nodes: FlowNode[]; edges: FlowEdge[]; axis: { callers: number; tools: number; objects: number } } {
  if (width <= 0 || height <= 0 || activities.length === 0) {
    return { nodes: [], edges: [], axis: { callers: 0, tools: 0, objects: 0 } }
  }
  const nodeW = Math.max(104, Math.min(176, width * 0.22))
  const xCaller = Math.round(width * 0.14)
  const xTool = Math.round(width * 0.5)
  const xObject = Math.round(width * 0.86)
  const callers = ensureValue(topKeys(activities.map((a) => a.actor), 7), filters.callerFilter, 7)
  const tools = ensureValue(topKeys(activities.map((a) => a.tool), 8), filters.toolFilter, 8)
  const allObjects = activities.flatMap((a) => a.objects)
  const objects = ensureValue(topKeys(allObjects, 9), filters.objectFilter, 9)
  const toolColor = new Map(tools.map((t, i) => [t, TOOL_COLORS[i % TOOL_COLORS.length]]))

  const makeNodes = (items: string[], kind: FlowNode["kind"], x: number): FlowNode[] => {
    const ys = spread(items.length, height, 44, 34)
    return items.map((key, i) => {
      const calls = activities.filter((a) => {
        if (kind === "caller") return a.actor === key
        if (kind === "tool") return a.tool === key
        return a.objects.includes(key)
      }).length
      const active =
        (kind === "caller" && (filters.callerFilter === key || filters.selected?.actor === key)) ||
        (kind === "tool" && (filters.toolFilter === key || filters.selected?.tool === key)) ||
        (kind === "object" && (filters.objectFilter === key || !!filters.selected?.objects.includes(key)))
      return {
        kind,
        key,
        label: key,
        calls,
        x,
        y: ys[i],
        w: nodeW,
        color: kind === "tool" ? toolColor.get(key) ?? "var(--rvbbit-accent)" : kind === "object" ? "oklch(74% 0.15 96)" : "oklch(70% 0.14 230)",
        active,
      }
    })
  }

  const nodes = [
    ...makeNodes(callers, "caller", xCaller),
    ...makeNodes(tools, "tool", xTool),
    ...makeNodes(objects, "object", xObject),
  ]
  const byKey = new Map(nodes.map((n) => [`${n.kind}:${n.key}`, n]))
  const edgeCounts = new Map<string, { calls: number; errors: number }>()

  for (const a of activities) {
    if (!callers.includes(a.actor) || !tools.includes(a.tool)) continue
    bumpEdge(edgeCounts, `caller:${a.actor}|tool:${a.tool}`, a.ok === false)
    for (const obj of a.objects) {
      if (objects.includes(obj)) bumpEdge(edgeCounts, `tool:${a.tool}|object:${obj}`, a.ok === false)
    }
  }

  const maxCalls = Math.max(1, ...Array.from(edgeCounts.values()).map((e) => e.calls))
  const edges: FlowEdge[] = []
  for (const [key, value] of edgeCounts) {
    const [left, right] = key.split("|")
    const from = byKey.get(left)
    const to = byKey.get(right)
    if (!from || !to) continue
    const active = from.active || to.active || !filters.callerFilter && !filters.toolFilter && !filters.objectFilter
    edges.push({
      from,
      to,
      calls: value.calls,
      errors: value.errors,
      width: Math.max(1.5, 1.5 + (value.calls / maxCalls) * 8),
      active,
    })
  }

  return { nodes, edges, axis: { callers: xCaller, tools: xTool, objects: xObject } }
}

function bumpEdge(map: Map<string, { calls: number; errors: number }>, key: string, failed: boolean) {
  const cur = map.get(key) ?? { calls: 0, errors: 0 }
  cur.calls += 1
  if (failed) cur.errors += 1
  map.set(key, cur)
}

function curvePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(60, Math.abs(x2 - x1) * 0.45)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

function spread(count: number, height: number, top: number, bottom: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [Math.round(height / 2)]
  const usable = Math.max(1, height - top - bottom)
  return Array.from({ length: count }, (_, i) => Math.round(top + (usable * i) / (count - 1)))
}

function topKeys(values: string[], limit: number): string[] {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => k)
}

function ensureValue(values: string[], value: string | null, limit: number): string[] {
  if (!value || values.includes(value)) return values
  return [value, ...values].slice(0, limit)
}

function buildTicks(activities: McpIncomingActivity[], range: McpIncomingRange, count: number) {
  const now = Date.now()
  const span = rangeMs(range)
  const start = now - span
  const width = span / count
  const buckets = Array.from({ length: count }, (_, i) => ({
    calls: 0,
    errors: 0,
    title: `${new Date(start + i * width).toLocaleString()} - ${new Date(start + (i + 1) * width).toLocaleString()}`,
  }))
  for (const a of activities) {
    if (!a.ts || a.ts < start || a.ts > now) continue
    const idx = Math.min(count - 1, Math.max(0, Math.floor((a.ts - start) / width)))
    buckets[idx].calls += 1
    if (a.ok === false) buckets[idx].errors += 1
  }
  const maxCalls = Math.max(1, ...buckets.map((b) => b.calls))
  return Object.assign(
    buckets.map((b) => ({
      ...b,
      title: `${b.title} · ${b.calls} calls · ${b.errors} errors`,
    })),
    { maxCalls },
  )
}

function rangeMs(range: McpIncomingRange): number {
  switch (range) {
    case "24h": return 24 * 60 * 60 * 1000
    case "7d": return 7 * 24 * 60 * 60 * 1000
    case "30d": return 30 * 24 * 60 * 60 * 1000
  }
}

function statusMatches(activity: McpIncomingActivity, filter: StatusFilter): boolean {
  if (filter === "all") return true
  if (filter === "error") return activity.ok === false
  return activity.ok !== false
}

function objectSummary(objects: string[]): string | null {
  if (objects.length === 0) return null
  if (objects.length === 1) return objects[0]
  return `${objects[0]} +${objects.length - 1}`
}

function stringifyJson(value: Record<string, unknown>): string {
  const text = JSON.stringify(value, null, 2)
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setSize({ width: cr.width, height: cr.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}
