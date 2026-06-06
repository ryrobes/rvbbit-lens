"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, AlertTriangle, Boxes, Brain, FileCode2, Pause, Play, RefreshCw } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fetchSpecialists, type RvbbitSpecialist } from "@/lib/rvbbit/operators"
import {
  fetchSpecialistCalls,
  fetchSpecialistHealth,
  type SpecialistCall,
  type SpecialistHealth,
} from "@/lib/rvbbit/specialists"
import { fetchInstalledRuntimes, type InstalledRuntime } from "@/lib/rvbbit/capabilities"
import { Sparkline } from "./sparkline"
import {
  bucketCounts,
  CompositionBar,
  fmtAgo,
  fmtCount,
  fmtMs,
  Histogram,
  loadColor,
  Panel,
  percentile,
  Readout,
  SERIES_COLORS,
} from "./instruments"

interface SpecialistsWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSpecialist: (name: string) => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

interface Rollup {
  name: string
  spec: RvbbitSpecialist | null
  health: SpecialistHealth | null
  calls: SpecialistCall[]
  count: number
  errors: number
  latencies: number[]
  p50: number
  p95: number
  lastAt: number
  operators: number
}

function buildRollup(
  name: string,
  spec: RvbbitSpecialist | null,
  health: SpecialistHealth | null,
  calls: SpecialistCall[],
): Rollup {
  const latencies = calls
    .filter((c) => !c.error)
    .map((c) => c.latencyMs)
    .sort((a, b) => a - b)
  const ops = new Set(calls.map((c) => c.operator))
  return {
    name,
    spec,
    health,
    calls,
    count: calls.length,
    errors: calls.filter((c) => c.error).length,
    latencies,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    lastAt: calls.length > 0 ? calls[calls.length - 1].at : 0,
    operators: ops.size,
  }
}

/**
 * Specialist fleet overview — registered model backends, monitored
 * live off the receipt log. Each card is a small-multiple instrument
 * so the eye compares traffic shape across backends at a glance.
 */
