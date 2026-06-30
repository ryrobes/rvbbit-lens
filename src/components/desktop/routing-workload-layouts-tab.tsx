"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import {
  AlertTriangle,
  Activity,
  Boxes,
  Brain,
  Check,
  Clock,
  Database,
  Hammer,
  RefreshCw,
  Rocket,
  Search,
  SortAscending,
  Sparkles,
  Table2,
  Target,
  TrendingUp,
  XCircle,
  Zap,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  enableAccelerationCandidate,
  fetchAccelerationCandidates,
  fetchWorkloadLayoutCatalog,
  fetchWorkloadLayoutRecommendations,
  fetchWorkloadLayoutTables,
  refreshAcceptedWorkloadLayouts,
  runRvbbitMigrate,
  runWorkloadLayoutAdvisor,
  setWorkloadLayoutRecommendationStatus,
  type AccelerationCandidate,
  type WorkloadLayoutBuildRun,
  type WorkloadLayoutKind,
  type WorkloadLayoutRecommendation,
  type WorkloadLayoutTable,
} from "@/lib/rvbbit/routing"
import {
  fetchSystemLearningBrainStatus,
  syncSystemLearningBrain,
  type SystemLearningBrainSync,
  type SystemLearningBrainStatus,
} from "@/lib/rvbbit/brain"
import { fmtBytes } from "@/lib/rvbbit/finder-format"
import { fmtAgo, fmtCount, fmtMs, Metric, Panel } from "./instruments"

interface Props {
  activeConnectionId: string | null
}

const ALL_TABLES = "__all__"
type PanelMode = "layouts" | "accelerate"
type LayoutViewMode = "all" | "candidates" | "accepted" | "built"
const PANEL_MODES: { key: PanelMode; label: string }[] = [
  { key: "layouts", label: "Layouts" },
  { key: "accelerate", label: "Accelerate" },
]
const VIEW_MODES: { key: LayoutViewMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "candidates", label: "Candidates" },
  { key: "accepted", label: "Accepted" },
  { key: "built", label: "Built" },
]
const LOOKBACK_OPTIONS = [
  { hours: 1, label: "1h" },
  { hours: 3, label: "3h" },
  { hours: 12, label: "12h" },
  { hours: 24, label: "24h" },
  { hours: 72, label: "3d" },
  { hours: 168, label: "7d" },
]
const MIN_OBSERVATION_OPTIONS = [1, 2, 5, 10, 25]

