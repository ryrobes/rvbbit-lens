"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useWorkspaceActive } from "./workspace-active-context"
import { usePolling } from "@/lib/desktop/use-polling"
import {
  Activity,
  AlertTriangle,
  FlowArrow,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  Zap,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  Metric,
  Panel,
} from "./instruments"
import { EngineDot, EnginePill, FlowDiagram, type FlowLink } from "./routing-charts"
import {
  ENGINES,
  fetchColumnarTables,
  fetchDecisionSummary,
  fetchEngineRuntime,
  fetchLogStatus,
  fetchObservationGroups,
  fetchProfileEntries,
  fetchProfilePoints,
  fetchRouteExecutions,
  fetchRouteProfile,
  fetchShapeSummary,
  ROUTE_WINDOW_OPTIONS,
  type ColumnarTable,
  type FlowData,
  type LogStatus,
  type ProfileData,
  type RouteExecution,
} from "@/lib/rvbbit/routing"
import { RoutingProfileTab } from "./routing-profile-tab"
import { RoutingExplainTab } from "./routing-explain-tab"
import { RoutingTrainTab } from "./routing-train-tab"
import { RoutingFreshnessTab } from "./routing-freshness-tab"

interface RoutingWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

type TabKey = "flow" | "freshness" | "profile" | "explain" | "train"
const TABS: { key: TabKey; label: string }[] = [
  { key: "flow", label: "Flow" },
  { key: "freshness", label: "Freshness" },
  { key: "profile", label: "Profile" },
  { key: "explain", label: "Explain" },
  { key: "train", label: "Train" },
]

/**
 * Adaptive Routing — observability for rvbbit's trained query router.
 * Three views: live Flow (paths queries take), the trained Profile
 * (how it decides), and an interactive Explain (route a query for real).
 */
export function RoutingWindow({ activeConnectionId, hasRvbbit }: RoutingWindowProps) {
  const [tab, setTab] = useState<TabKey>("flow")
  const [flow, setFlow] = useState<FlowData | null>(null)
  const [profileData, setProfileData] = useState<ProfileData | null>(null)
  const [columnarTables, setColumnarTables] = useState<ColumnarTable[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const workspaceActive = useWorkspaceActive()
  const [windowHours, setWindowHours] = useState<number>(ROUTE_WINDOW_OPTIONS[0].hours)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0

  const pollFlow = useCallback(async () => {
    if (!activeConnectionId) return
    const [executions, decisionSummary, engineRuntime, logStatus] = await Promise.all([
      fetchRouteExecutions(activeConnectionId, windowHours),
      fetchDecisionSummary(activeConnectionId, windowHours),
      fetchEngineRuntime(activeConnectionId, windowHours),
      fetchLogStatus(activeConnectionId),
    ])
    setError(executions.error ?? null)
    setFlow({
      executions: executions.rows,
      decisionSummary,
      engineRuntime,
      logStatus,
    })
    setUpdatedAt(Date.now())
  }, [activeConnectionId, windowHours])

  const loadProfile = useCallback(async () => {
    if (!activeConnectionId) return
    const [profile, entries, shapeSummary, points, observations, tables] =
      await Promise.all([
        fetchRouteProfile(activeConnectionId),
        fetchProfileEntries(activeConnectionId),
        fetchShapeSummary(activeConnectionId),
        fetchProfilePoints(activeConnectionId),
        fetchObservationGroups(activeConnectionId),
        fetchColumnarTables(activeConnectionId),
      ])
    setProfileData({ profile, entries, shapeSummary, points, observations })
    setColumnarTables(tables)
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await loadProfile()
      await pollFlow()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, loadProfile, pollFlow])

  usePolling(pollFlow, intervalMs, {
    enabled: !!activeConnectionId && hasRvbbit && !paused && workspaceActive,
    resetKey: activeConnectionId,
  })

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <GitBranch className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension.
        </div>
      </div>
    )
  }

  const profileName = profileData?.profile?.name ?? null
  const totalDecisions = (flow?.decisionSummary ?? []).reduce((s, d) => s + d.decisions, 0)
  const totalRuns = (flow?.engineRuntime ?? []).reduce((s, r) => s + r.runs, 0)
  const windowLabel =
    ROUTE_WINDOW_OPTIONS.find((o) => o.hours === windowHours)?.label ?? `${windowHours}h`

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
          <GitBranch className="h-3.5 w-3.5 text-rvbbit-accent" />
          Adaptive Routing
        </span>
        {profileName ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              profile <span className="font-mono text-rvbbit-accent">{profileName}</span>
            </span>
          </>
        ) : null}
        {!loading ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span className="tabular-nums">
              {fmtCount(totalDecisions)} decisions · {fmtCount(totalRuns)} runs ·{" "}
              <span className="text-chrome-text/55">last {windowLabel}</span>
            </span>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <select
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
            title="Time window — all charts aggregate this range"
            className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            {ROUTE_WINDOW_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                last {o.label}
              </option>
            ))}
          </select>
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
              void loadProfile()
              void pollFlow()
            }}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-0.5 border-b border-chrome-border bg-chrome-bg/20 px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-[11px] font-medium transition-colors",
              tab === t.key
                ? "border-rvbbit-accent text-foreground"
                : "border-transparent text-chrome-text/60 hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "flow" ? (
          <FlowTab
            flow={flow}
            profileData={profileData}
            loading={loading}
            windowLabel={windowLabel}
          />
        ) : tab === "freshness" ? (
          <RoutingFreshnessTab activeConnectionId={activeConnectionId} />
        ) : tab === "profile" ? (
          <RoutingProfileTab data={profileData} />
        ) : tab === "explain" ? (
          <RoutingExplainTab
            activeConnectionId={activeConnectionId}
            columnarTables={columnarTables}
          />
        ) : (
          <RoutingTrainTab activeConnectionId={activeConnectionId} />
        )}
      </div>
    </div>
  )
}

