"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Database,
  GitBranch,
  Play,
  RefreshCw,
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
import { fmtAgo, fmtCount, fmtMs, Panel } from "./instruments"
import { cn } from "@/lib/utils"

type Tab = "overview" | "runs" | "assets" | "checks" | "automation" | "events"

interface DagsterWindowProps {
  activeConnectionId: string | null
  workspaceActive: boolean
}

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "runs", label: "Runs" },
  { key: "assets", label: "Assets" },
  { key: "checks", label: "Checks" },
  { key: "automation", label: "Automation" },
  { key: "events", label: "Events" },
]

export function DagsterWindow({ activeConnectionId, workspaceActive }: DagsterWindowProps) {
  const [tab, setTab] = useState<Tab>("overview")
  const [snapshot, setSnapshot] = useState<DagsterSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      setLoading(false)
    }
  }, [activeConnectionId])

  useEffect(() => {
    if (!workspaceActive) return
    queueMicrotask(() => {
      void refresh()
    })
  }, [refresh, workspaceActive])

  const detected = !!snapshot?.detection.detected
  const schemas = snapshot?.detection.schemas.join(", ") || "-"

  return (
    <div className="flex h-full flex-col bg-doc-bg text-foreground group-data-[focused=false]/window:bg-doc-bg/70">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/35 px-2">
        <div className="grid h-6 w-6 place-items-center rounded border border-chrome-border/60 bg-foreground/[0.04]">
          <GitBranch className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold leading-tight text-foreground">Dagster</div>
          <div className="truncate font-mono text-[9px] text-chrome-text/55">
            {detected ? `schemas: ${schemas}` : loading ? "scanning storage tables" : "not detected"}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {snapshot ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[9px]",
                detected
                  ? "border-success/35 bg-success/10 text-success"
                  : "border-chrome-border bg-foreground/[0.03] text-chrome-text/60",
              )}
            >
              {snapshot.detection.confidence}%
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || !activeConnectionId}
            title="Refresh"
            className="grid h-7 w-7 place-items-center rounded text-chrome-text transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-45"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-chrome-border bg-chrome-bg/20 px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-2 py-1 text-[11px] transition-colors",
              tab === t.key
                ? "bg-foreground/[0.10] text-foreground"
                : "text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
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
        ) : tab === "overview" ? (
          <Overview snapshot={snapshot} />
        ) : tab === "runs" ? (
          <RunsTable rows={snapshot.runs} />
        ) : tab === "assets" ? (
          <AssetsTable rows={snapshot.assets} />
        ) : tab === "checks" ? (
          <ChecksTable rows={snapshot.checks} />
        ) : tab === "automation" ? (
          <AutomationTable rows={snapshot.automations} />
        ) : (
          <EventsTable rows={snapshot.events} />
        )}
      </div>
    </div>
  )
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
    <div ref={ref} className="min-h-[300px] flex-1 overflow-hidden rounded border border-chrome-border/50 bg-[#0b0c0f]">
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

function AutomationTable({ rows }: { rows: DagsterAutomationRow[] }) {
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
          <TickStrip key="ticks" ticks={a.ticks} />,
          a.updatedAt ? fmtAgo(a.updatedAt) : "-",
          a.lastTickAt ? fmtAgo(a.lastTickAt) : "-",
        ])}
      />
    </Panel>
  )
}

function TickStrip({ ticks }: { ticks: DagsterAutomationTick[] }) {
  if (ticks.length === 0) return <span className="text-chrome-text/35">no ticks</span>
  return (
    <div className="flex max-w-[280px] items-center gap-[3px]">
      {ticks.map((tick, i) => (
        <span
          key={`${tick.id ?? "tick"}:${i}`}
          title={tickTitle(tick)}
          className={cn("h-2 w-2 shrink-0 rounded-[2px] border", tickSquareClass(tick.status))}
        />
      ))}
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

function tickTitle(tick: DagsterAutomationTick): string {
  const lines = [`status: ${tick.status}`]
  if (tick.type) lines.push(`type: ${tick.type}`)
  if (tick.timestamp) lines.push(`time: ${fmtAgo(tick.timestamp)} (${new Date(tick.timestamp).toLocaleString()})`)
  if (tick.updatedAt) lines.push(`updated: ${fmtAgo(tick.updatedAt)}`)
  if (tick.id) lines.push(`tick: ${tick.id}`)
  return lines.join("\n")
}

function tickSquareClass(status: string): string {
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
  if (s.includes("SUCCESS") || s === "STARTED" || s === "RUNNING") return "border-success/35 bg-success/10 text-success"
  if (s.includes("QUEU") || s.includes("START") || s.includes("PLANNED")) return "border-rvbbit-accent/35 bg-rvbbit-accent/10 text-rvbbit-accent"
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
