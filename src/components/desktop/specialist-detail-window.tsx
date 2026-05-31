"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  Clock,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sigma,
  Target,
  TrendingUp,
  Wand2,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Gauge } from "./gauge"
import { Sparkline } from "./sparkline"
import {
  bucketCounts,
  fmtAgo,
  fmtClock,
  fmtCount,
  fmtMs,
  HBars,
  Histogram,
  loadColor,
  Metric,
  Panel,
  percentile,
  Readout,
  ScatterStrip,
  type HBarRow,
  type ScatterPoint,
} from "./instruments"
import type { RvbbitSpecialist } from "@/lib/rvbbit/operators"
import { fetchSpecialists } from "@/lib/rvbbit/operators"
import {
  fetchSpecialistCalls,
  fetchSpecialistContext,
  fetchSpecialistHealth,
  testSpecialist,
  type SpecialistCall,
  type SpecialistHealth,
} from "@/lib/rvbbit/specialists"
import {
  fetchCatalog,
  fetchInstalledRuntimes,
  type CatalogEntry,
  type InstalledRuntime,
} from "@/lib/rvbbit/capabilities"
import {
  fetchWarrenDeploymentByBackend,
  type WarrenDeployment,
} from "@/lib/rvbbit/warren"
import { FileCode2, Package, Rocket } from "@/lib/icons"
import type { SpecialistDetailPayload } from "@/lib/desktop/types"