export function RoutingWorkloadLayoutsTab({ activeConnectionId }: Props) {
  const [catalogReady, setCatalogReady] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>("layouts")
  const [tables, setTables] = useState<WorkloadLayoutTable[]>([])
  const [recommendations, setRecommendations] = useState<WorkloadLayoutRecommendation[]>([])
  const [accelerationCandidates, setAccelerationCandidates] = useState<AccelerationCandidate[]>([])
  const [learningStatus, setLearningStatus] = useState<SystemLearningBrainStatus | null>(null)
  const [accelPgStatStatements, setAccelPgStatStatements] = useState(false)
  const [selectedTable, setSelectedTable] = useState<string>(ALL_TABLES)
  const [search, setSearch] = useState("")
  const [lookbackHours, setLookbackHours] = useState(24)
  const [minObservations, setMinObservations] = useState(2)
  const [viewMode, setViewMode] = useState<LayoutViewMode>("all")
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accelError, setAccelError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    if (!activeConnectionId) return
    setError(null)
    const catalog = await fetchWorkloadLayoutCatalog(activeConnectionId)
    if (catalog.error) {
      setCatalogReady(false)
      setError(catalog.error)
      setLoaded(true)
      return
    }
    const ready =
      !!catalog.catalog?.catalogPresent &&
      !!catalog.catalog?.statusViewPresent &&
      !!catalog.catalog?.advisorPresent
    setCatalogReady(ready)
    const [accelRes, learningRes] = await Promise.all([
      fetchAccelerationCandidates(activeConnectionId),
      fetchSystemLearningBrainStatus(activeConnectionId),
    ])
    setAccelerationCandidates(accelRes.rows)
    setAccelPgStatStatements(accelRes.pgStatStatements)
    setAccelError(accelRes.error ?? null)
    setLearningStatus(learningRes)
    if (!ready) {
      setTables([])
      setRecommendations([])
      setLoaded(true)
      return
    }
    const [tableRes, recRes] = await Promise.all([
      fetchWorkloadLayoutTables(activeConnectionId),
      fetchWorkloadLayoutRecommendations(activeConnectionId),
    ])
    setTables(tableRes.rows)
    setRecommendations(recRes.rows)
    setError(tableRes.error ?? recRes.error ?? null)
    setSelectedTable((prev) => {
      if (prev === ALL_TABLES) return prev
      return tableRes.rows.some((t) => t.tableName === prev)
        ? prev
        : ALL_TABLES
    })
    setLoaded(true)
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      setLoaded(false)
      await load()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [load])

  const visibleTables = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tables
    return tables.filter(
      (t) =>
        t.tableName.toLowerCase().includes(q) ||
        t.schema.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q),
    )
  }, [search, tables])

  const visibleAccelerationCandidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return accelerationCandidates
    return accelerationCandidates.filter(
      (t) =>
        t.tableName.toLowerCase().includes(q) ||
        t.schema.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q),
    )
  }, [accelerationCandidates, search])

  const visibleTableNames = useMemo(
    () => new Set(visibleTables.map((t) => t.tableName)),
    [visibleTables],
  )

  const scopedRecommendations = useMemo(() => {
    return selectedTable === ALL_TABLES
      ? recommendations.filter((r) => visibleTableNames.has(r.tableName))
      : recommendations.filter((r) => r.tableName === selectedTable)
  }, [recommendations, selectedTable, visibleTableNames])

  const modeStats = useMemo(() => {
    const candidates = scopedRecommendations.filter((r) => r.status === "candidate").length
    const accepted = scopedRecommendations.filter((r) => r.status === "accepted").length
    const rejected = scopedRecommendations.filter((r) => r.status === "rejected").length
    const built = scopedRecommendations.filter(isBuiltWorkloadLayout).length
    return {
      all: scopedRecommendations.length,
      candidates,
      accepted,
      rejected,
      built,
    }
  }, [scopedRecommendations])

  const visibleRecommendations = useMemo(
    () => scopedRecommendations.filter((r) => matchesViewMode(r, viewMode)),
    [scopedRecommendations, viewMode],
  )

  const visibleTablesWithMode = useMemo(() => {
    if (viewMode === "all") return visibleTables
    const tableNames = new Set(visibleRecommendations.map((r) => r.tableName))
    return visibleTables.filter((t) => tableNames.has(t.tableName))
  }, [viewMode, visibleRecommendations, visibleTables])

  const stats = useMemo(() => {
    const accepted = visibleRecommendations.filter((r) => r.status === "accepted").length
    const candidates = visibleRecommendations.filter((r) => r.status === "candidate").length
    const rejected = visibleRecommendations.filter((r) => r.status === "rejected").length
    const ready = visibleRecommendations.filter((r) => r.layoutStatus === "ready").length
    const built = visibleRecommendations.filter(isBuiltWorkloadLayout).length
    return { total: visibleRecommendations.length, accepted, candidates, rejected, ready, built }
  }, [visibleRecommendations])

  const accelStats = useMemo(() => {
    const strong = visibleAccelerationCandidates.filter((c) => c.recommendation === "strong").length
    const stable = visibleAccelerationCandidates.filter((c) => c.writeProfile === "stable" || c.writeProfile === "low churn").length
    const slowQueries = visibleAccelerationCandidates.reduce((n, c) => n + c.slowQueries, 0)
    const seqScans = visibleAccelerationCandidates.reduce((n, c) => n + c.seqScans, 0)
    return { total: visibleAccelerationCandidates.length, strong, stable, slowQueries, seqScans }
  }, [visibleAccelerationCandidates])

  const analyzeScope = useMemo(() => {
    if (selectedTable !== ALL_TABLES) return selectedTable ? [selectedTable] : []
    return visibleTables.map((t) => t.tableName)
  }, [selectedTable, visibleTables])

  const scopeTablesForMetrics = useMemo(() => {
    if (selectedTable !== ALL_TABLES) return visibleTables.filter((t) => t.tableName === selectedTable)
    return viewMode === "all" ? visibleTables : visibleTablesWithMode
  }, [selectedTable, viewMode, visibleTables, visibleTablesWithMode])

  const emptyMessage = useMemo(() => {
    switch (viewMode) {
      case "built":
        return "No accepted and built workload layouts in this scope."
      case "accepted":
        return "No accepted workload layouts in this scope."
      case "candidates":
        return "No candidate workload layout suggestions in this scope."
      default:
        return "No workload layout suggestions in this scope."
    }
  }, [viewMode])

  const syncLearningAfterAction = useCallback(async (): Promise<string | null> => {
    if (!activeConnectionId || !learningStatus?.installed || !learningStatus.sourceId || !learningStatus.enabled) return null
    const res = await syncSystemLearningBrain(activeConnectionId)
    return res.ok ? formatBrainSync(res) : "Brain sync failed"
  }, [activeConnectionId, learningStatus])

  const runMigrate = useCallback(async () => {
    if (!activeConnectionId) return
    setBusy("migrate")
    setToast(null)
    const res = await runRvbbitMigrate(activeConnectionId)
    setToast(res.ok ? { ok: true, msg: "migration complete" } : { ok: false, msg: res.error ?? "migration failed" })
    setBusy(null)
    await load()
  }, [activeConnectionId, load])

  const analyze = useCallback(async () => {
    if (!activeConnectionId || analyzeScope.length === 0) return
    setBusy("analyze")
    setToast(null)
    const results = []
    for (const table of analyzeScope) {
      results.push(
        await runWorkloadLayoutAdvisor(
          activeConnectionId,
          table,
          lookbackHours,
          minObservations,
        ),
      )
    }
    const failures = results.filter((r) => !r.ok)
    const recommended = results.reduce((n, r) => n + r.recommendations, 0)
    const matched = results.reduce((n, r) => n + r.matchedShapes, 0)
    const brainSync = failures.length ? null : await syncLearningAfterAction()
    setToast(
      failures.length
        ? { ok: false, msg: failures[0].error ?? `${failures.length} advisor run(s) failed` }
        : {
            ok: true,
            msg: `${fmtCount(recommended)} recommendation${recommended === 1 ? "" : "s"} from ${fmtCount(matched)} matched shape${matched === 1 ? "" : "s"}${brainSync ? ` · ${brainSync}` : ""}`,
          },
    )
    setBusy(null)
    await load()
  }, [activeConnectionId, analyzeScope, load, lookbackHours, minObservations, syncLearningAfterAction])

  const act = useCallback(
    async (
      rec: WorkloadLayoutRecommendation,
      action: "accept" | "reject" | "accept-build" | "build",
    ) => {
      if (!activeConnectionId) return
      setBusy(`${action}:${rec.tableName}:${rec.layout}`)
      setToast(null)
      let res: { ok: boolean; error?: string; message?: string; baseAction?: string | null }
      if (action === "build") {
        res = await refreshAcceptedWorkloadLayouts(activeConnectionId, rec.tableName)
      } else if (action === "reject") {
        res = await setWorkloadLayoutRecommendationStatus(
          activeConnectionId,
          rec.tableName,
          rec.layoutKind,
          rec.columnName,
          "rejected",
        )
      } else {
        res = await setWorkloadLayoutRecommendationStatus(
          activeConnectionId,
          rec.tableName,
          rec.layoutKind,
          rec.columnName,
          "accepted",
        )
        if (res.ok && action === "accept-build") {
          res = await refreshAcceptedWorkloadLayouts(activeConnectionId, rec.tableName)
        }
      }
      const build = isBuildRun(res) ? res : null
      const label =
        action === "reject"
          ? "rejected"
          : action === "build"
            ? build?.baseAction && build.baseAction !== "none"
              ? `built via ${build.baseAction.replace("_", " ")}`
              : "build checked"
            : action === "accept-build"
              ? build?.baseAction && build.baseAction !== "none"
                ? `accepted and built via ${build.baseAction.replace("_", " ")}`
                : "accepted and built"
                : "accepted"
      const brainSync = res.ok ? await syncLearningAfterAction() : null
      setToast(
        res.ok
          ? { ok: true, msg: `${label} · ${rec.layout}${build?.message ? ` · ${build.message}` : ""}${brainSync ? ` · ${brainSync}` : ""}` }
          : { ok: false, msg: res.error ?? build?.message ?? "action failed" },
      )
      setBusy(null)
      await load()
    },
    [activeConnectionId, load, syncLearningAfterAction],
  )

  const actAcceleration = useCallback(
    async (candidate: AccelerationCandidate, build: boolean) => {
      if (!activeConnectionId) return
      const action = build ? "enable-build" : "enable"
      setBusy(`${action}:${candidate.tableName}`)
      setToast(null)
      const res = await enableAccelerationCandidate(activeConnectionId, candidate.tableName, build)
      const brainSync = res.ok ? await syncLearningAfterAction() : null
      setToast(
        res.ok
          ? { ok: true, msg: `${build ? "enabled and built" : "enabled"} · ${candidate.tableName} · ${res.message}${brainSync ? ` · ${brainSync}` : ""}` }
          : { ok: false, msg: res.error ?? "acceleration action failed" },
      )
      setBusy(null)
      await load()
    },
    [activeConnectionId, load, syncLearningAfterAction],
  )

  const syncLearning = useCallback(async () => {
    if (!activeConnectionId || !learningStatus?.installed || !learningStatus.sourceId) return
    setBusy("sync-learning")
    setToast(null)
    const res = await syncSystemLearningBrain(activeConnectionId)
    setToast(
      res.ok
        ? {
            ok: true,
            msg: `Brain indexed learning · ${formatBrainSync(res)}`,
          }
        : { ok: false, msg: res.error ?? "system learning sync failed" },
    )
    setBusy(null)
    await load()
  }, [activeConnectionId, learningStatus, load])

  if (!loaded) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">
        <span className="inline-flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> loading workload layouts…
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-3 py-1.5 text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          {panelMode === "layouts" ? (
            <Boxes className="h-3.5 w-3.5 text-rvbbit-accent" />
          ) : (
            <Rocket className="h-3.5 w-3.5 text-rvbbit-accent" />
          )}
          {panelMode === "layouts" ? "Workload Layouts" : "Acceleration Candidates"}
        </span>
        <span className="text-chrome-text/40">·</span>
        <div className="inline-flex h-6 overflow-hidden rounded border border-chrome-border bg-secondary-background">
          {PANEL_MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              onClick={() => {
                setPanelMode(mode.key)
                if (mode.key === "accelerate") setSelectedTable(ALL_TABLES)
              }}
              className={cn(
                "border-r border-chrome-border/60 px-2 text-[10px] transition-colors last:border-r-0",
                panelMode === mode.key
                  ? "bg-rvbbit-accent/15 text-rvbbit-accent"
                  : "text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {panelMode === "layouts" ? (
          <span className="tabular-nums text-chrome-text/80">
            {fmtCount(stats.total)} shown ·{" "}
            <span className="text-rvbbit-accent">{fmtCount(stats.accepted)} accepted</span> ·{" "}
            <span className="text-success">{fmtCount(stats.built)} built</span>
          </span>
        ) : (
          <span className="tabular-nums text-chrome-text/80">
            {fmtCount(accelStats.total)} candidates ·{" "}
            <span className="text-rvbbit-accent">{fmtCount(accelStats.strong)} strong</span> ·{" "}
            <span className="text-success">{fmtCount(accelStats.stable)} low churn</span>
          </span>
        )}
        {panelMode === "layouts" && stats.candidates > 0 ? (
          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-warning">
            {fmtCount(stats.candidates)} candidate{stats.candidates === 1 ? "" : "s"}
          </span>
        ) : null}
        {panelMode === "accelerate" ? (
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-chrome-text/65">
            {accelPgStatStatements ? "query samples on" : "scan stats only"}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {panelMode === "layouts" ? (
            <>
              <div className="inline-flex h-6 overflow-hidden rounded border border-chrome-border bg-secondary-background">
                {VIEW_MODES.map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    onClick={() => setViewMode(mode.key)}
                    title={modeTitle(mode.key)}
                    className={cn(
                      "inline-flex items-center gap-1 border-r border-chrome-border/60 px-2 text-[10px] transition-colors last:border-r-0",
                      viewMode === mode.key
                        ? "bg-rvbbit-accent/15 text-rvbbit-accent"
                        : "text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground",
                    )}
                  >
                    <span>{mode.label}</span>
                    <span className="font-mono tabular-nums opacity-70">
                      {fmtCount(modeCount(mode.key, modeStats))}
                    </span>
                  </button>
                ))}
              </div>
              <select
                value={lookbackHours}
                onChange={(e) => setLookbackHours(Number(e.target.value))}
                title="Workload lookback window"
                className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {LOOKBACK_OPTIONS.map((o) => (
                  <option key={o.hours} value={o.hours}>
                    last {o.label}
                  </option>
                ))}
              </select>
              <select
                value={minObservations}
                onChange={(e) => setMinObservations(Number(e.target.value))}
                title="Minimum observations per suggested column"
                className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {MIN_OBSERVATION_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    min {n}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy === "analyze" || analyzeScope.length === 0 || !catalogReady}
                onClick={() => void analyze()}
                title={selectedTable === ALL_TABLES ? "Analyze visible tables" : "Analyze selected table"}
                className="inline-flex h-6 items-center gap-1 rounded bg-rvbbit-accent/15 px-2 font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
              >
                {busy === "analyze" ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                Analyze
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void load()}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {toast ? (
        <div
          className={cn(
            "border-b px-3 py-1 text-[11px]",
            toast.ok ? "border-success/30 bg-success/10 text-success" : "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          {toast.ok ? <Check className="mr-1 inline h-3 w-3" /> : <AlertTriangle className="mr-1 inline h-3 w-3" />}
          {toast.msg}
        </div>
      ) : null}
      {(panelMode === "layouts" ? error : accelError) ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {panelMode === "layouts" ? error : accelError}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[285px] shrink-0 flex-col border-r border-chrome-border/60 bg-foreground/[0.012]">
          <div className="border-b border-chrome-border/50 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/40" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="filter tables…"
                className="w-full rounded border border-chrome-border bg-background/70 py-1 pl-6 pr-2 text-[11px] text-foreground placeholder:text-chrome-text/40 focus:border-rvbbit-accent/60 focus:outline-none"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {panelMode === "layouts" ? (
              <>
                <button
                  type="button"
                  onClick={() => setSelectedTable(ALL_TABLES)}
                  className={cn(
                    "mb-1.5 w-full rounded border px-2.5 py-2 text-left transition-colors",
                    selectedTable === ALL_TABLES
                      ? "border-rvbbit-accent/45 bg-main/12"
                      : "border-chrome-border/45 bg-secondary-background/35 hover:bg-foreground/[0.04]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Boxes className="h-3.5 w-3.5 text-rvbbit-accent" />
                    <span className="font-medium text-foreground">All visible</span>
                    <span className="ml-auto text-[10px] tabular-nums text-chrome-text/55">{visibleTables.length}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-chrome-text/50">
                    {fmtCount(stats.total)} {viewMode === "built" ? "built" : "shown"} in scope
                  </div>
                </button>

                {visibleTables.length === 0 ? (
                  <div className="grid h-20 place-items-center text-center text-[11px] text-chrome-text/45">
                    No tables match “{search.trim()}”.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {visibleTables.map((table) => (
                      <TableButton
                        key={table.tableName}
                        table={table}
                        selected={selectedTable === table.tableName}
                        onClick={() => setSelectedTable(table.tableName)}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="mb-1.5 rounded border border-rvbbit-accent/35 bg-main/12 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <Target className="h-3.5 w-3.5 text-rvbbit-accent" />
                    <span className="font-medium text-foreground">All candidates</span>
                    <span className="ml-auto text-[10px] tabular-nums text-chrome-text/55">{visibleAccelerationCandidates.length}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-chrome-text/50">
                    ranked heap tables not currently accelerated
                  </div>
                </div>
                {visibleAccelerationCandidates.length === 0 ? (
                  <div className="grid h-20 place-items-center text-center text-[11px] text-chrome-text/45">
                    No acceleration candidates match “{search.trim()}”.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {visibleAccelerationCandidates.map((candidate) => (
                      <AccelerationCandidateButton key={candidate.tableName} candidate={candidate} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-auto p-2.5">
          {panelMode === "layouts" ? (
            !catalogReady ? (
              <div className="grid h-full min-h-72 place-items-center rounded-md border border-dashed border-chrome-border/70 bg-secondary-background/20 p-6 text-center text-[12px] text-chrome-text/70">
                <div className="max-w-sm">
                  <Boxes className="mx-auto mb-2 h-6 w-6 text-chrome-text/35" />
                  <div className="font-medium text-foreground">Workload layout advisor is not installed.</div>
                  <button
                    type="button"
                    disabled={busy === "migrate"}
                    onClick={() => void runMigrate()}
                    className="mt-3 inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2.5 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
                  >
                    {busy === "migrate" ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                    Run migrate
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
                  <Panel icon={Table2} title="Scope">
                    <div className="grid grid-cols-3 gap-2">
                      <Metric label="tables" value={fmtCount(scopeTablesForMetrics.length)} />
                      <Metric label="slow scans" value={fmtCount(scopeSlowScans(scopeTablesForMetrics))} />
                      <Metric label="row groups" value={fmtCount(scopeRowGroups(scopeTablesForMetrics))} />
                    </div>
                  </Panel>
                  <Panel icon={Check} title="Accepted">
                    <div className="grid grid-cols-3 gap-2">
                      <Metric label="accepted" value={fmtCount(stats.accepted)} />
                      <Metric label="built" value={fmtCount(stats.built)} tone={stats.built > 0 ? undefined : "muted"} />
                      <Metric label="rejected" value={fmtCount(stats.rejected)} tone="muted" />
                    </div>
                  </Panel>
                  <LearningBrainPanel status={learningStatus} busy={busy === "sync-learning"} onSync={() => void syncLearning()} />
                  <LearningLoopPanel
                    mode="layouts"
                    recommendations={visibleRecommendations}
                    layoutStats={stats}
                    accelStats={accelStats}
                    learningStatus={learningStatus}
                  />
                </div>

                {visibleRecommendations.length === 0 ? (
                  <div className="mt-2.5 grid h-48 place-items-center rounded-md border border-dashed border-chrome-border/70 bg-secondary-background/25 text-center text-[12px] text-chrome-text/55">
                    <div>
                      <Sparkles className="mx-auto mb-2 h-5 w-5 text-chrome-text/35" />
                      {emptyMessage}
                    </div>
                  </div>
                ) : (
                  <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(24rem,1fr))] gap-2.5">
                    {visibleRecommendations.map((rec) => (
                      <RecommendationCard
                        key={`${rec.tableName}:${rec.layout}`}
                        rec={rec}
                        busy={busy != null}
                        onAction={(action) => void act(rec, action)}
                      />
                    ))}
                  </div>
                )}
              </>
            )
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
                <Panel icon={Target} title="Candidates">
                  <div className="grid grid-cols-3 gap-2">
                    <Metric label="tables" value={fmtCount(accelStats.total)} />
                    <Metric label="strong" value={fmtCount(accelStats.strong)} tone={accelStats.strong > 0 ? undefined : "muted"} />
                    <Metric label="low churn" value={fmtCount(accelStats.stable)} tone={accelStats.stable > 0 ? undefined : "muted"} />
                  </div>
                </Panel>
                <Panel icon={TrendingUp} title="Observed Pain">
                  <div className="grid grid-cols-3 gap-2">
                    <Metric label="query samples" value={fmtCount(accelStats.slowQueries)} tone={accelPgStatStatements ? undefined : "muted"} />
                    <Metric label="seq scans" value={fmtCount(accelStats.seqScans)} />
                    <Metric label="source" value={accelPgStatStatements ? "pg_stat" : "table stats"} tone="muted" />
                  </div>
                </Panel>
                <LearningBrainPanel status={learningStatus} busy={busy === "sync-learning"} onSync={() => void syncLearning()} />
                <LearningLoopPanel
                  mode="accelerate"
                  recommendations={visibleRecommendations}
                  layoutStats={stats}
                  accelStats={accelStats}
                  learningStatus={learningStatus}
                />
              </div>

              {visibleAccelerationCandidates.length === 0 ? (
                <div className="mt-2.5 grid h-48 place-items-center rounded-md border border-dashed border-chrome-border/70 bg-secondary-background/25 text-center text-[12px] text-chrome-text/55">
                  <div>
                    <Rocket className="mx-auto mb-2 h-5 w-5 text-chrome-text/35" />
                    No heap-table acceleration candidates in this scope.
                  </div>
                </div>
              ) : (
                <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(25rem,1fr))] gap-2.5">
                  {visibleAccelerationCandidates.map((candidate) => (
                    <AccelerationCandidateCard
                      key={candidate.tableName}
                      candidate={candidate}
                      busy={busy != null}
                      querySamplesAvailable={accelPgStatStatements}
                      onAction={(build) => void actAcceleration(candidate, build)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function TableButton({
  table,
  selected,
  onClick,
}: {
  table: WorkloadLayoutTable
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded border px-2.5 py-2 text-left transition-colors",
        selected
          ? "border-rvbbit-accent/45 bg-main/12"
          : "border-chrome-border/45 bg-secondary-background/35 hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Database className={cn("h-3.5 w-3.5 shrink-0", table.dirty ? "text-warning" : "text-rvbbit-accent/80")} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={table.tableName}>
          {table.name}
        </span>
        {table.opRunning ? <RefreshCw className="h-3 w-3 animate-spin text-rvbbit-accent" /> : null}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] tabular-nums text-chrome-text/50">
        <span>{table.schema}</span>
        <span className="text-chrome-text/25">·</span>
        <span>{fmtCount(table.rowGroups)} rg</span>
        {table.heapSeqScans > 0 ? (
          <>
            <span className="text-chrome-text/25">·</span>
            <span className="text-warning">{fmtCount(table.heapSeqScans)} slow</span>
          </>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-1">
        {table.recommendations > 0 ? (
          <MiniPill tone="accent">{fmtCount(table.recommendations)} suggested</MiniPill>
        ) : null}
        {table.accepted > 0 ? <MiniPill tone="success">{fmtCount(table.accepted)} accepted</MiniPill> : null}
        {table.ready > 0 ? <MiniPill tone="ready">{fmtCount(table.ready)} ready</MiniPill> : null}
      </div>
    </button>
  )
}

function AccelerationCandidateButton({ candidate }: { candidate: AccelerationCandidate }) {
  return (
    <div className="rounded border border-chrome-border/45 bg-secondary-background/35 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Rocket className={cn("h-3.5 w-3.5 shrink-0", scoreTone(candidate.recommendation))} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={candidate.tableName}>
          {candidate.name}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-chrome-text/60">{candidate.score.toFixed(0)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] tabular-nums text-chrome-text/50">
        <span>{candidate.schema}</span>
        <span className="text-chrome-text/25">·</span>
        <span>{fmtCount(candidate.seqScans)} scans</span>
        <span className="text-chrome-text/25">·</span>
        <span className={churnTone(candidate.writeProfile)}>{candidate.writeProfile}</span>
      </div>
    </div>
  )
}

function AccelerationCandidateCard({
  candidate,
  busy,
  querySamplesAvailable,
  onAction,
}: {
  candidate: AccelerationCandidate
  busy: boolean
  querySamplesAvailable: boolean
  onAction: (build: boolean) => void
}) {
  return (
    <article className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
      <div className="flex items-start gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded border border-chrome-border/60 bg-foreground/[0.04]">
          <Rocket className={cn("h-3.5 w-3.5", scoreTone(candidate.recommendation))} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-[12px] font-semibold text-foreground" title={candidate.tableName}>
              {candidate.tableName}
            </span>
            <CandidatePill kind={candidate.recommendation} />
            <span className={cn("rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider", churnBadge(candidate.writeProfile))}>
              {candidate.writeProfile}
            </span>
            {candidate.registered ? (
              <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
                disabled
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-chrome-text/45" title={candidate.reason}>
            {candidate.reason || "scan-heavy table"}
          </div>
        </div>
        <div className="text-right font-mono tabular-nums">
          <div className="text-[13px] text-foreground">{candidate.score.toFixed(0)}</div>
          <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">score</div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Metric label="query samples" value={fmtCount(candidate.slowQueries)} tone={querySamplesAvailable ? undefined : "muted"} />
        <Metric label="seq scans" value={fmtCount(candidate.seqScans)} />
        <Metric label="rows read" value={fmtCount(candidate.seqRows)} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Metric label="rows" value={fmtCount(candidate.rowEstimate)} />
        <Metric label="size" value={fmtBytes(candidate.sizeBytes)} />
        <Metric label="writes" value={fmtCount(candidate.writes)} tone={candidate.writes > 0 ? undefined : "muted"} />
      </div>

      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-3 gap-y-1 border-t border-chrome-border/45 pt-2 text-[10px]">
        <Info label="total query ms" value={candidate.totalMs > 0 ? fmtMs(candidate.totalMs) : "not sampled"} mono />
        <Info label="max mean ms" value={candidate.maxMeanMs == null ? "not sampled" : fmtMs(candidate.maxMeanMs)} mono />
        <Info label="write ratio" value={fmtPercent(candidate.mutationRatio)} mono />
        <Info label="read/write" value={candidate.writes === 0 ? "read-only" : fmtCount(candidate.readWriteRatio)} mono />
        <Info label="modified" value={fmtCount(candidate.modSinceAnalyze)} mono />
        <Info label="maintained" value={candidate.lastMaintenanceAt ? fmtAgo(candidate.lastMaintenanceAt) : "unknown"} />
      </div>

      {candidate.querySamples.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-chrome-border/45 pt-2">
          {candidate.querySamples.map((sql, i) => (
            <div key={i} className="truncate rounded bg-foreground/[0.04] px-2 py-1 font-mono text-[10px] text-chrome-text/65" title={sql}>
              {sql}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-chrome-border/45 pt-2">
        <span className="inline-flex items-center gap-1 text-[10px] text-chrome-text/45">
          <Target className="h-2.5 w-2.5" />
          table remains heap-backed; acceleration can be refreshed independently
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(false)}
            title="Register this heap table for rvbbit acceleration"
            className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-2 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <Check className="h-3 w-3" /> Enable
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction(true)}
            title="Register this table and run refresh_acceleration"
            className="inline-flex h-6 items-center gap-1 rounded bg-rvbbit-accent/15 px-2 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
          >
            <Zap className="h-3 w-3" /> Enable + Build
          </button>
        </div>
      </div>
    </article>
  )
}

function LearningBrainPanel({
  status,
  busy,
  onSync,
}: {
  status: SystemLearningBrainStatus | null
  busy: boolean
  onSync: () => void
}) {
  const installed = !!status?.installed && !!status.sourceId
  const ready = installed && status.enabled && status.docs > 0
  const statusLabel = !status ? "checking" : ready ? "agent ready" : installed ? (status.enabled ? "needs sync" : "paused") : status.error ? "error" : "missing"
  const statusClass = ready ? "text-success" : status?.error ? "text-danger" : installed ? "text-rvbbit-accent" : "text-chrome-text/55"
  const lastActivity = status?.lastSyncedAt ?? status?.lastRunAt
  return (
    <Panel
      icon={Brain}
      title="Brain"
      right={
        <span className={cn("font-mono text-[10px] uppercase", statusClass)} title={status?.error ?? undefined}>
          {statusLabel}
        </span>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <Metric label="items" value={status ? fmtCount(status.indexedItems) : "—"} tone={installed ? undefined : "muted"} />
        <Metric label="docs" value={status ? fmtCount(status.docs) : "—"} tone={status?.docs ? undefined : "muted"} />
        <Metric label="synced" value={lastActivity ? fmtAgo(lastActivity) : "never"} tone={lastActivity ? undefined : "muted"} />
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-chrome-border/45 pt-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] tabular-nums text-chrome-text/55">
          +{fmtCount(status?.lastRunAdded ?? 0)} / ~{fmtCount(status?.lastRunChanged ?? 0)} / skip {fmtCount(status?.lastRunSkipped ?? 0)}
        </span>
        <button
          type="button"
          disabled={!installed || busy}
          onClick={onSync}
          title={installed ? "Sync RVBBIT system learning into Brain" : "Run migrate to install RVBBIT System Learning"}
          className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-2 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
          Sync
        </button>
      </div>
    </Panel>
  )
}

function LearningLoopPanel({
  mode,
  recommendations,
  layoutStats,
  accelStats,
  learningStatus,
}: {
  mode: PanelMode
  recommendations: WorkloadLayoutRecommendation[]
  layoutStats: { total: number; accepted: number; candidates: number; rejected: number; ready: number; built: number }
  accelStats: { total: number; strong: number; stable: number; slowQueries: number; seqScans: number }
  learningStatus: SystemLearningBrainStatus | null
}) {
  const observations = recommendations.reduce((n, rec) => n + rec.observations, 0)
  const shapes = new Set(recommendations.flatMap((rec) => rec.sampleShapes)).size
  const learningReady = !!learningStatus?.installed && learningStatus.enabled && learningStatus.docs > 0
  const learningItems = learningStatus?.indexedItems ?? 0
  const learningDocs = learningStatus?.docs ?? 0
  const learningKinds = (learningStatus?.groups ?? []).filter((g) => g.items > 0).length
  const steps =
    mode === "layouts"
      ? [
          {
            key: "observed",
            icon: Activity,
            label: "Observed",
            value: observations,
            detail: `${fmtCount(shapes)} shape${shapes === 1 ? "" : "s"}`,
            active: observations > 0,
          },
          {
            key: "suggested",
            icon: Sparkles,
            label: "Suggested",
            value: layoutStats.total,
            detail: `${fmtCount(layoutStats.candidates)} candidate${layoutStats.candidates === 1 ? "" : "s"}`,
            active: layoutStats.total > 0,
          },
          {
            key: "accepted",
            icon: Check,
            label: "Accepted",
            value: layoutStats.accepted,
            detail: `${fmtCount(layoutStats.rejected)} rejected`,
            active: layoutStats.accepted > 0,
          },
          {
            key: "built",
            icon: Hammer,
            label: "Built",
            value: layoutStats.built,
            detail: `${fmtCount(layoutStats.ready)} ready`,
            active: layoutStats.built > 0,
          },
          {
            key: "brain",
            icon: Brain,
            label: "Brain",
            value: learningDocs,
            detail: `${fmtCount(learningItems)} item${learningItems === 1 ? "" : "s"}`,
            active: learningReady,
          },
        ]
      : [
          {
            key: "observed",
            icon: Activity,
            label: "Observed",
            value: accelStats.slowQueries || accelStats.seqScans,
            detail: accelStats.slowQueries > 0 ? `${fmtCount(accelStats.seqScans)} seq scans` : "scan stats",
            active: accelStats.slowQueries > 0 || accelStats.seqScans > 0,
          },
          {
            key: "candidates",
            icon: Target,
            label: "Candidates",
            value: accelStats.total,
            detail: "heap tables",
            active: accelStats.total > 0,
          },
          {
            key: "stable",
            icon: Clock,
            label: "Stable",
            value: accelStats.stable,
            detail: "low churn",
            active: accelStats.stable > 0,
          },
          {
            key: "strong",
            icon: Rocket,
            label: "Strong",
            value: accelStats.strong,
            detail: "ranked high",
            active: accelStats.strong > 0,
          },
          {
            key: "brain",
            icon: Brain,
            label: "Brain",
            value: learningDocs,
            detail: `${fmtCount(learningItems)} item${learningItems === 1 ? "" : "s"}`,
            active: learningReady,
          },
        ]
  const maxValue = Math.max(1, ...steps.map((step) => step.value))
  const rightLabel = learningReady
    ? "ask_system_learning"
    : learningStatus?.installed
      ? "sync pending"
      : "not installed"

  return (
    <Panel
      icon={Activity}
      title="Learning Loop"
      className="col-span-full"
      right={
        <span className={cn("font-mono text-[10px]", learningReady ? "text-success" : "text-chrome-text/55")}>
          {rightLabel}
        </span>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-3">
        {steps.map((step, index) => (
          <LearningLoopStep
            key={step.key}
            icon={step.icon}
            label={step.label}
            value={step.value}
            detail={step.detail}
            active={step.active}
            maxValue={maxValue}
            showConnector={index < steps.length - 1}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-chrome-border/40 pt-2 text-[10px] text-chrome-text/55">
        {(learningStatus?.groups ?? []).slice(0, 6).map((g) => (
          <span key={g.objectType} className="font-mono tabular-nums">
            {g.objectType.replace(/_/g, " ")} {fmtCount(g.items)}
          </span>
        ))}
        {learningKinds === 0 ? <span>no Brain artifacts synced</span> : null}
      </div>
    </Panel>
  )
}

function LearningLoopStep({
  icon: Icon,
  label,
  value,
  detail,
  active,
  maxValue,
  showConnector,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: number
  detail: string
  active: boolean
  maxValue: number
  showConnector: boolean
}) {
  const pct = Math.max(4, Math.round((value / Math.max(1, maxValue)) * 100))
  return (
    <div className="relative min-w-0">
      {showConnector ? (
        <div className="pointer-events-none absolute left-[calc(100%+0.25rem)] top-3 hidden h-px w-2 bg-chrome-border/60 md:block" />
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-rvbbit-accent" : "text-chrome-text/35")} />
        <span className="min-w-0 truncate text-[10px] uppercase tracking-wider text-chrome-text/65">
          {label}
        </span>
        <span className={cn("ml-auto font-mono text-[12px] tabular-nums", active ? "text-foreground" : "text-chrome-text/45")}>
          {fmtCount(value)}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
        <div
          className={cn("h-full rounded-full", active ? "bg-rvbbit-accent" : "bg-chrome-border")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-chrome-text/45" title={detail}>
        {detail}
      </div>
    </div>
  )
}

function RecommendationCard({
  rec,
  busy,
  onAction,
}: {
  rec: WorkloadLayoutRecommendation
  busy: boolean
  onAction: (action: "accept" | "reject" | "accept-build" | "build") => void
}) {
  const Icon = rec.layoutKind === "hive" ? Boxes : SortAscending
  const nDistinct = formatDetail(rec.details.n_distinct)
  const pgType = formatDetail(rec.details.pg_type_oid)
  const ready = rec.layoutStatus === "ready"
  return (
    <article className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
      <div className="flex items-start gap-2">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded border border-chrome-border/60 bg-foreground/[0.04]">
          <Icon className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-[12px] font-semibold text-foreground" title={rec.layout}>
              {rec.layout}
            </span>
            <LayoutKindPill kind={rec.layoutKind} />
            <StatusChip status={rec.status} />
            <LayoutStatusChip status={rec.layoutStatus} />
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-chrome-text/45" title={rec.tableName}>
            {rec.tableName}
          </div>
        </div>
        <div className="text-right font-mono tabular-nums">
          <div className="text-[13px] text-foreground">{fmtScore(rec.score)}</div>
          <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">score</div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Metric label="observations" value={fmtCount(rec.observations)} />
        <Metric label="weighted" value={fmtMs(rec.weightedMs)} />
        <Metric label="shapes" value={fmtCount(rec.sampleShapes.length)} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <RoleChip label="where" value={rec.roleCounts.where} />
        <RoleChip label="group" value={rec.roleCounts.groupBy} />
        <RoleChip label="order" value={rec.roleCounts.orderBy} />
        <RoleChip label="distinct" value={rec.roleCounts.countDistinct} />
      </div>

      <RecommendationEvidence rec={rec} nDistinct={nDistinct} />

      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-3 gap-y-1 border-t border-chrome-border/45 pt-2 text-[10px]">
        <Info label="reason" value={rec.reason} />
        <Info label="column" value={rec.columnName} mono />
        <Info label="type oid" value={pgType} mono />
        <Info label="n_distinct" value={nDistinct} mono />
        <Info label="files" value={rec.layoutFiles == null ? "not built" : fmtCount(rec.layoutFiles)} />
        <Info label="rows" value={rec.layoutRows == null ? "not built" : fmtCount(rec.layoutRows)} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-chrome-border/45 pt-2">
        <span className="inline-flex items-center gap-1 text-[10px] text-chrome-text/45">
          <Clock className="h-2.5 w-2.5" />
          {rec.updatedAt ? fmtAgo(rec.updatedAt) : "never"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {rec.status !== "accepted" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("accept")}
              title="Accept this layout recommendation"
              className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-2 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            >
              <Check className="h-3 w-3" /> Accept
            </button>
          ) : null}
          {rec.status !== "rejected" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("reject")}
              title="Reject this layout recommendation"
              className="grid h-6 w-6 place-items-center rounded border border-chrome-border text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {rec.status === "accepted" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("build")}
              title={ready ? "Refresh this accepted layout" : "Build this accepted layout"}
              className="inline-flex h-6 items-center gap-1 rounded bg-rvbbit-accent/15 px-2 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
            >
              <Hammer className="h-3 w-3" /> {ready ? "Refresh" : "Build"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction("accept-build")}
              title="Accept this recommendation and run refresh_acceleration"
              className="inline-flex h-6 items-center gap-1 rounded bg-rvbbit-accent/15 px-2 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
            >
              <Zap className="h-3 w-3" /> Accept + Build
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

function RecommendationEvidence({
  rec,
  nDistinct,
}: {
  rec: WorkloadLayoutRecommendation
  nDistinct: string
}) {
  const roles = [
    { label: "where", value: rec.roleCounts.where },
    { label: "group", value: rec.roleCounts.groupBy },
    { label: "order", value: rec.roleCounts.orderBy },
    { label: "distinct", value: rec.roleCounts.countDistinct },
  ].filter((r) => r.value > 0)
  const maxRole = Math.max(1, ...roles.map((r) => r.value))
  const askHandle = `${rec.tableName} ${rec.columnName} ${rec.layoutKind} layout recommendation`
  return (
    <div className="mt-2 rounded border border-chrome-border/45 bg-doc-bg/35 p-2">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/40">Clause evidence</div>
          {roles.length === 0 ? (
            <div className="font-mono text-[10px] text-chrome-text/40">no clause roles recorded</div>
          ) : (
            <div className="space-y-1">
              {roles.map((role) => (
                <div key={role.label} className="grid grid-cols-[3.75rem_minmax(0,1fr)_2.5rem] items-center gap-1.5">
                  <span className="font-mono text-[10px] text-chrome-text/60">{role.label}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                    <div
                      className="h-full rounded-full bg-rvbbit-accent"
                      style={{ width: `${Math.max(6, Math.round((role.value / maxRole) * 100))}%` }}
                    />
                  </div>
                  <span className="text-right font-mono text-[10px] tabular-nums text-foreground/80">
                    {fmtCount(role.value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/40">Shape samples</div>
          <div className="flex min-w-0 flex-wrap gap-1">
            {rec.sampleShapes.length === 0 ? (
              <span className="font-mono text-[10px] text-chrome-text/40">none captured</span>
            ) : (
              rec.sampleShapes.slice(0, 3).map((shape) => (
                <span
                  key={shape}
                  className="max-w-full truncate rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-chrome-text/70"
                  title={shape}
                >
                  {shortShape(shape)}
                </span>
              ))
            )}
            {rec.sampleShapes.length > 3 ? (
              <span className="rounded bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-chrome-text/45">
                +{rec.sampleShapes.length - 3}
              </span>
            ) : null}
          </div>
          <div className="mt-1 truncate font-mono text-[9px] text-chrome-text/40" title={askHandle}>
            ask_system_learning · {askHandle}
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-3 gap-1.5">
          <EvidenceMetric label="score" value={fmtScore(rec.score)} />
          <EvidenceMetric label="weighted" value={fmtMs(rec.weightedMs)} />
          <EvidenceMetric label="ndv" value={nDistinct} />
        </div>
      </div>
    </div>
  )
}

function EvidenceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded bg-foreground/[0.04] px-1.5 py-1">
      <div className="truncate font-mono text-[11px] tabular-nums text-foreground" title={value}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-[8px] uppercase tracking-wider text-chrome-text/40">
        {label}
      </div>
    </div>
  )
}

function formatBrainSync(res: SystemLearningBrainSync): string {
  return `Brain +${fmtCount(res.added)} / ~${fmtCount(res.changed)} / skip ${fmtCount(res.skipped)}`
}

function shortShape(shape: string): string {
  if (!shape) return "shape"
  const parts = shape.split("|").filter(Boolean)
  const interesting = parts.filter((p) => !p.endsWith("=0") && !p.endsWith("=false")).slice(0, 3)
  const text = (interesting.length ? interesting : parts.slice(0, 2)).join(" · ")
  return text.length > 56 ? `${text.slice(0, 53)}...` : text || shape.slice(0, 56)
}

function LayoutKindPill({ kind }: { kind: WorkloadLayoutKind }) {
  return (
    <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/65">
      {kind}
    </span>
  )
}

function StatusChip({ status }: { status: WorkloadLayoutRecommendation["status"] }) {
  const cls =
    status === "accepted"
      ? "bg-rvbbit-accent/15 text-rvbbit-accent"
      : status === "rejected"
        ? "bg-foreground/[0.06] text-chrome-text/45"
        : status === "retired"
          ? "bg-danger/10 text-danger"
          : "bg-warning/10 text-warning"
  return <span className={cn("rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider", cls)}>{status}</span>
}

function LayoutStatusChip({ status }: { status: string | null }) {
  if (!status) {
    return <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/40">not built</span>
  }
  const ready = status === "ready"
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
        ready ? "bg-success/15 text-success" : "bg-warning/10 text-warning",
      )}
    >
      {status}
    </span>
  )
}

function RoleChip({ label, value }: { label: string; value: number }) {
  if (value <= 0) return null
  return (
    <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] text-chrome-text/70">
      {label} <span className="font-mono tabular-nums text-foreground/85">{fmtCount(value)}</span>
    </span>
  )
}

function MiniPill({ tone, children }: { tone: "accent" | "success" | "ready"; children: ReactNode }) {
  const cls =
    tone === "success"
      ? "bg-rvbbit-accent/15 text-rvbbit-accent"
      : tone === "ready"
        ? "bg-success/15 text-success"
        : "bg-foreground/[0.06] text-chrome-text/65"
  return <span className={cn("rounded px-1.5 py-0.5 text-[9px] tabular-nums", cls)}>{children}</span>
}

function CandidatePill({ kind }: { kind: AccelerationCandidate["recommendation"] }) {
  const cls =
    kind === "strong"
      ? "bg-rvbbit-accent/15 text-rvbbit-accent"
      : kind === "watch"
        ? "bg-warning/10 text-warning"
        : "bg-foreground/[0.06] text-chrome-text/55"
  return <span className={cn("rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider", cls)}>{kind}</span>
}

function scoreTone(kind: AccelerationCandidate["recommendation"]): string {
  if (kind === "strong") return "text-rvbbit-accent"
  if (kind === "watch") return "text-warning"
  return "text-chrome-text/55"
}

function churnTone(profile: string): string {
  if (profile === "stable" || profile === "low churn") return "text-success"
  if (profile === "moderate churn") return "text-warning"
  return "text-danger"
}

function churnBadge(profile: string): string {
  if (profile === "stable" || profile === "low churn") return "bg-success/15 text-success"
  if (profile === "moderate churn") return "bg-warning/10 text-warning"
  return "bg-danger/10 text-danger"
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/40">{label}</div>
      <div className={cn("truncate text-chrome-text/80", mono && "font-mono tabular-nums")} title={value}>
        {value || "—"}
      </div>
    </div>
  )
}

function fmtScore(score: number): string {
  if (!Number.isFinite(score)) return "0"
  if (score >= 1000) return fmtCount(score)
  return score >= 100 ? score.toFixed(0) : score.toFixed(1)
}

function fmtPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%"
  if (value < 0.01) return "<1%"
  return `${Math.min(999, value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
}

function formatDetail(value: unknown): string {
  if (value == null || value === "") return "—"
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  return String(value)
}

function isBuiltWorkloadLayout(rec: WorkloadLayoutRecommendation): boolean {
  return rec.status === "accepted" && rec.layoutStatus === "ready"
}

function isBuildRun(res: { ok: boolean; error?: string; message?: string }): res is WorkloadLayoutBuildRun {
  return "status" in res && "layoutRows" in res
}

function matchesViewMode(rec: WorkloadLayoutRecommendation, mode: LayoutViewMode): boolean {
  switch (mode) {
    case "built":
      return isBuiltWorkloadLayout(rec)
    case "accepted":
      return rec.status === "accepted"
    case "candidates":
      return rec.status === "candidate"
    default:
      return true
  }
}

function modeCount(
  mode: LayoutViewMode,
  stats: Record<LayoutViewMode, number> & { rejected: number },
): number {
  return stats[mode]
}

function modeTitle(mode: LayoutViewMode): string {
  switch (mode) {
    case "built":
      return "Show recommendations that were accepted and have a ready layout variant"
    case "accepted":
      return "Show accepted workload layout recommendations"
    case "candidates":
      return "Show candidate workload layout recommendations"
    default:
      return "Show all workload layout recommendations"
  }
}

function scopeSlowScans(tables: WorkloadLayoutTable[]): number {
  return tables.reduce((n, t) => n + t.heapSeqScans, 0)
}

function scopeRowGroups(tables: WorkloadLayoutTable[]): number {
  return tables.reduce((n, t) => n + t.rowGroups, 0)
}
