"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Boxes,
  CaretRight,
  Cpu,
  FlowArrow,
  Pause,
  Play,
  RefreshCw,
  X,
} from "@/lib/icons"
import { usePolling } from "@/lib/desktop/use-polling"
import { cn } from "@/lib/utils"
import {
  fetchDuckCapability,
  fetchDuckEventDetail,
  fetchDuckEventsSince,
  fetchDuckFallbacks,
  fetchDuckHeader,
  fetchDuckInstances,
  fmtBytes,
  instanceSeverity,
  instanceStatusText,
  type DuckCapability,
  type DuckEvent,
  type DuckEventDetail,
  type DuckFallback,
  type DuckHeader,
  type DuckInstance,
  type DuckSeverity,
} from "@/lib/rvbbit/duck"
import {
  fmtAgo,
  fmtClock,
  fmtCount,
  fmtMs,
  Panel,
  percentile,
  ScatterStrip,
  type ScatterPoint,
} from "./instruments"

interface DuckWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  workspaceActive?: boolean
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
]

const EVENT_BUFFER = 500
type TabKey = "overview" | "instances" | "stream" | "fallbacks"
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "instances", label: "Instances" },
  { key: "stream", label: "Stream" },
  { key: "fallbacks", label: "Fallbacks" },
]

// ── shared color language ───────────────────────────────────────────

function statusColor(status: string): string {
  if (status === "ok") return "var(--success)"
  if (status === "fallback") return "var(--warning)"
  return "var(--danger)"
}
const MODE_COLOR: Record<string, string> = {
  shared_broker: "var(--viz-op-runtime)",
  local_persistent: "var(--viz-engine-duck-vector)",
  local_oneshot: "var(--viz-engine-duck-vortex)",
}
const DIM_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-4)",
  "var(--viz-series-5)",
  "var(--viz-op-runtime)",
  "var(--main)",
]
function dimColor(i: number): string {
  return DIM_COLORS[i % DIM_COLORS.length]
}
const SEV_DOT: Record<DuckSeverity, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-danger",
  muted: "bg-chrome-text/40",
}

export function DuckWindow({ activeConnectionId, hasRvbbit, workspaceActive = true }: DuckWindowProps) {
  const [cap, setCap] = useState<DuckCapability | null>(null)
  const [header, setHeader] = useState<DuckHeader | null>(null)
  const [instances, setInstances] = useState<DuckInstance[]>([])
  const [events, setEvents] = useState<DuckEvent[]>([])
  const [fallbacks, setFallbacks] = useState<DuckFallback[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>("overview")
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(2000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null)
  const cursorRef = useRef(0)
  const loading = updatedAt === 0 && cap == null

  // Capability probe once per connection.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    void (async () => {
      const c = await fetchDuckCapability(activeConnectionId)
      if (!cancelled) setCap(c)
    })()
    return () => { cancelled = true }
  }, [activeConnectionId, hasRvbbit])

  const poll = useCallback(async () => {
    if (!activeConnectionId || !cap?.available) return
    const [h, inst, ev, fb] = await Promise.all([
      fetchDuckHeader(activeConnectionId, cap.hasFallbackEvents),
      fetchDuckInstances(activeConnectionId),
      cap.hasQueryEvents ? fetchDuckEventsSince(activeConnectionId, cursorRef.current) : Promise.resolve({ events: [] as DuckEvent[] }),
      cap.hasFallbackEvents ? fetchDuckFallbacks(activeConnectionId) : Promise.resolve({ fallbacks: [] as DuckFallback[] }),
    ])
    setHeader(h.header)
    setInstances(inst.instances)
    if (ev.events.length > 0) {
      cursorRef.current = Math.max(cursorRef.current, ...ev.events.map((e) => e.id))
      setEvents((prev) => {
        const merged = [...prev, ...ev.events]
        return merged.length > EVENT_BUFFER ? merged.slice(merged.length - EVENT_BUFFER) : merged
      })
    }
    setFallbacks(fb.fallbacks)
    setError(h.error ?? inst.error ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, cap])

  usePolling(poll, intervalMs, {
    enabled: !!activeConnectionId && !!cap?.available && !paused && workspaceActive,
    resetKey: activeConnectionId,
  })

  if (!hasRvbbit) {
    return <Centered icon={Boxes}>This connection has no <span className="font-mono">pg_rvbbit</span> extension.</Centered>
  }
  if (cap && !cap.available) {
    return (
      <Centered icon={Boxes}>
        Duck sidecar telemetry requires <span className="font-mono">pg_rvbbit 0.60.5</span> or newer.
        {cap.version ? <div className="mt-1 text-[10px] text-chrome-text/45">this connection: {cap.version}</div> : null}
      </Centered>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      <HeaderBar
        cap={cap}
        paused={paused}
        intervalMs={intervalMs}
        updatedAt={updatedAt}
        error={error}
        onTogglePause={() => setPaused((p) => !p)}
        onIntervalChange={setIntervalMs}
        onReload={() => void poll()}
      />
      {header ? <HeaderCards header={header} /> : null}

      <div className="flex items-center gap-0.5 border-b border-chrome-border bg-chrome-bg/30 px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "border-b-2 px-2.5 py-1.5 text-[11px] transition-colors",
              tab === t.key
                ? "border-brand-duck text-foreground"
                : "border-transparent text-chrome-text/60 hover:text-foreground",
            )}
          >
            {t.label}
            {t.key === "fallbacks" && header && header.fallbacksLastHour > 0 ? (
              <span className="ml-1 rounded-full bg-warning/20 px-1 text-[9px] text-warning">{header.fallbacksLastHour}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <Centered icon={Activity}>connecting to sidecar telemetry…</Centered>
        ) : tab === "overview" ? (
          <OverviewTab events={events} hasEvents={!!cap?.hasQueryEvents} />
        ) : tab === "instances" ? (
          <InstancesTab instances={instances} />
        ) : tab === "stream" ? (
          <StreamTab
            events={events}
            hasEvents={!!cap?.hasQueryEvents}
            activeConnectionId={activeConnectionId}
            selectedEvent={selectedEvent}
            onSelect={setSelectedEvent}
          />
        ) : (
          <FallbacksTab fallbacks={fallbacks} hasFallback={!!cap?.hasFallbackEvents} />
        )}
      </div>
    </div>
  )
}