// ── Flow tab ────────────────────────────────────────────────────────

interface EngineStat {
  id: string
  decisions: number
  cacheHits: number
  runs: number
  median: number
  p95: number
  trainedShapes: number
  trainedConf: number
}

function FlowTab({
  flow,
  profileData,
  loading,
  windowLabel,
}: {
  flow: FlowData | null
  profileData: ProfileData | null
  loading: boolean
  windowLabel: string
}) {
  const engineStats = useMemo<EngineStat[]>(() => {
    const entries = profileData?.entries ?? []
    return ENGINES.map((e) => {
      const decRows = (flow?.decisionSummary ?? []).filter((d) => d.candidate === e.id)
      const decisions = decRows.reduce((s, d) => s + d.decisions, 0)
      const cacheHits = decRows.reduce((s, d) => s + d.cacheHits, 0)
      const rt = (flow?.engineRuntime ?? []).find((r) => r.candidate === e.id)
      const trained = entries.filter((en) => en.choice === e.id)
      return {
        id: e.id,
        decisions,
        cacheHits,
        runs: rt?.runs ?? 0,
        median: rt?.medianMs ?? 0,
        p95: rt?.p95Ms ?? 0,
        trainedShapes: trained.length,
        trainedConf:
          trained.length > 0
            ? trained.reduce((s, t) => s + t.confidence, 0) / trained.length
            : 0,
      }
    })
  }, [flow, profileData])

  const flowLinks = useMemo<FlowLink[]>(
    () =>
      (flow?.decisionSummary ?? [])
        .filter((d) => d.decisions > 0)
        .map((d) => ({ source: d.routeSource, target: d.candidate, value: d.decisions })),
    [flow],
  )

  const slowestMedian = Math.max(1, ...engineStats.map((e) => e.median))

  if (loading) {
    return (
      <div className="grid h-40 place-items-center text-[11px] text-chrome-text/55">
        Reading route telemetry…
      </div>
    )
  }

  return (
    <div className="space-y-2.5 p-2.5">
      <Panel
        icon={FlowArrow}
        title="Routing pathways"
        right={<span>decision source → engine · last {windowLabel}</span>}
      >
        <FlowDiagram links={flowLinks} height={232} />
        <p className="mt-1.5 text-[10px] leading-snug text-chrome-text/55">
          Every routed SELECT enters from a decision source on the left — a hard rule, an
          eligibility check, or a hit in the trained profile — and is dispatched to an
          execution engine on the right. Only engines that saw traffic in this window appear
          here; idle ones are hidden, and their cards below are dimmed.
        </p>
      </Panel>

      <div className="grid grid-cols-3 gap-2.5">
        {engineStats.map((s) => (
          <EngineCard key={s.id} stat={s} slowestMedian={slowestMedian} />
        ))}
      </div>

      <RecentExecutions executions={flow?.executions ?? []} windowLabel={windowLabel} />

      <TelemetryPanel status={flow?.logStatus ?? null} />
    </div>
  )
}