export function SpecialistsWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenSpecialist,
}: SpecialistsWindowProps) {
  const [specs, setSpecs] = useState<RvbbitSpecialist[]>([])
  const [runtimes, setRuntimes] = useState<InstalledRuntime[]>([])
  const [calls, setCalls] = useState<SpecialistCall[]>([])
  const [health, setHealth] = useState<Map<string, SpecialistHealth>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  /** First poll not yet returned — derived so it isn't set inside an effect. */
  const loading = updatedAt === 0

  const loadStatic = useCallback(async () => {
    if (!activeConnectionId) return
    const [s, h, rt] = await Promise.all([
      fetchSpecialists(activeConnectionId),
      fetchSpecialistHealth(activeConnectionId),
      fetchInstalledRuntimes(activeConnectionId),
    ])
    setSpecs(s.specialists)
    setHealth(new Map(h.health.map((x) => [x.specialist, x])))
    setRuntimes(rt.runtimes)
  }, [activeConnectionId])

  const pollCalls = useCallback(async () => {
    if (!activeConnectionId) return
    const res = await fetchSpecialistCalls(activeConnectionId)
    setError(res.error ?? null)
    setCalls(res.calls)
    setUpdatedAt(Date.now())
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await loadStatic()
      await pollCalls()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, loadStatic, pollCalls])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void pollCalls(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, pollCalls])

  const model = (s: RvbbitSpecialist): string =>
    health.get(s.name)?.reported_model ??
    (typeof s.transport_opts?.model === "string" ? s.transport_opts.model : "")

  // ── derive ──
  const { rollups, ghosts, gMin, gMax, colorOf } = useMemo(() => {
    const byName = new Map<string, SpecialistCall[]>()
    for (const c of calls) {
      const arr = byName.get(c.specialist)
      if (arr) arr.push(c)
      else byName.set(c.specialist, [c])
    }
    const registered = new Set(specs.map((s) => s.name))

    const rollups = specs
      .map((s) =>
        buildRollup(s.name, s, health.get(s.name) ?? null, byName.get(s.name) ?? []),
      )
      .sort((a, b) => b.count - a.count)

    const ghosts = [...byName.keys()]
      .filter((n) => !registered.has(n))
      .map((n) => buildRollup(n, null, health.get(n) ?? null, byName.get(n) ?? []))
      .sort((a, b) => b.count - a.count)

    let gMin = Infinity
    let gMax = -Infinity
    for (const c of calls) {
      if (c.at < gMin) gMin = c.at
      if (c.at > gMax) gMax = c.at
    }
    if (!Number.isFinite(gMin)) {
      gMin = 0
      gMax = 1
    }

    // stable color per backend, busiest first
    const colorOf = new Map<string, string>()
    rollups.forEach((r, i) => colorOf.set(r.name, SERIES_COLORS[i % SERIES_COLORS.length]))

    return { rollups, ghosts, gMin, gMax, colorOf }
  }, [calls, specs, health])

  const totalCalls = calls.length
  const totalErrors = calls.filter((c) => c.error).length
  const reachable = specs.filter((s) => health.get(s.name)?.reachable).length
  const busiest = rollups[0]?.count > 0 ? rollups[0] : null

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Brain className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
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
          <Brain className="h-3.5 w-3.5 text-rvbbit-accent" />
          {loading ? "loading…" : `${specs.length} backends`}
        </span>
        {!loading && runtimes.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <FileCode2 className="h-3.5 w-3.5 text-brand-capability" />
            {runtimes.length} runtime{runtimes.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {!loading ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium text-success">{reachable}</span> reachable
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium tabular-nums text-foreground">
                {fmtCount(totalCalls)}
              </span>{" "}
              calls tracked
            </span>
            {totalErrors > 0 ? (
              <>
                <span className="text-chrome-text/40">·</span>
                <span className="text-danger">{totalErrors} errors</span>
              </>
            ) : null}
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            title="Refresh interval"
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
              void loadStatic()
              void pollCalls()
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

      <div className="flex-1 space-y-2.5 overflow-auto p-2.5">
        <FleetPanel
          totalCalls={totalCalls}
          calls={calls}
          gMin={gMin}
          gMax={gMax}
          rollups={rollups}
          colorOf={colorOf}
          busiest={busiest?.name ?? null}
        />

        <div className="grid grid-cols-2 gap-2.5">
          {rollups.map((r) => (
            <SpecialistCard
              key={r.name}
              roll={r}
              gMin={gMin}
              gMax={gMax}
              modelName={r.spec ? model(r.spec) : ""}
              onOpen={() => onOpenSpecialist(r.name)}
            />
          ))}
        </div>

        {rollups.length === 0 && runtimes.length === 0 && !loading ? (
          <div className="grid h-24 place-items-center text-[11px] text-chrome-text/55">
            No specialist backends or runtimes registered.
          </div>
        ) : null}

        {runtimes.length > 0 ? <RuntimesPanel runtimes={runtimes} onOpen={onOpenSpecialist} /> : null}

        {ghosts.length > 0 ? <GhostPanel ghosts={ghosts} onOpen={onOpenSpecialist} /> : null}
      </div>
    </div>
  )
}

// ── Fleet panel ─────────────────────────────────────────────────────

function FleetPanel({
  totalCalls,
  calls,
  gMin,
  gMax,
  rollups,
  colorOf,
  busiest,
}: {
  totalCalls: number
  calls: SpecialistCall[]
  gMin: number
  gMax: number
  rollups: Rollup[]
  colorOf: Map<string, string>
  busiest: string | null
}) {
  const series = useMemo(
    () => bucketCounts(calls.map((c) => c.at), 48, gMin, gMax),
    [calls, gMin, gMax],
  )
  const active = rollups.filter((r) => r.count > 0)
  const segments = active.map((r) => ({
    label: r.name,
    value: r.count,
    color: colorOf.get(r.name) ?? "var(--rvbbit-accent)",
  }))
  const fleetLatencies = useMemo(
    () =>
      calls
        .filter((c) => !c.error)
        .map((c) => c.latencyMs)
        .sort((a, b) => a - b),
    [calls],
  )

  return (
    <Panel icon={Activity} title="Fleet activity" right={<span>{fmtCount(totalCalls)} calls</span>}>
      <div className="flex gap-4">
        <div className="flex shrink-0 flex-col justify-between gap-2">
          <Readout value={fmtCount(totalCalls)} unit="calls" label="specialist invocations" accent />
          <div className="text-[10px] text-chrome-text/60">
            fleet p50{" "}
            <span className="font-mono tabular-nums text-foreground">
              {fmtMs(percentile(fleetLatencies, 0.5))}
            </span>
            {busiest ? (
              <>
                {" · busiest "}
                <span className="font-mono text-rvbbit-accent">{busiest}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/50">
            calls over the receipt log
          </div>
          <Sparkline values={series} height={40} color="var(--rvbbit-accent)" fillOpacity={0.16} />
          {segments.length > 0 ? (
            <>
              <div className="mt-2">
                <CompositionBar segments={segments} height={9} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {segments.map((s) => (
                  <span key={s.label} className="inline-flex items-center gap-1 text-[9px]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ background: s.color }}
                    />
                    <span className="font-mono text-chrome-text/80">{s.label}</span>
                    <span className="font-mono tabular-nums text-chrome-text/45">
                      {Math.round((s.value / Math.max(1, totalCalls)) * 100)}%
                    </span>
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

// ── Specialist card (small multiple) ────────────────────────────────

function SpecialistCard({
  roll,
  gMin,
  gMax,
  modelName,
  onOpen,
}: {
  roll: Rollup
  gMin: number
  gMax: number
  modelName: string
  onOpen: () => void
}) {
  const { spec, health, count, errors, p50, p95, latencies, operators, lastAt } = roll
  const series = useMemo(
    () => bucketCounts(roll.calls.map((c) => c.at), 40, gMin, gMax),
    [roll.calls, gMin, gMax],
  )
  const timeout = spec?.timeout_ms ?? 0
  const errRate = count > 0 ? errors / count : 0
  const barColor = (binStart: number, binEnd: number): string =>
    timeout > 0 ? loadColor((binStart + binEnd) / 2 / timeout) : "var(--rvbbit-accent)"

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-md border border-chrome-border bg-secondary-background p-2.5 text-left transition-colors hover:border-rvbbit-accent/50"
    >
      {/* header */}
      <div className="flex items-center gap-1.5">
        <HealthDot health={health} />
        <span className="shrink-0 font-mono text-[12px] font-medium text-foreground">
          {roll.name}
        </span>
        {spec ? (
          <span className="shrink-0 rounded bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-chrome-text/65">
            {spec.transport}
          </span>
        ) : null}
        {modelName ? (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-chrome-text/45">
            {modelName}
          </span>
        ) : null}
      </div>

      {count === 0 ? (
        <div className="flex h-[92px] flex-col items-center justify-center gap-1 rounded bg-doc-bg/60 text-[10px] text-chrome-text/45">
          <span>awaiting first call</span>
          {spec ? (
            <span className="font-mono text-chrome-text/35">
              batch {spec.batch_size} · {spec.max_concurrent} concurrent
            </span>
          ) : null}
        </div>
      ) : (
        <>
          {/* call volume */}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
                call volume
              </div>
              <Sparkline
                values={series}
                height={26}
                color="var(--rvbbit-accent)"
                fillOpacity={0.18}
              />
            </div>
            <div className="shrink-0 text-right">
              <div className="font-mono text-[17px] leading-none tabular-nums text-foreground">
                {fmtCount(count)}
              </div>
              <div className="text-[8px] uppercase tracking-wider text-chrome-text/50">calls</div>
            </div>
          </div>

          {/* latency distribution */}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
                latency spread
              </div>
              <Histogram
                values={latencies}
                bins={20}
                height={24}
                barColor={barColor}
              />
            </div>
            <div className="shrink-0 text-right font-mono text-[10px] leading-tight tabular-nums">
              <div className="text-foreground">{fmtMs(p50)}</div>
              <div className="text-chrome-text/45">p95 {fmtMs(p95)}</div>
            </div>
          </div>
        </>
      )}

      {/* footer */}
      <div className="flex items-center gap-2 border-t border-chrome-border/50 pt-1.5 text-[10px] tabular-nums text-chrome-text/55">
        {errors > 0 ? (
          <span className="text-danger">{errors} err · {(errRate * 100).toFixed(0)}%</span>
        ) : (
          <span className="text-success/80">no errors</span>
        )}
        <span className="text-chrome-text/30">·</span>
        <span>{operators} ops</span>
        <div className="flex-1" />
        <span>{count > 0 ? fmtAgo(lastAt) : "—"}</span>
      </div>
    </button>
  )
}

// ── Ghost backends ──────────────────────────────────────────────────

function GhostPanel({
  ghosts,
  onOpen,
}: {
  ghosts: Rollup[]
  onOpen: (name: string) => void
}) {
  return (
    <Panel
      icon={Boxes}
      title="Unregistered backends"
      right={<span>{ghosts.length} seen in traffic</span>}
    >
      <p className="mb-2 text-[10px] text-chrome-text/55">
        Names called by an operator but absent from{" "}
        <span className="font-mono">rvbbit.backends</span> — failed lookups or one-off
        ensemble / probe nodes.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ghosts.map((g) => {
          const bad = g.errors > 0
          return (
            <button
              key={g.name}
              type="button"
              onClick={() => onOpen(g.name)}
              title={
                bad
                  ? `${g.errors}/${g.count} calls failed`
                  : `${g.count} call${g.count === 1 ? "" : "s"}`
              }
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                bad
                  ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/15"
                  : "border-chrome-border bg-doc-bg/60 text-chrome-text/70 hover:border-rvbbit-accent/40 hover:text-foreground",
              )}
            >
              {bad ? <AlertTriangle className="h-2.5 w-2.5" /> : null}
              {g.name}
              <span className="tabular-nums opacity-60">{g.count}</span>
            </button>
          )
        })}
      </div>
    </Panel>
  )
}

// ── Runtimes panel ──────────────────────────────────────────────────

function runtimeStatusColor(status: string): string {
  if (status === "ready") return "text-success"
  if (status === "failed" || status === "disabled") return "text-danger"
  if (status === "starting") return "text-warning"
  return "text-chrome-text/60"
}

/**
 * Execution runtimes — peers of model backends in the fleet, not models.
 * Runtime catalogs include rvbbit.python_runtimes and rvbbit.mcp_gateways.
 */
function RuntimesPanel({
  runtimes,
  onOpen,
}: {
  runtimes: InstalledRuntime[]
  onOpen: (name: string) => void
}) {
  return (
    <Panel
      icon={FileCode2}
      title="Execution runtimes"
      right={<span>{runtimes.length} registered</span>}
    >
      <p className="mb-2 text-[10px] text-chrome-text/55">
        Code and tool runtimes that serve operator nodes such as{" "}
        <span className="font-mono">kind: python</span> and{" "}
        <span className="font-mono">kind: mcp</span> — not model backends.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {runtimes.map((rt) => (
          <button
            key={rt.name}
            type="button"
            onClick={() => onOpen(rt.name)}
            className="flex flex-col gap-1 rounded border border-chrome-border bg-doc-bg/60 p-2 text-left transition-colors hover:border-brand-capability/40"
          >
            <div className="flex items-center gap-1.5">
              <FileCode2 className="h-3 w-3 shrink-0 text-brand-capability" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground">
                {rt.name}
              </span>
              <span className={cn("shrink-0 text-[9px] uppercase tracking-wide", runtimeStatusColor(rt.status))}>
                {rt.status || "unknown"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[9px] text-chrome-text/55">
              <span className="rounded bg-foreground/10 px-1 uppercase tracking-wide">
                {rt.language ?? "python"}
              </span>
              {rt.runtime_source ? <span>via {rt.runtime_source}</span> : null}
              {rt.endpoint_url ? (
                <span className="min-w-0 flex-1 truncate text-right font-mono text-chrome-text/40">
                  {rt.endpoint_url}
                </span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </Panel>
  )
}

// ── bits ────────────────────────────────────────────────────────────

function HealthDot({ health }: { health: SpecialistHealth | null }) {
  const color = !health
    ? "bg-chrome-text/30"
    : health.reachable
      ? "bg-success"
      : "bg-danger"
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", color)}
      title={
        !health
          ? "health unknown"
          : health.reachable
            ? `reachable · ${health.latency_ms ?? "?"}ms probe`
            : `unreachable${health.error ? ` · ${health.error}` : ""}`
      }
    />
  )
}