interface SpecialistDetailWindowProps {
  payload: SpecialistDetailPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenCapability?: (catalogId: string) => void
  onOpenWarrenJob?: (jobId: string, jobName: string | null) => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

const PROBE_PREFIX = "__studio_probe_"

interface SpecialistStats {
  count: number
  okCount: number
  errorCount: number
  lastError: string | null
  latencies: number[]
  timestamps: number[]
  p50: number
  p95: number
  max: number
  min: number
  avg: number
  span: { min: number; max: number }
  lastAt: number
  operators: { op: string; n: number; avg: number }[]
}

export function SpecialistDetailWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenCapability,
  onOpenWarrenJob,
}: SpecialistDetailWindowProps) {
  const name = payload.specialistName
  const [spec, setSpec] = useState<RvbbitSpecialist | null>(null)
  const [runtime, setRuntime] = useState<InstalledRuntime | null>(null)
  const [health, setHealth] = useState<SpecialistHealth | null>(null)
  const [calls, setCalls] = useState<SpecialistCall[]>([])
  const [inputKeys, setInputKeys] = useState<string[]>([])
  const [notFound, setNotFound] = useState(false)
  /**
   * If this backend's name matches a capability pack's `backend_name`,
   * surface a brand-capability chip in the header so the user can pivot
   * back to the install source. Catalog read is cheap (static JSON on
   * the server) so we fire it once on mount alongside the static loads.
   */
  const [capabilityEntry, setCapabilityEntry] = useState<CatalogEntry | null>(null)
  /**
   * If this backend was registered by a Warren deployment, the most-
   * recent deployment row gives us the node name + the originating
   * job_id for cross-link back to the live job detail.
   */
  const [warrenDeployment, setWarrenDeployment] = useState<WarrenDeployment | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  /** First poll not yet returned — derived so it isn't set inside an effect. */
  const loading = updatedAt === 0

  const [testValues, setTestValues] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<
    { output: string | null; latencyMs: number; error?: string } | null
  >(null)
  const [testing, setTesting] = useState(false)

  const loadStatic = useCallback(async () => {
    if (!activeConnectionId) return
    const [s, ctx, h, cat, warren, rt] = await Promise.all([
      fetchSpecialists(activeConnectionId),
      fetchSpecialistContext(activeConnectionId, name),
      fetchSpecialistHealth(activeConnectionId),
      fetchCatalog(activeConnectionId),
      // Best-effort warren probe — if the warren tables aren't present
      // (older rvbbit), the helper returns deployment=null without
      // raising, so this stays cheap on non-warren DBs.
      fetchWarrenDeploymentByBackend(activeConnectionId, name),
      fetchInstalledRuntimes(activeConnectionId),
    ])
    const found = s.specialists.find((x) => x.name === name) ?? null
    const rtFound = rt.runtimes.find((x) => x.name === name) ?? null
    setSpec(found)
    setRuntime(rtFound)
    // A name that's a registered runtime isn't "not found" — it's just an
    // execution runtime rather than a model backend.
    setNotFound(!found && !rtFound)
    setInputKeys(ctx.inputKeys)
    setTestValues((prev) =>
      ctx.inputKeys.length > 0 && Object.keys(prev).length === 0
        ? Object.fromEntries(ctx.inputKeys.map((k) => [k, ""]))
        : prev,
    )
    setHealth(h.health.find((x) => x.specialist === name) ?? null)
    setCapabilityEntry(
      cat.doc?.capabilities.find(
        (c) => c.backend_name === name || c.runtime_name === name,
      ) ?? null,
    )
    setWarrenDeployment(warren.deployment)
  }, [activeConnectionId, name])

  const pollCalls = useCallback(async () => {
    if (!activeConnectionId) return
    const res = await fetchSpecialistCalls(activeConnectionId)
    setCalls(res.calls.filter((c) => c.specialist === name))
    setUpdatedAt(Date.now())
  }, [activeConnectionId, name])

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

  const runTest = useCallback(async () => {
    if (!activeConnectionId) return
    setTesting(true)
    setTestResult(null)
    const res = await testSpecialist(activeConnectionId, name, testValues)
    setTestResult(res)
    setTesting(false)
  }, [activeConnectionId, name, testValues])

  // ── derive ──
  const stats = useMemo<SpecialistStats>(() => {
    const ok = calls.filter((c) => !c.error)
    const latencies = ok.map((c) => c.latencyMs).sort((a, b) => a - b)
    const errors = calls.filter((c) => c.error)
    const span = { min: 0, max: 0 }
    for (const c of calls) {
      if (span.min === 0 || c.at < span.min) span.min = c.at
      if (c.at > span.max) span.max = c.at
    }
    const opMap = new Map<string, { n: number; total: number }>()
    for (const c of calls) {
      const cur = opMap.get(c.operator) ?? { n: 0, total: 0 }
      cur.n += 1
      cur.total += c.latencyMs
      opMap.set(c.operator, cur)
    }
    return {
      count: calls.length,
      okCount: ok.length,
      errorCount: errors.length,
      lastError: errors.length > 0 ? errors[errors.length - 1].error : null,
      latencies,
      timestamps: calls.map((c) => c.at),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
      min: latencies.length > 0 ? latencies[0] : 0,
      avg:
        latencies.length > 0
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : 0,
      span,
      lastAt: calls.length > 0 ? calls[calls.length - 1].at : 0,
      operators: [...opMap.entries()]
        .map(([op, v]) => ({ op, n: v.n, avg: v.n > 0 ? v.total / v.n : 0 }))
        .sort((a, b) => b.n - a.n),
    }
  }, [calls])

  const modelName =
    health?.reported_model ??
    (typeof spec?.transport_opts?.model === "string" ? spec.transport_opts.model : null)
  const timeout = spec?.timeout_ms ?? 0

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text/70">
        No pg_rvbbit extension on this connection.
      </div>
    )
  }
  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" /> Loading {name}…
        </span>
      </div>
    )
  }

  // This name is an execution runtime, not a model backend — render a
  // runtime-shaped view (no model / batch / `/predict` live test).
  if (runtime && !spec) {
    return (
      <RuntimeDetailView
        runtime={runtime}
        capabilityEntry={capabilityEntry}
        warrenDeployment={warrenDeployment}
        onOpenCapability={onOpenCapability}
        onOpenWarrenJob={onOpenWarrenJob}
      />
    )
  }

  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
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
        <Brain className="h-3.5 w-3.5 text-rvbbit-accent" />
        <span className="font-mono text-[13px] font-medium text-foreground">{name}</span>
        {spec ? (
          <span className="rounded bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-chrome-text/70">
            {spec.transport}
          </span>
        ) : null}
        <HealthPill health={health} />
        {modelName ? (
          <span className="hidden truncate font-mono text-[10px] text-chrome-text/50 sm:inline">
            {modelName}
          </span>
        ) : null}
        {notFound ? (
          <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] text-warning">
            unregistered
          </span>
        ) : null}
        {capabilityEntry && onOpenCapability ? (
          <button
            type="button"
            onClick={() => onOpenCapability(capabilityEntry.id)}
            title={`Installed from capability pack: ${capabilityEntry.title}`}
            className="inline-flex items-center gap-1 rounded-full border border-brand-capability/40 bg-brand-capability/10 px-2 py-0.5 text-[10px] text-brand-capability hover:bg-brand-capability/15"
          >
            <Package className="h-3 w-3" />
            from capability
          </button>
        ) : null}
        {warrenDeployment ? (
          <button
            type="button"
            onClick={() =>
              warrenDeployment.job_id && onOpenWarrenJob
                ? onOpenWarrenJob(warrenDeployment.job_id, warrenDeployment.name)
                : undefined
            }
            disabled={!warrenDeployment.job_id || !onOpenWarrenJob}
            title={
              warrenDeployment.node_name
                ? `Deployed by warren node ${warrenDeployment.node_name}` +
                  (warrenDeployment.job_id ? " — click to open the job" : "")
                : "Deployed by warren"
            }
            className="inline-flex items-center gap-1 rounded-full border border-brand-warren/40 bg-brand-warren/10 px-2 py-0.5 text-[10px] text-brand-warren hover:bg-brand-warren/15 disabled:cursor-default disabled:opacity-70"
          >
            <Rocket className="h-3 w-3" />
            warren · {warrenDeployment.node_name ?? "unknown"}
          </button>
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

      <div className="flex min-h-0 flex-1">
        {/* left — instrument stack */}
        <div className="min-w-0 flex-1 space-y-2.5 overflow-auto p-2.5">
          {/* hero — latency over time */}
          <Panel
            icon={Activity}
            title="Latency over time"
            right={
              <span>
                {stats.count > 0
                  ? `${fmtClock(stats.span.min)} – ${fmtClock(stats.span.max)}`
                  : "no calls"}
              </span>
            }
          >
            <ScatterStrip
              points={calls.map<ScatterPoint>((c) => ({
                x: c.at,
                y: c.latencyMs,
                error: !!c.error,
                label: `${fmtMs(c.latencyMs)} · ${c.operator} · ${fmtClock(c.at)}`,
              }))}
              height={156}
              refLines={
                stats.latencies.length > 0
                  ? [
                      { y: stats.p50, label: `p50 ${fmtMs(stats.p50)}`, color: "var(--chrome-text)" },
                      { y: stats.p95, label: `p95 ${fmtMs(stats.p95)}`, color: "var(--warning)" },
                    ]
                  : []
              }
            />
          </Panel>

          {/* throughput / distribution / reliability */}
          <div className="grid grid-cols-3 gap-2.5">
            <ThroughputPanel stats={stats} />
            <DistributionPanel stats={stats} timeout={timeout} />
            <ReliabilityPanel stats={stats} />
          </div>

          {/* latency vs timeout budget */}
          {timeout > 0 ? (
            <Panel
              icon={Clock}
              title="Latency budget"
              right={<span>{fmtMs(timeout)} timeout</span>}
            >
              <div className="space-y-1.5">
                <BudgetBar label="avg" ms={stats.avg} timeout={timeout} />
                <BudgetBar label="p50" ms={stats.p50} timeout={timeout} />
                <BudgetBar label="p95" ms={stats.p95} timeout={timeout} />
                <BudgetBar label="max" ms={stats.max} timeout={timeout} />
              </div>
            </Panel>
          ) : null}

          {/* driven by operators */}
          <Panel
            icon={Wand2}
            title="Driven by operators"
            right={<span>{stats.operators.length} callers</span>}
          >
            {stats.operators.length > 0 ? (
              <HBars
                rows={stats.operators.slice(0, 12).map<HBarRow>((o) => {
                  const probe = o.op.startsWith(PROBE_PREFIX)
                  return {
                    label: probe ? "live-test probe" : `rvbbit.${o.op}`,
                    value: o.n,
                    valueLabel: fmtCount(o.n),
                    sub: fmtMs(o.avg),
                    muted: probe,
                    title: `${o.op} — ${o.n} calls, ${fmtMs(o.avg)} avg`,
                  }
                })}
              />
            ) : (
              <p className="text-[11px] text-chrome-text/55">
                No operator has called this backend yet.
              </p>
            )}
          </Panel>

          {/* recent calls */}
          {calls.length > 0 ? (
            <Panel icon={TrendingUp} title="Recent calls" right={<span>latest {Math.min(8, calls.length)}</span>}>
              <table className="w-full text-[11px]">
                <thead className="text-[9px] uppercase tracking-wider text-chrome-text/45">
                  <tr>
                    <th className="py-0.5 pr-2 text-left font-medium">time</th>
                    <th className="py-0.5 pr-2 text-left font-medium">operator</th>
                    <th className="py-0.5 pr-2 text-left font-medium">step</th>
                    <th className="py-0.5 text-right font-medium">latency</th>
                  </tr>
                </thead>
                <tbody>
                  {[...calls]
                    .slice(-8)
                    .reverse()
                    .map((c, i) => (
                      <tr key={i} className="border-t border-chrome-border/30">
                        <td className="py-0.5 pr-2 font-mono tabular-nums text-chrome-text/70">
                          {fmtClock(c.at)}
                        </td>
                        <td className="max-w-[150px] truncate py-0.5 pr-2 font-mono text-rvbbit-accent">
                          {c.operator.startsWith(PROBE_PREFIX) ? "live-test probe" : c.operator}
                        </td>
                        <td className="py-0.5 pr-2 font-mono text-chrome-text/55">{c.step}</td>
                        <td
                          className={cn(
                            "py-0.5 text-right font-mono tabular-nums",
                            c.error ? "text-danger" : "text-foreground",
                          )}
                        >
                          {c.error ? "error" : fmtMs(c.latencyMs)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          {/* backend config */}
          <Panel icon={Layers} title="Backend">
            {spec ? (
              <div className="space-y-1.5">
                <KV k="endpoint" v={spec.endpoint_url} mono />
                <KV k="model" v={modelName ?? "—"} mono />
                <div className="grid grid-cols-3 gap-2 pt-0.5">
                  <Metric label="batch size" value={String(spec.batch_size)} />
                  <Metric label="max concurrent" value={String(spec.max_concurrent)} />
                  <Metric label="timeout" value={fmtMs(spec.timeout_ms)} />
                </div>
                {spec.description ? (
                  <p className="pt-0.5 text-[11px] leading-snug text-chrome-text/70">
                    {spec.description}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-[11px] text-chrome-text/55">
                Not in <span className="font-mono">rvbbit.backends</span> — reconstructed from
                the receipt log only. Register it to enable health probes and config.
              </p>
            )}
          </Panel>
        </div>

        {/* right — live test */}
        <aside className="flex w-[320px] shrink-0 flex-col overflow-auto border-l border-chrome-border bg-chrome-bg/40">
          <div className="border-b border-chrome-border px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-chrome-text/60">
              <Play className="h-3 w-3 text-rvbbit-accent" />
              Live test
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-chrome-text/55">
              Wraps the backend in a one-off probe operator and calls it for real — one billable
              round-trip.
            </p>
          </div>
          <div className="px-3 py-2">
            <TestInputs values={testValues} onChange={setTestValues} />
            <Button
              size="sm"
              onClick={() => void runTest()}
              disabled={testing || Object.keys(testValues).length === 0}
              className="mt-2 w-full"
            >
              <Play className="h-3 w-3" />
              {testing ? "Calling…" : "Run test"}
            </Button>
          </div>
          {testResult ? (
            <div className="border-t border-chrome-border px-3 py-2">
              {testResult.error ? (
                <div className="flex items-start gap-1.5 rounded-base border border-danger/50 bg-danger/10 px-2 py-1 text-[11px] text-danger">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  <span className="break-words">{testResult.error}</span>
                </div>
              ) : (
                <>
                  <div className="mb-1 flex items-center gap-2 text-[10px] text-chrome-text/55">
                    <span className="rounded-full bg-emerald-400/15 px-1.5 text-emerald-400">ok</span>
                    <span className="tabular-nums">{testResult.latencyMs}ms round-trip</span>
                  </div>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-chrome-border bg-doc-bg p-2 font-mono text-[10px] text-foreground">
                    {testResult.output ?? "(null)"}
                  </pre>
                </>
              )}
            </div>
          ) : null}
          {inputKeys.length === 0 ? (
            <div className="mt-auto border-t border-chrome-border px-3 py-2 text-[10px] text-chrome-text/45">
              No wire-format keys were derived from operator definitions — add the backend&apos;s
              expected input fields above.
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

// ── Panels ──────────────────────────────────────────────────────────

function ThroughputPanel({ stats }: { stats: SpecialistStats }) {
  const series = useMemo(() => {
    if (stats.timestamps.length === 0) return []
    return bucketCounts(stats.timestamps, 36, stats.span.min, stats.span.max)
  }, [stats.timestamps, stats.span.min, stats.span.max])
  return (
    <Panel icon={TrendingUp} title="Throughput">
      <div className="space-y-2">
        <Readout value={fmtCount(stats.count)} unit="calls" accent />
        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
            call volume
          </div>
          <Sparkline values={series} height={28} color="var(--rvbbit-accent)" fillOpacity={0.18} />
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-chrome-border/40 pt-1.5">
          <Metric label="succeeded" value={fmtCount(stats.okCount)} />
          <Metric label="last call" value={stats.count > 0 ? fmtAgo(stats.lastAt) : "never"} />
        </div>
      </div>
    </Panel>
  )
}

function DistributionPanel({ stats, timeout }: { stats: SpecialistStats; timeout: number }) {
  const barColor = (a: number, b: number): string =>
    timeout > 0 ? loadColor((a + b) / 2 / timeout) : "var(--rvbbit-accent)"
  return (
    <Panel icon={Sigma} title="Latency distribution">
      <div className="space-y-2">
        {stats.latencies.length > 0 ? (
          <div className="pt-2">
            <Histogram
              values={stats.latencies}
              bins={24}
              height={56}
              barColor={barColor}
              markers={[
                { value: stats.p50, color: "var(--chrome-text)" },
                { value: stats.p95, color: "var(--warning)" },
              ]}
            />
          </div>
        ) : (
          <div className="grid h-14 place-items-center text-[10px] text-chrome-text/45">
            no successful calls
          </div>
        )}
        <div className="grid grid-cols-4 gap-1.5 border-t border-chrome-border/40 pt-1.5">
          <Metric label="min" value={fmtMs(stats.min)} />
          <Metric label="median" value={fmtMs(stats.p50)} />
          <Metric label="p95" value={fmtMs(stats.p95)} />
          <Metric label="max" value={fmtMs(stats.max)} />
        </div>
      </div>
    </Panel>
  )
}

function ReliabilityPanel({ stats }: { stats: SpecialistStats }) {
  const errRate = stats.count > 0 ? stats.errorCount / stats.count : 0
  return (
    <Panel icon={Target} title="Reliability">
      <div className="space-y-2">
        <Readout
          value={`${(errRate * 100).toFixed(stats.errorCount > 0 ? 1 : 0)}%`}
          unit="errors"
          tone={errRate >= 0.1 ? "danger" : errRate > 0 ? "warning" : "success"}
        />
        <Gauge value={stats.errorCount} max={Math.max(1, stats.count)} />
        <div className="grid grid-cols-2 gap-2">
          <Metric label="clean" value={fmtCount(stats.okCount)} />
          <Metric
            label="failed"
            value={fmtCount(stats.errorCount)}
            tone={stats.errorCount > 0 ? "danger" : undefined}
          />
        </div>
        {stats.lastError ? (
          <div className="rounded border border-danger/30 bg-danger/[0.07] px-1.5 py-1 text-[9px] leading-snug text-danger">
            {stats.lastError}
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

// ── small components ────────────────────────────────────────────────

function BudgetBar({ label, ms, timeout }: { label: string; ms: number; timeout: number }) {
  const ratio = timeout > 0 ? Math.min(1, ms / timeout) : 0
  const pct = timeout > 0 ? (ms / timeout) * 100 : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-[10px] text-chrome-text/55">{label}</span>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${Math.max(1.5, ratio * 100)}%`, background: loadColor(ratio) }}
        />
      </div>
      <span className="w-24 shrink-0 text-right font-mono text-[10px] tabular-nums text-foreground">
        {fmtMs(ms)}{" "}
        <span className="text-chrome-text/45">{pct < 1 ? "<1" : pct.toFixed(0)}%</span>
      </span>
    </div>
  )
}

function HealthPill({ health }: { health: SpecialistHealth | null }) {
  if (!health) {
    return <span className="text-[10px] text-chrome-text/45">health…</span>
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]",
        health.reachable
          ? "bg-emerald-400/15 text-emerald-400"
          : "bg-danger/15 text-danger",
      )}
      title={health.error ?? health.endpoint}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          health.reachable ? "bg-emerald-400" : "bg-danger",
        )}
      />
      {health.reachable ? `reachable · ${health.latency_ms ?? "?"}ms` : "unreachable"}
    </span>
  )
}

function TestInputs({
  values,
  onChange,
}: {
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const entries = Object.entries(values)
  return (
    <div className="space-y-1.5">
      {entries.length === 0 ? (
        <p className="text-[10px] text-chrome-text/55">
          No inputs known — add the backend&apos;s wire-format keys below.
        </p>
      ) : null}
      {entries.map(([k, v]) => (
        <label key={k} className="block">
          <span className="mb-0.5 block font-mono text-[10px] text-chrome-text/65">{k}</span>
          <textarea
            value={v}
            onChange={(e) => onChange({ ...values, [k]: e.target.value })}
            rows={2}
            className="w-full rounded border border-chrome-border bg-doc-bg px-2 py-1 text-[11px] text-foreground outline-none focus:border-main/60"
          />
        </label>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...values, [`field${entries.length + 1}`]: "" })}
        className="inline-flex items-center gap-0.5 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:bg-foreground/[0.06]"
      >
        <Plus className="h-2.5 w-2.5" />
        add field
      </button>
    </div>
  )
}

/**
 * Detail view for an execution runtime rather than a model backend. No model
 * / batch / `/predict` live test — a runtime serves workflow node kinds such
 * as `python` or `mcp`. The "three layers" framing: a backend/runtime is
 * plumbing; the callable thing is the operator.
 */
function RuntimeDetailView({
  runtime,
  capabilityEntry,
  warrenDeployment,
  onOpenCapability,
  onOpenWarrenJob,
}: {
  runtime: InstalledRuntime
  capabilityEntry: CatalogEntry | null
  warrenDeployment: WarrenDeployment | null
  onOpenCapability?: (catalogId: string) => void
  onOpenWarrenJob?: (jobId: string, jobName: string | null) => void
}) {
  const statusColor =
    runtime.status === "ready"
      ? "text-success"
      : runtime.status === "failed" || runtime.status === "disabled"
        ? "text-danger"
        : runtime.status === "starting"
          ? "text-warning"
          : "text-chrome-text/60"
  const health = runtime.health
  const labels = runtime.labels
  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-capability/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-brand-capability">
          <FileCode2 className="h-3.5 w-3.5" /> python runtime
        </span>
        <span className="font-mono text-[13px] font-medium text-foreground">{runtime.name}</span>
        <span className="rounded bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-chrome-text/70">
          {runtime.language ?? "python"}
        </span>
        <span className={cn("text-[10px] uppercase tracking-wide", statusColor)}>
          {runtime.status || "unknown"}
        </span>
        {capabilityEntry && onOpenCapability ? (
          <button
            type="button"
            onClick={() => onOpenCapability(capabilityEntry.id)}
            title={`Installed from capability pack: ${capabilityEntry.title}`}
            className="inline-flex items-center gap-1 rounded-full border border-brand-capability/40 bg-brand-capability/10 px-2 py-0.5 text-[10px] text-brand-capability hover:bg-brand-capability/15"
          >
            <Package className="h-3 w-3" />
            from capability
          </button>
        ) : null}
        {warrenDeployment ? (
          <button
            type="button"
            onClick={() =>
              warrenDeployment.job_id && onOpenWarrenJob
                ? onOpenWarrenJob(warrenDeployment.job_id, warrenDeployment.name)
                : undefined
            }
            disabled={!warrenDeployment.job_id || !onOpenWarrenJob}
            title={`Deployed by warren node ${warrenDeployment.node_name ?? "unknown"}`}
            className="inline-flex items-center gap-1 rounded-full border border-brand-warren/40 bg-brand-warren/10 px-2 py-0.5 text-[10px] text-brand-warren hover:bg-brand-warren/15 disabled:cursor-default disabled:opacity-70"
          >
            <Rocket className="h-3 w-3" />
            warren · {warrenDeployment.node_name ?? "unknown"}
          </button>
        ) : null}
      </div>

      <div className="flex-1 space-y-2.5 overflow-auto p-2.5">
        <Panel
          icon={FileCode2}
          title="Runtime"
          right={runtime.runtime_source ? <span>source: {runtime.runtime_source}</span> : null}
        >
          <div className="space-y-1.5">
            <KV k="endpoint" v={runtime.endpoint_url ?? "—"} mono />
            <KV k="transport" v={runtime.language === "mcp" ? "MCP gateway" : "/run · execution"} />
            <KV k="language" v={runtime.language ?? "python"} />
            <KV k="status" v={runtime.status || "unknown"} />
            <KV k="source" v={runtime.runtime_source ?? "—"} />
            {runtime.updated_at ? <KV k="updated" v={fmtAgo(runtime.updated_at)} /> : null}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-chrome-text/55">
            Serves workflow operator nodes such as{" "}
            <span className="font-mono">kind: {runtime.language ?? "python"}</span>. There is no
            model or <span className="font-mono">/predict</span> batch transport. A runtime is
            plumbing; the callable thing is the operator that uses it.
          </p>
        </Panel>

        {labels && Object.keys(labels).length > 0 ? (
          <Panel icon={Target} title="Labels">
            <pre className="overflow-auto rounded bg-doc-bg/60 p-2 font-mono text-[10px] text-chrome-text/80">
              {JSON.stringify(labels, null, 2)}
            </pre>
          </Panel>
        ) : null}

        {health && typeof health === "object" && Object.keys(health as object).length > 0 ? (
          <Panel icon={Activity} title="Health">
            <pre className="overflow-auto rounded bg-doc-bg/60 p-2 font-mono text-[10px] text-chrome-text/80">
              {JSON.stringify(health, null, 2)}
            </pre>
          </Panel>
        ) : null}
      </div>
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-24 shrink-0 text-chrome-text/55">{k}</span>
      <span className={cn("min-w-0 break-words text-foreground", mono && "font-mono text-[10px]")}>
        {v}
      </span>
    </div>
  )
}