function EngineCard({ stat, slowestMedian }: { stat: EngineStat; slowestMedian: number }) {
  const engine = ENGINES.find((e) => e.id === stat.id)!
  const cacheRate = stat.decisions > 0 ? stat.cacheHits / stat.decisions : 0
  // No routing this window → dim it. It returns to full strength the moment
  // a decision or run lands on this engine again.
  const used = stat.decisions > 0 || stat.runs > 0
  return (
    <div
      className={cn(
        "rounded-md border border-chrome-border bg-secondary-background p-2.5 transition-opacity",
        used ? "" : "opacity-40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <EngineDot id={stat.id} />
        <span className="shrink-0 font-mono text-[12px] font-medium text-foreground">
          {engine.label}
        </span>
        <span className="min-w-0 flex-1 truncate pl-2 text-right text-[9px] text-chrome-text/45">
          {engine.blurb}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Metric label="decisions" value={fmtCount(stat.decisions)} />
        <Metric label="online runs" value={fmtCount(stat.runs)} />
        <Metric label="trained for" value={`${stat.trainedShapes} shapes`} />
      </div>

      <div className="mt-2 border-t border-chrome-border/50 pt-1.5">
        {stat.runs > 0 ? (
          <>
            <div className="flex items-baseline justify-between text-[10px]">
              <span className="text-chrome-text/55">online latency</span>
              <span className="font-mono tabular-nums text-foreground">
                p50 {fmtMs(stat.median)} · p95 {fmtMs(stat.p95)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(3, (stat.median / slowestMedian) * 100)}%`,
                  background: engine.color,
                }}
              />
            </div>
          </>
        ) : (
          <div className="text-[10px] text-chrome-text/45">no online runs yet</div>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/55">
        <span>
          cache{" "}
          <span className="text-chrome-text/85">{(cacheRate * 100).toFixed(0)}%</span>
        </span>
        <span className="text-chrome-text/25">·</span>
        <span>
          trained confidence{" "}
          <span className="text-chrome-text/85">{(stat.trainedConf * 100).toFixed(0)}%</span>
        </span>
      </div>
    </div>
  )
}

function RecentExecutions({
  executions,
  windowLabel,
}: {
  executions: RouteExecution[]
  windowLabel: string
}) {
  const rows = executions.slice(0, 14)
  return (
    <Panel
      icon={Activity}
      title="Recent executions"
      right={<span>latest {rows.length} · last {windowLabel}</span>}
    >
      {rows.length === 0 ? (
        <p className="text-[11px] text-chrome-text/55">
          No routed executions recorded. Run a SELECT against an rvbbit columnar table.
        </p>
      ) : (
        <table className="w-full text-[11px]">
          <thead className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            <tr>
              <th className="py-0.5 pr-2 text-left font-medium">time</th>
              <th className="py-0.5 pr-2 text-left font-medium">engine</th>
              <th className="py-0.5 pr-2 text-right font-medium">elapsed</th>
              <th className="py-0.5 pr-2 text-right font-medium">rows</th>
              <th className="py-0.5 pr-2 text-left font-medium">cache</th>
              <th className="py-0.5 text-left font-medium">reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-chrome-border/30 align-top">
                <td className="py-0.5 pr-2 font-mono tabular-nums text-chrome-text/70">
                  {new Date(r.executedAt).toLocaleTimeString([], { hour12: false })}
                </td>
                <td className="py-0.5 pr-2">
                  <EnginePill id={r.candidate} />
                </td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums text-foreground">
                  {fmtMs(r.elapsedMs)}
                </td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums text-chrome-text/70">
                  {fmtCount(r.rowsReturned)}
                </td>
                <td className="py-0.5 pr-2 font-mono text-[10px] text-chrome-text/60">
                  {r.cacheHit ? "hit" : "miss"}
                </td>
                <td
                  className="max-w-[260px] truncate py-0.5 text-[10px] text-chrome-text/60"
                  title={r.reason}
                >
                  {r.reason || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function TelemetryPanel({ status }: { status: LogStatus | null }) {
  if (!status) {
    return (
      <Panel icon={Zap} title="Telemetry health">
        <p className="text-[11px] text-chrome-text/55">Route log status unavailable.</p>
      </Panel>
    )
  }
  const fields: { label: string; value: string; tone?: "danger" | "warning" | "muted" }[] = [
    { label: "enabled", value: status.enabled ? "yes" : "no", tone: status.enabled ? undefined : "warning" },
    { label: "writer started", value: status.started ? "yes" : "no", tone: status.started ? undefined : "warning" },
    { label: "queue", value: `${status.queueLen}${status.queueCapacity ? ` / ${status.queueCapacity}` : ""}` },
    { label: "written", value: status.written != null ? fmtCount(status.written) : "—", tone: "muted" },
    { label: "dropped", value: status.dropped != null ? fmtCount(status.dropped) : "—", tone: status.dropped ? "danger" : "muted" },
    { label: "write errors", value: status.writeErrors != null ? fmtCount(status.writeErrors) : "—", tone: status.writeErrors ? "danger" : "muted" },
  ]
  return (
    <Panel
      icon={Zap}
      title="Telemetry health"
      right={<span>backend pid {status.backendPid}</span>}
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {fields.map((f) => (
          <Metric key={f.label} label={f.label} value={f.value} tone={f.tone} />
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-snug text-chrome-text/50">
        Counters are process-local to the backend serving this window ({status.scope} scope) —
        table row counts are the global history.
      </p>
    </Panel>
  )
}