// ── header ──────────────────────────────────────────────────────────

function HeaderBar({
  cap,
  paused,
  intervalMs,
  updatedAt,
  error,
  onTogglePause,
  onIntervalChange,
  onReload,
}: {
  cap: DuckCapability | null
  paused: boolean
  intervalMs: number
  updatedAt: number
  error: string | null
  onTogglePause: () => void
  onIntervalChange: (ms: number) => void
  onReload: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
          paused ? "bg-foreground/[0.05] text-chrome-text" : "bg-success/10 text-success",
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", paused ? "bg-chrome-text" : "animate-pulse bg-success")} />
        {paused ? "paused" : "live"}
      </span>
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <Boxes className="h-3.5 w-3.5 text-brand-duck" />
        Duck sidecars
      </span>
      {cap?.version ? <span className="text-[10px] text-chrome-text/45">pg_rvbbit {cap.version}</span> : null}
      <div className="ml-auto flex items-center gap-1.5">
        {error ? (
          <span className="max-w-[280px] truncate rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10px] text-danger" title={error}>
            {error}
          </span>
        ) : null}
        {updatedAt > 0 ? <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span> : null}
        <select
          value={intervalMs}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
          title="Refresh interval"
          className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          {REFRESH_OPTIONS_MS.map((o) => <option key={o.ms} value={o.ms}>{o.label}</option>)}
        </select>
        <button type="button" onClick={onTogglePause} title={paused ? "Resume" : "Pause"} className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground">
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </button>
        <button type="button" onClick={onReload} title="Reload" className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function HeaderCards({ header }: { header: DuckHeader }) {
  const cards: { label: string; value: string; tone?: "ok" | "warn" | "error" | "muted"; hint?: string }[] = [
    { label: "online", value: `${header.online}`, tone: header.online > 0 ? "ok" : "muted", hint: `${header.instances} instances` },
    { label: "shared brokers", value: `${header.sharedBrokers}` },
    { label: "local sidecars", value: `${header.localSidecars}` },
    { label: "queue depth", value: fmtCount(header.queueDepth), tone: header.queueDepth > 0 ? "warn" : undefined },
    { label: "active workers", value: fmtCount(header.activeWorkers) },
    { label: "total RSS", value: fmtBytes(header.rssBytes) },
    { label: "telemetry drops", value: fmtCount(header.telemetryDrops), tone: header.telemetryDrops > 0 ? "warn" : "ok" },
    { label: "fallbacks / 1h", value: fmtCount(header.fallbacksLastHour), tone: header.fallbacksLastHour > 0 ? "error" : "ok" },
  ]
  const toneColor = (t?: string) =>
    t === "ok" ? "text-success" : t === "warn" ? "text-warning" : t === "error" ? "text-danger" : "text-foreground"
  return (
    <div className="grid grid-cols-4 gap-px border-b border-chrome-border bg-chrome-border/40 sm:grid-cols-8">
      {cards.map((c) => (
        <div key={c.label} className="bg-doc-bg px-2.5 py-1.5" title={c.hint}>
          <div className={cn("font-mono text-[16px] leading-none tabular-nums", toneColor(c.tone))}>{c.value}</div>
          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-chrome-text/50">{c.label}</div>
        </div>
      ))}
    </div>
  )
}

// ── overview ────────────────────────────────────────────────────────

function OverviewTab({ events, hasEvents }: { events: DuckEvent[]; hasEvents: boolean }) {
  // Derive everything from the recent event window (last ~5 min slice of buffer).
  const recent = useMemo(() => {
    if (events.length === 0) return [] as DuckEvent[]
    const newest = events.reduce((max, e) => Math.max(max, e.observedAt ?? 0), 0)
    const cutoff = newest - 5 * 60_000
    const windowed = events.filter((e) => (e.observedAt ?? 0) >= cutoff)
    return windowed.length > 0 ? windowed : events.slice(-200)
  }, [events])

  if (!hasEvents) {
    return <Centered icon={Activity}>No Duck sidecar queries recorded in this window.</Centered>
  }
  if (recent.length === 0) {
    return <Centered icon={Activity}>No Duck sidecar queries recorded in this window.</Centered>
  }

  const latencies = recent.map((e) => e.elapsedMs).filter((v) => v > 0).sort((a, b) => a - b)
  const p50 = percentile(latencies, 0.5)
  const p95 = percentile(latencies, 0.95)
  const points: ScatterPoint[] = recent.map((e, i) => ({
    x: e.observedAt ?? i,
    y: e.elapsedMs,
    error: e.status !== "ok",
    label: `${fmtMs(e.elapsedMs)} · ${e.mode}/${e.layout} · ${e.status}`,
  }))

  return (
    <div className="space-y-2.5 p-2.5">
      <Panel icon={FlowArrow} title="Execution path mix" right={<span>last {recent.length} queries · 5m</span>}>
        <p className="mb-2 text-[10px] leading-snug text-chrome-text/55">
          How recent queries flowed through the sidecar — which mode served them, which engine ran them, and which
          accelerator layout they hit. A growing <span className="text-warning">fallback</span> or{" "}
          <span className="text-danger">error</span> share is the first thing to watch.
        </p>
        <div className="space-y-2">
          <DimRow label="Status" events={recent} pick={(e) => e.status} colorFor={statusColor} />
          <Flow />
          <DimRow label="Mode" events={recent} pick={(e) => e.mode} colorFor={(v, i) => MODE_COLOR[v] ?? dimColor(i)} />
          <Flow />
          <DimRow label="Engine" events={recent} pick={(e) => e.engine || "?"} colorFor={(_, i) => dimColor(i)} />
          <Flow />
          <DimRow label="Layout" events={recent} pick={(e) => e.layout || "?"} colorFor={(_, i) => dimColor(i + 2)} />
        </div>
      </Panel>

      <Panel icon={Activity} title="Live activity" right={<span>newest →</span>}>
        <p className="mb-2 text-[10px] text-chrome-text/55">
          One tick per query, oldest left. Height ∝ latency, colored by status.
        </p>
        <ActivityStrip events={recent} />
      </Panel>

      <Panel
        icon={Cpu}
        title="Latency across time"
        right={
          <span className="flex items-center gap-2 font-mono">
            <span>p50 {fmtMs(p50)}</span>
            <span className="text-warning">p95 {fmtMs(p95)}</span>
          </span>
        }
      >
        <ScatterStrip
          points={points}
          height={150}
          refLines={[
            { y: p50, label: "p50" },
            { y: p95, label: "p95", color: "var(--warning)" },
          ]}
        />
      </Panel>
    </div>
  )
}

/** One stacked composition row for a single dimension (mode/engine/layout/status). */
function DimRow({
  label,
  events,
  pick,
  colorFor,
}: {
  label: string
  events: DuckEvent[]
  pick: (e: DuckEvent) => string
  colorFor: (value: string, index: number) => string
}) {
  const counts = new Map<string, number>()
  for (const e of events) {
    const k = pick(e) || "?"
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const total = events.length || 1
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const segments = entries.map(([k], i) => ({ label: k, value: counts.get(k) ?? 0, color: colorFor(k, i) }))
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-right text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</span>
      <div className="min-w-0 flex-1">
        <div className="flex h-3.5 w-full overflow-hidden rounded-sm bg-foreground/[0.05]">
          {segments.map((s) =>
            s.value > 0 ? (
              <div key={s.label} title={`${s.label} · ${s.value} (${Math.round((s.value / total) * 100)}%)`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
            ) : null,
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
          {entries.map(([k, v], i) => (
            <span key={k} className="inline-flex items-center gap-1 text-[9px] text-chrome-text/70">
              <span className="h-1.5 w-1.5 rounded-sm" style={{ background: colorFor(k, i) }} />
              <span className="font-mono">{k}</span>
              <span className="tabular-nums text-chrome-text/45">{v}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function Flow() {
  return (
    <div className="flex justify-center text-chrome-text/25">
      <CaretRight className="h-3 w-3 rotate-90" />
    </div>
  )
}

/** Per-event ticks: x = order (oldest left), height ∝ log(latency), color = status. */
function ActivityStrip({ events }: { events: DuckEvent[] }) {
  const slice = events.slice(-160)
  const maxMs = Math.max(1, ...slice.map((e) => e.elapsedMs))
  const logMax = Math.log10(maxMs + 1)
  return (
    <div className="flex h-12 items-end gap-px overflow-hidden">
      {slice.length === 0 ? (
        <div className="grid h-full w-full place-items-center text-[10px] text-chrome-text/40">no activity</div>
      ) : (
        slice.map((e) => {
          const h = Math.max(8, Math.round((Math.log10(e.elapsedMs + 1) / logMax) * 100))
          return (
            <div
              key={e.id}
              className="min-w-[2px] flex-1 rounded-t-[1px]"
              style={{ height: `${h}%`, background: statusColor(e.status) }}
              title={`${fmtClock(e.observedAt ?? 0)} · ${fmtMs(e.elapsedMs)} · ${e.mode}/${e.layout} · ${e.status}`}
            />
          )
        })
      )}
    </div>
  )
}

// ── instances ───────────────────────────────────────────────────────

function InstancesTab({ instances }: { instances: DuckInstance[] }) {
  if (instances.length === 0) {
    return <Centered icon={Boxes}>No Duck sidecar activity observed yet.</Centered>
  }
  return (
    <div className="p-2.5">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[9px] uppercase tracking-wider text-chrome-text/50">
            <th className="px-2 py-1 font-normal">status</th>
            <th className="px-2 py-1 font-normal">node</th>
            <th className="px-2 py-1 font-normal">mode</th>
            <th className="px-2 py-1 font-normal">engine / layout</th>
            <th className="px-2 py-1 text-right font-normal">pid</th>
            <th className="px-2 py-1 text-right font-normal">workers / thr</th>
            <th className="px-2 py-1 text-right font-normal">queue / active</th>
            <th className="px-2 py-1 text-right font-normal">RSS</th>
            <th className="px-2 py-1 text-right font-normal">heartbeat</th>
            <th className="px-2 py-1 text-right font-normal">drops</th>
          </tr>
        </thead>
        <tbody>
          {instances.map((i) => {
            const sev = instanceSeverity(i)
            return (
              <tr key={i.instanceId} className="border-t border-chrome-border/30 hover:bg-foreground/[0.03]">
                <td className="px-2 py-1">
                  <span className="inline-flex items-center gap-1.5" title={instanceStatusText(i)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", SEV_DOT[sev])} />
                    <span className={cn(sev === "error" && "text-danger", sev === "warn" && "text-warning")}>{i.status}</span>
                  </span>
                </td>
                <td className="px-2 py-1">
                  <span className="font-mono text-foreground">{i.nodeId}</span>
                  {i.hostname && i.hostname !== i.nodeId ? (
                    <span className="ml-1 text-[9px] text-chrome-text/40">{i.hostname}</span>
                  ) : null}
                </td>
                <td className="px-2 py-1">
                  <span className="rounded px-1 text-[10px]" style={{ background: "color-mix(in oklch, " + (MODE_COLOR[i.mode] ?? "var(--chrome-border)") + " 18%, transparent)", color: MODE_COLOR[i.mode] ?? "var(--chrome-text)" }}>
                    {i.mode}
                  </span>
                </td>
                <td className="px-2 py-1 font-mono text-chrome-text/75">{i.engine}{i.layout ? ` · ${i.layout}` : ""}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/55">{i.pid ?? "—"}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/75">{i.workerCount} / {i.duckThreads}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  <span className={cn(i.queueDepth > 0 && "text-warning")}>{i.queueDepth}</span>
                  <span className="text-chrome-text/40"> / {i.activeWorkers}</span>
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/75">{fmtBytes(i.rssBytes)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-chrome-text/60" title={i.lastHeartbeatAt ? new Date(i.lastHeartbeatAt).toISOString() : ""}>
                  {i.lastHeartbeatAt ? fmtAgo(i.lastHeartbeatAt) : "—"}
                </td>
                <td className={cn("px-2 py-1 text-right font-mono tabular-nums", i.eventsDropped > 0 ? "text-warning" : "text-chrome-text/40")}>{i.eventsDropped}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── stream ──────────────────────────────────────────────────────────

function StreamTab({
  events,
  hasEvents,
  activeConnectionId,
  selectedEvent,
  onSelect,
}: {
  events: DuckEvent[]
  hasEvents: boolean
  activeConnectionId: string | null
  selectedEvent: number | null
  onSelect: (id: number | null) => void
}) {
  if (!hasEvents) {
    return <Centered icon={Activity}>No Duck sidecar queries recorded in this window.</Centered>
  }
  // newest first
  const rows = [...events].reverse()
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 bg-doc-bg">
            <tr className="text-left text-[9px] uppercase tracking-wider text-chrome-text/50">
              <th className="px-2 py-1 font-normal">time</th>
              <th className="px-2 py-1 font-normal">status</th>
              <th className="px-2 py-1 font-normal">node</th>
              <th className="px-2 py-1 font-normal">mode / layout</th>
              <th className="px-2 py-1 font-normal">query</th>
              <th className="px-2 py-1 text-right font-normal">elapsed</th>
              <th className="px-2 py-1 text-right font-normal">queue</th>
              <th className="px-2 py-1 text-right font-normal">rows</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="px-2 py-6 text-center text-[11px] text-chrome-text/45">waiting for queries…</td></tr>
            ) : rows.map((e) => (
              <tr
                key={e.id}
                onClick={() => onSelect(e.id === selectedEvent ? null : e.id)}
                className={cn(
                  "cursor-pointer border-t border-chrome-border/30 hover:bg-foreground/[0.04]",
                  e.id === selectedEvent && "bg-brand-duck/10",
                )}
              >
                <td className="px-2 py-1 font-mono tabular-nums text-chrome-text/60">{fmtClock(e.observedAt ?? 0)}</td>
                <td className="px-2 py-1">
                  <span className="inline-flex items-center gap-1" style={{ color: statusColor(e.status) }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(e.status) }} />
                    {e.status}
                  </span>
                </td>
                <td className="px-2 py-1 font-mono text-chrome-text/70">{e.nodeId}</td>
                <td className="px-2 py-1 text-chrome-text/65">{e.mode}{e.layout ? ` · ${e.layout}` : ""}</td>
                <td className="px-2 py-1 font-mono text-chrome-text/55">{e.queryHash.slice(0, 10) || "—"}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">{fmtMs(e.elapsedMs)}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/55">{e.queueWaitMs > 0 ? fmtMs(e.queueWaitMs) : "—"}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/65">{fmtCount(e.rowCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedEvent != null ? (
        <EventDrawer id={selectedEvent} activeConnectionId={activeConnectionId} onClose={() => onSelect(null)} />
      ) : null}
    </div>
  )
}

function EventDrawer({ id, activeConnectionId, onClose }: { id: number; activeConnectionId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<DuckEventDetail | null>(null)
  const [related, setRelated] = useState<DuckEvent[]>([])
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    void (async () => {
      const r = await fetchDuckEventDetail(activeConnectionId, id)
      if (cancelled) return
      setDetail(r.detail)
      setRelated(r.related)
    })()
    return () => { cancelled = true }
  }, [id, activeConnectionId])
  return (
    <div className="flex w-[320px] shrink-0 flex-col border-l border-chrome-border bg-secondary-background/40">
      <div className="flex items-center gap-1.5 border-b border-chrome-border px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/60">event #{id}</span>
        {detail?.status ? <span className="text-[10px]" style={{ color: statusColor(detail.status) }}>{detail.status}</span> : null}
        <button type="button" onClick={onClose} className="ml-auto grid h-5 w-5 place-items-center rounded text-chrome-text/60 hover:bg-foreground/10 hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2 text-[10px]">
        {detail ? (
          <>
            <KV k="query_hash" v={detail.queryHash || "—"} />
            <KV k="observed" v={detail.observedAt ? new Date(detail.observedAt).toISOString() : "—"} />
            {detail.error ? <div className="rounded bg-danger/10 p-1.5 text-danger">{detail.error}</div> : null}
            <Json label="cache" value={detail.cache} />
            <Json label="tables" value={detail.tables} />
            <Json label="metadata" value={detail.metadata} />
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">related · same hash ({related.length})</div>
              <div className="space-y-0.5">
                {related.map((r) => (
                  <div key={r.id} className="flex items-center gap-1.5 font-mono tabular-nums text-chrome-text/60">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(r.status) }} />
                    <span>{fmtClock(r.observedAt ?? 0)}</span>
                    <span className="ml-auto text-foreground">{fmtMs(r.elapsedMs)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="text-chrome-text/45">loading…</div>
        )}
      </div>
    </div>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value == null || (typeof value === "object" && Object.keys(value as object).length === 0)) return null
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">{label}</div>
      <pre className="overflow-auto rounded bg-doc-bg/60 p-1.5 font-mono text-[9px] text-chrome-text/80">{JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-chrome-text/50">{k}</span>
      <span className="min-w-0 break-all font-mono text-foreground">{v}</span>
    </div>
  )
}

// ── fallbacks ───────────────────────────────────────────────────────

function FallbacksTab({ fallbacks, hasFallback }: { fallbacks: DuckFallback[]; hasFallback: boolean }) {
  if (!hasFallback) {
    return <Centered icon={AlertTriangle}>Shared broker fallback telemetry isn&apos;t available on this extension.</Centered>
  }
  if (fallbacks.length === 0) {
    return <Centered icon={AlertTriangle}>No shared broker fallback events in this window.</Centered>
  }
  // repeated fallback for the same socket = likely-down broker (error severity).
  const bySocket = new Map<string, number>()
  for (const f of fallbacks) bySocket.set(f.socketPath ?? "?", (bySocket.get(f.socketPath ?? "?") ?? 0) + 1)
  return (
    <div className="space-y-2.5 p-2.5">
      <Panel icon={AlertTriangle} title="Shared broker fallbacks" right={<span>last 24h · {fallbacks.length}</span>}>
        <p className="mb-2 text-[10px] leading-snug text-chrome-text/55">
          Recorded when shared-broker mode was enabled but the socket failed and execution fell back to a local
          sidecar. Repeated failures for one socket usually mean that broker is down or misconfigured.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {[...bySocket.entries()].sort((a, b) => b[1] - a[1]).map(([sock, n]) => (
            <span key={sock} className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px]", n >= 3 ? "border-danger/40 bg-danger/10 text-danger" : "border-warning/40 bg-warning/10 text-warning")}>
              <span className="font-mono">{sock}</span>
              <span className="tabular-nums opacity-70">{n}</span>
            </span>
          ))}
        </div>
      </Panel>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[9px] uppercase tracking-wider text-chrome-text/50">
            <th className="px-2 py-1 font-normal">time</th>
            <th className="px-2 py-1 font-normal">node</th>
            <th className="px-2 py-1 font-normal">engine / layout</th>
            <th className="px-2 py-1 font-normal">socket</th>
            <th className="px-2 py-1 font-normal">fell back to</th>
            <th className="px-2 py-1 font-normal">reason</th>
          </tr>
        </thead>
        <tbody>
          {fallbacks.map((f, i) => (
            <tr key={i} className="border-t border-chrome-border/30 hover:bg-foreground/[0.03]">
              <td className="px-2 py-1 font-mono tabular-nums text-chrome-text/60" title={f.observedAt ? new Date(f.observedAt).toISOString() : ""}>{fmtAgo(f.observedAt ?? 0)}</td>
              <td className="px-2 py-1 font-mono text-chrome-text/70">{f.nodeId}</td>
              <td className="px-2 py-1 font-mono text-chrome-text/65">{f.engine}{f.layout ? ` · ${f.layout}` : ""}</td>
              <td className="px-2 py-1 font-mono text-chrome-text/55">{f.socketPath ?? "—"}</td>
              <td className="px-2 py-1 text-chrome-text/65">{f.fallbackMode ?? "—"}</td>
              <td className="max-w-[280px] truncate px-2 py-1 text-danger/80" title={f.reason}>{f.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── shared empty/centered ───────────────────────────────────────────

function Centered({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
      <div>
        <Icon className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
        {children}
      </div>
    </div>
  )
}
