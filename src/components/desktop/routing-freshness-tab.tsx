"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  Clock,
  Database,
  Hammer,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  Wrench,
  Zap,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount, fmtMs, loadColor } from "./instruments"
import {
  ACCEL_STRATEGIES,
  accelRebuildSql,
  accelRefreshSql,
  clearAccelPolicySql,
  execAccel,
  fetchAccelFreshness,
  fetchAccelTickPlan,
  recommendPolicy,
  runAccelTickSql,
  setAccelPolicySql,
  setTableEngineSql,
  TOGGLE_ENGINES,
  TOGGLE_LAYOUTS,
  type AccelFreshnessRow,
  type AccelStrategy,
  type AccelTickPlanRow,
} from "@/lib/rvbbit/routing"

interface Props {
  activeConnectionId: string | null
}

type LaneState = "fresh" | "dirty" | "catching-up" | "backoff"

function isFinalLockBackoff(row: AccelFreshnessRow): boolean {
  const error = (row.lastOperationError ?? "").toLowerCase()
  return (
    row.dirty &&
    row.lastOperationStatus === "noop" &&
    (row.lastOperationSwap === "skipped_final_lock_busy" || error.includes("final lock busy"))
  )
}

/**
 * OLAP autopilot cockpit — the accelerator-management view of Adaptive Routing.
 * A lagging accelerator is correctness-safe; this surface is about keeping the
 * file layer useful without forcing writers to wait for maintenance.
 */
export function RoutingFreshnessTab({ activeConnectionId }: Props) {
  const [rows, setRows] = useState<AccelFreshnessRow[]>([])
  const [plan, setPlan] = useState<Map<string, AccelTickPlanRow>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [busyTable, setBusyTable] = useState<string | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (!activeConnectionId) return
    const [fresh, p] = await Promise.all([
      fetchAccelFreshness(activeConnectionId),
      fetchAccelTickPlan(activeConnectionId, null),
    ])
    setError(fresh.error ?? p.error ?? null)
    setRows(fresh.rows)
    setPlan(new Map(p.rows.map((r) => [r.tableName, r])))
    setLoaded(true)
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled || !activeConnectionId) return
      await load()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, load])

  const act = useCallback(
    async (table: string, sql: string, label: string) => {
      if (!activeConnectionId) return
      setBusyTable(table)
      setToast(null)
      const res = await execAccel(activeConnectionId, sql)
      setToast(
        res.ok
          ? { ok: true, msg: `${label} · ${table}` }
          : { ok: false, msg: res.error ?? "failed" },
      )
      setBusyTable(null)
      await load()
    },
    [activeConnectionId, load],
  )

  const runTick = useCallback(async () => {
    if (!activeConnectionId) return
    setBusyTable("__tick__")
    setToast(null)
    const res = await execAccel(activeConnectionId, runAccelTickSql(8))
    setToast(res.ok ? { ok: true, msg: "ran OLAP autopilot" } : { ok: false, msg: res.error ?? "failed" })
    setBusyTable(null)
    await load()
  }, [activeConnectionId, load])

  const stats = useMemo(() => {
    const dirty = rows.filter((r) => r.dirty).length
    const running = rows.filter((r) => r.opRunning).length
    const backedOff = rows.filter(isFinalLockBackoff).length
    const planned = [...plan.values()].filter((p) => p.status === "planned")
    const wouldAct = planned.length
    const wouldFold = planned.filter((p) => p.action === "full").length
    const automated = rows.filter((r) => r.explicit && r.strategy !== "manual" && r.active).length
    return { total: rows.length, dirty, running, backedOff, wouldAct, wouldFold, automated }
  }, [rows, plan])

  // ── Schema grouping + search (navigate schemas with 100s–1000s of tables) ──
  const [search, setSearch] = useState("")
  const [collapsedOverride, setCollapsedOverride] = useState<Set<string> | null>(null)

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? rows.filter((r) => r.tableName.toLowerCase().includes(q) || r.schema.toLowerCase().includes(q))
      : rows
    const bySchema = new Map<string, AccelFreshnessRow[]>()
    for (const r of filtered) {
      const s = r.schema || "(none)"
      const arr = bySchema.get(s)
      if (arr) arr.push(r)
      else bySchema.set(s, [r])
    }
    return [...bySchema.entries()].map(([schema, list]) => ({
      schema,
      list,
      count: list.length,
      dirty: list.filter((r) => r.dirty).length,
      automated: list.filter((r) => r.explicit && r.strategy !== "manual" && r.active).length,
      running: list.filter((r) => r.opRunning).length,
      backedOff: list.filter(isFinalLockBackoff).length,
      totalRows: list.reduce((n, r) => n + (r.parquetRows || 0), 0),
    }))
  }, [rows, search])

  const filteredCount = useMemo(() => groups.reduce((n, g) => n + g.count, 0), [groups])

  // Default-collapse all schemas on first load when there are many tables, so the
  // landing view is the schema list (a navigable overview) rather than a huge scroll.
  const collapsed = useMemo(
    () =>
      collapsedOverride ??
      (loaded && rows.length > 40
        ? new Set(rows.map((r) => r.schema || "(none)"))
        : new Set<string>()),
    [collapsedOverride, loaded, rows],
  )

  const toggleSchema = useCallback((schema: string) => {
    setCollapsedOverride((prev) => {
      const base = prev ?? collapsed
      const next = new Set(base)
      if (base.has(schema)) next.delete(schema)
      else next.add(schema)
      return next
    })
  }, [collapsed])
  const collapseAll = useCallback(
    () => setCollapsedOverride(new Set(rows.map((r) => r.schema || "(none)"))),
    [rows],
  )
  const expandAll = useCallback(() => setCollapsedOverride(new Set()), [])

  if (!loaded) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">
        <span className="inline-flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> loading OLAP maintenance…
        </span>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/60">
        <div>
          <Database className="mx-auto mb-2 h-6 w-6 text-chrome-text/30" />
          No accelerated rvbbit tables yet. Create or refresh an accelerator from a table to start.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-3 py-1.5 text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Activity className="h-3.5 w-3.5 text-rvbbit-accent" /> OLAP Autopilot
        </span>
        <span className="text-chrome-text/40">·</span>
        <span className="tabular-nums text-chrome-text/80">
          {stats.total} accelerated · <span className={stats.dirty ? "text-warning" : ""}>{stats.dirty} dirty</span> ·{" "}
          {stats.automated} automated
        </span>
        {stats.running > 0 ? <span className="text-rvbbit-accent">{stats.running} catching up</span> : null}
        {stats.backedOff > 0 ? <span className="text-warning">{stats.backedOff} backing off</span> : null}
        {stats.wouldAct > 0 ? (
          <span className="rounded-full bg-rvbbit-accent/15 px-2 py-0.5 text-rvbbit-accent">
            next tick: {stats.wouldAct}
            {stats.wouldFold > 0 ? ` · fold ${stats.wouldFold}` : ""}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={busyTable === "__tick__"}
            onClick={() => void runTick()}
            title="Run the policy-driven OLAP maintenance executor now (budget 8)"
            className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2 py-1 font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
          >
            <Zap className="h-3 w-3" /> Run autopilot
          </button>
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

      {/* schema search + collapse controls */}
      <div className="flex items-center gap-2 border-b border-chrome-border/60 bg-chrome-bg/15 px-3 py-1 text-[11px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter tables…"
            className="w-48 rounded border border-chrome-border bg-background/70 py-0.5 pl-6 pr-2 text-[11px] text-foreground placeholder:text-chrome-text/40 focus:border-rvbbit-accent/60 focus:outline-none"
          />
        </div>
        {search.trim() ? (
          <span className="tabular-nums text-[10px] text-chrome-text/50">{filteredCount} of {rows.length}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1 text-[10px]">
          <button type="button" onClick={expandAll} className="rounded px-1.5 py-0.5 text-chrome-text/65 hover:bg-foreground/[0.08] hover:text-foreground">expand all</button>
          <button type="button" onClick={collapseAll} className="rounded px-1.5 py-0.5 text-chrome-text/65 hover:bg-foreground/[0.08] hover:text-foreground">collapse all</button>
        </div>
      </div>

      {toast ? (
        <div
          className={cn(
            "px-3 py-1 text-[11px]",
            toast.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
          )}
        >
          {toast.ok ? <Check className="mr-1 inline h-3 w-3" /> : <AlertTriangle className="mr-1 inline h-3 w-3" />}
          {toast.msg}
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {groups.length === 0 ? (
          <div className="grid h-24 place-items-center text-center text-[11px] text-chrome-text/45">
            No tables match “{search.trim()}”.
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const expanded = search.trim() !== "" || !collapsed.has(g.schema)
              return (
                <div key={g.schema} className="overflow-hidden rounded-md border border-chrome-border/60">
                  <button
                    type="button"
                    onClick={() => toggleSchema(g.schema)}
                    className="flex w-full items-center gap-2 bg-secondary-background/60 px-2.5 py-1.5 text-left hover:bg-foreground/[0.05]"
                  >
                    <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-chrome-text/50 transition-transform", expanded && "rotate-90")} />
                    <Database className="h-3.5 w-3.5 shrink-0 text-rvbbit-accent/80" />
                    <span className="font-mono text-[12px] font-medium text-foreground">{g.schema}</span>
                    <span className="text-[10px] text-chrome-text/45">{g.count} table{g.count === 1 ? "" : "s"}</span>
                    <span className="ml-auto flex items-center gap-2.5 text-[10px] tabular-nums">
                      {g.dirty > 0 ? <span className="text-warning">{g.dirty} dirty</span> : null}
                      {g.backedOff > 0 ? <span className="text-warning">{g.backedOff} backoff</span> : null}
                      {g.running > 0 ? (
                        <span className="inline-flex items-center gap-0.5 text-rvbbit-accent">
                          <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                          {g.running}
                        </span>
                      ) : null}
                      {g.automated > 0 ? <span className="text-chrome-text/55">{g.automated} auto</span> : null}
                      <span className="text-chrome-text/45">{fmtCount(g.totalRows)} rows</span>
                    </span>
                  </button>
                  {expanded ? (
                    <div className="space-y-2 p-2">
                      {g.list.map((r) => (
                        <FreshnessLane
                          key={r.tableName}
                          row={r}
                          plan={plan.get(r.tableName) ?? null}
                          busy={busyTable === r.tableName}
                          onRefresh={(kind) =>
                            void act(
                              r.tableName,
                              kind === "full" ? accelRebuildSql(r.tableName) : accelRefreshSql(r.tableName),
                              kind === "full" ? "fold" : "refresh",
                            )
                          }
                          onSetPolicy={(strategy, target, maxRowGroups, maxTombstones) =>
                            void act(
                              r.tableName,
                              strategy === "manual"
                                ? clearAccelPolicySql(r.tableName)
                                : setAccelPolicySql(
                                    r.tableName,
                                    strategy,
                                    target,
                                    maxRowGroups,
                                    maxTombstones,
                                    r.minIntervalSecs,
                                  ),
                              `policy → ${strategy}`,
                            )
                          }
                          onToggleEngine={(target, enabled) =>
                            void act(
                              r.tableName,
                              setTableEngineSql(r.tableName, target, enabled),
                              `${target} ${enabled ? "on" : "off"}`,
                            )
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── One table's lane ────────────────────────────────────────────────

function FreshnessLane({
  row,
  plan,
  busy,
  onRefresh,
  onSetPolicy,
  onToggleEngine,
}: {
  row: AccelFreshnessRow
  plan: AccelTickPlanRow | null
  busy: boolean
  onRefresh: (kind: "delta" | "full") => void
  onSetPolicy: (
    strategy: AccelStrategy,
    target: number | null,
    maxRowGroups: number | null,
    maxTombstones: number | null,
  ) => void
  onToggleEngine: (target: string, enabled: boolean) => void
}) {
  const rec = recommendPolicy(row)
  const recDiffers = rec.strategy !== row.strategy
  const driftPct = row.driftRatio == null ? null : Math.round(row.driftRatio * 100)
  const state: LaneState = row.opRunning ? "catching-up" : isFinalLockBackoff(row) ? "backoff" : row.dirty ? "dirty" : "fresh"
  const operationSummary = summarizeOperation(row)
  const operationTitle = describeOperation(row)
  // shown under a schema group header, so drop the redundant "schema." prefix
  const displayName =
    row.schema && row.tableName.startsWith(`${row.schema}.`)
      ? row.tableName.slice(row.schema.length + 1)
      : row.tableName

  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StateChip state={state} secondsDirty={row.secondsDirty} />
        <span className="font-mono text-[12px] text-foreground" title={row.tableName}>{displayName}</span>
        {row.lance ? (
          <span
            title="Lance vector dataset — refresh is a full overwrite (expensive)"
            className="inline-flex items-center gap-1 rounded bg-chart-4/15 px-1.5 py-0.5 text-[10px] text-chart-4"
          >
            <Sparkles className="h-2.5 w-2.5" /> lance
          </span>
        ) : null}
        {!row.authoritative && !row.dirty ? (
          <span className="text-[10px] text-chrome-text/45">heap empty</span>
        ) : null}

        {/* actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {plan && plan.status !== "skip" ? (
            <span
              title={plan.reason}
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
                plan.status === "planned"
                  ? "bg-rvbbit-accent/10 text-rvbbit-accent"
                  : "bg-warning/10 text-warning",
              )}
            >
              <TrendingUp className="h-2.5 w-2.5" /> {plan.status === "planned" ? "next" : "defer"} →{" "}
              {plan.action === "full" ? "fold" : plan.action === "delta" ? "refresh" : plan.action}
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => onRefresh("delta")}
            title="Refresh: append the safe heap delta as new accelerator row groups"
            className="inline-flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <Zap className="h-3 w-3" /> Refresh
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRefresh("full")}
            title="Fold: consolidate accelerator files with a lagged catch-up and a polite final handoff"
            className="inline-flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <Hammer className="h-3 w-3" /> Fold
          </button>
        </div>
      </div>

      {/* metrics row */}
      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-x-4 gap-y-1.5">
        <Stat label="drift">
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, driftPct ?? 100)}%`,
                  background: loadColor(row.driftRatio ?? 1),
                }}
              />
            </div>
            <span className="tabular-nums text-chrome-text/85">
              {fmtCount(row.driftRows)}
              {driftPct != null ? <span className="text-chrome-text/45"> · {driftPct}%</span> : null}
            </span>
          </div>
        </Stat>
        <Stat label="demand">
          <span className="tabular-nums text-chrome-text/85" title="sequential heap scans = queries on the slow path">
            {fmtCount(row.heapSeqScans)} slow scans
          </span>
        </Stat>
        <Stat label="fragmentation">
          <span
            className="tabular-nums text-chrome-text/85"
            title="Row-group fanout and tombstones are consolidation pressure; accel_tick can fold them into a clean accelerator."
          >
            {fmtCount(row.rowGroups)} rg
            {row.tombstones > 0 ? <span className="text-warning"> · {fmtCount(row.tombstones)} tomb</span> : null}
          </span>
        </Stat>
        <Stat label="last refresh">
          <span className="inline-flex items-center gap-1 text-chrome-text/85">
            <Clock className="h-2.5 w-2.5 text-chrome-text/45" />
            {row.lastRefreshAt ? fmtAgo(row.lastRefreshAt) : "never"}
          </span>
        </Stat>
        <Stat label="last action">
          <span
            className={cn(
              "inline-flex max-w-[11rem] items-center gap-1 text-chrome-text/85",
              isFinalLockBackoff(row) && "text-warning",
              row.lastOperationStatus === "failed" && "text-danger",
              row.lastOperationStatus === "running" && "text-rvbbit-accent",
            )}
            title={operationTitle}
          >
            <span className="truncate">{operationSummary}</span>
            {row.lastOperationAt ? (
              <span className="shrink-0 text-chrome-text/45">· {fmtAgo(row.lastOperationAt)}</span>
            ) : null}
          </span>
        </Stat>
        <Stat label="rebuild cost">
          <span className="tabular-nums text-chrome-text/85">
            {row.lastRebuildMs != null ? fmtMs(row.lastRebuildMs) : "—"}
            {row.parquetRows ? (
              <span className="text-chrome-text/45"> · {fmtCount(row.parquetRows)} rows</span>
            ) : null}
          </span>
        </Stat>
      </div>

      {/* policy row */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-chrome-border/50 pt-2">
        <Wrench className="h-3 w-3 text-chrome-text/45" />
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/45">policy</span>
        <select
          value={row.strategy}
          disabled={busy}
          onChange={(e) =>
            onSetPolicy(
              e.target.value as AccelStrategy,
              e.target.value === "target" ? (row.targetSecs ?? 300) : null,
              row.maxRowGroupsBeforeRebuild,
              row.maxTombstonesBeforeRebuild,
            )
          }
          className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-40"
        >
          {ACCEL_STRATEGIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {row.strategy === "target" ? (
          <TargetEditor
            key={row.targetSecs ?? 300}
            seconds={row.targetSecs ?? 300}
            disabled={busy}
            onCommit={(secs) =>
              onSetPolicy(
                "target",
                secs,
                row.maxRowGroupsBeforeRebuild,
                row.maxTombstonesBeforeRebuild,
              )
            }
          />
        ) : null}
        {!row.explicit ? <span className="text-[10px] text-chrome-text/40">(default)</span> : null}

        {row.strategy !== "manual" ? (
          <span className="inline-flex flex-wrap items-center gap-1 text-[10px] text-chrome-text/55">
            fold at
            <ThresholdEditor
              key={`rg-${row.maxRowGroupsBeforeRebuild ?? "off"}`}
              label="row groups"
              value={row.maxRowGroupsBeforeRebuild}
              disabled={busy}
              onCommit={(value) =>
                onSetPolicy(
                  row.strategy,
                  row.strategy === "target" ? row.targetSecs : null,
                  value,
                  row.maxTombstonesBeforeRebuild,
                )
              }
            />
            or
            <ThresholdEditor
              key={`tomb-${row.maxTombstonesBeforeRebuild ?? "off"}`}
              label="tombstones"
              value={row.maxTombstonesBeforeRebuild}
              disabled={busy}
              onCommit={(value) =>
                onSetPolicy(
                  row.strategy,
                  row.strategy === "target" ? row.targetSecs : null,
                  row.maxRowGroupsBeforeRebuild,
                  value,
                )
              }
            />
          </span>
        ) : null}

        {recDiffers ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onSetPolicy(
                rec.strategy,
                rec.targetSecs,
                row.maxRowGroupsBeforeRebuild,
                row.maxTombstonesBeforeRebuild,
              )
            }
            title={rec.why}
            className="ml-auto inline-flex items-center gap-1 rounded bg-rvbbit-accent/10 px-2 py-0.5 text-[10px] text-rvbbit-accent hover:bg-rvbbit-accent/20 disabled:opacity-40"
          >
            <Sparkles className="h-2.5 w-2.5" /> suggest: {rec.strategy}
            {rec.targetSecs ? ` ${Math.round(rec.targetSecs / 60)}m` : ""}
          </button>
        ) : null}
      </div>

      {/* engines / layouts row — disable a chip to remove that routing pathway
          (and stop the rebuilder materializing a denied layout). */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Boxes className="h-3 w-3 text-chrome-text/45" />
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/45">engines</span>
        {TOGGLE_ENGINES.map((eng) => (
          <EngineChip
            key={eng}
            label={eng}
            on={!row.deniedEngines.includes(eng)}
            busy={busy}
            onClick={() => onToggleEngine(eng, row.deniedEngines.includes(eng))}
          />
        ))}
        <span className="mx-0.5 text-chrome-text/25">·</span>
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/45">layouts</span>
        {TOGGLE_LAYOUTS.map((lay) => (
          <EngineChip
            key={lay}
            label={lay}
            on={!row.deniedLayouts.includes(lay)}
            busy={busy}
            onClick={() => onToggleEngine(lay, row.deniedLayouts.includes(lay))}
          />
        ))}
        <span className="ml-auto text-[10px] text-chrome-text/35">native always on</span>
      </div>
    </div>
  )
}

function EngineChip({
  label,
  on,
  busy,
  onClick,
}: {
  label: string
  on: boolean
  busy: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      title={
        on
          ? `${label} enabled — click to disable for this table (removes the pathway)`
          : `${label} disabled for this table — click to re-enable`
      }
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-40",
        on
          ? "bg-success/15 text-success hover:bg-success/25"
          : "bg-foreground/[0.06] text-chrome-text/40 line-through hover:bg-foreground/[0.1]",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-success" : "bg-chrome-text/30")} />
      {label}
    </button>
  )
}

function operationName(op: string | null): string {
  switch (op) {
    case "refresh_acceleration":
      return "refresh"
    case "rebuild_acceleration":
      return "fold"
    case "compact_acceleration":
      return "compact"
    case "legacy_compact":
      return "legacy compact"
    default:
      return op ? op.replace(/_/g, " ") : "none"
  }
}

function summarizeOperation(row: AccelFreshnessRow): string {
  if (!row.lastOperation) return "none"
  const op = operationName(row.lastOperation)
  if (isFinalLockBackoff(row)) return `${op} backed off`
  if (row.lastOperationStatus === "running") return `${op} running`
  if (row.lastOperationStatus === "failed") return `${op} failed`
  if (row.lastOperationStatus === "noop") return `${op} no-op`
  if (row.lastOperationStatus === "ok" && row.lastOperation === "rebuild_acceleration" && (row.lastCatchupRows ?? 0) > 0) {
    return `${op} + ${fmtCount(row.lastCatchupRows ?? 0)} catch-up`
  }
  return row.lastOperationStatus ? `${op} ${row.lastOperationStatus}` : op
}

function describeOperation(row: AccelFreshnessRow): string {
  if (!row.lastOperation) return "No accelerator operation history"
  const parts = [operationName(row.lastOperation)]
  if (row.lastOperationStatus) parts.push(`status ${row.lastOperationStatus}`)
  if (row.lastOperationSwap) parts.push(`swap ${row.lastOperationSwap}`)
  if (row.lastRowsWritten != null) parts.push(`${fmtCount(row.lastRowsWritten)} rows written`)
  if (row.lastCatchupRows != null && row.lastCatchupRows > 0) parts.push(`${fmtCount(row.lastCatchupRows)} catch-up rows`)
  if (row.lastRemappedTombstones != null && row.lastRemappedTombstones > 0) {
    parts.push(`${fmtCount(row.lastRemappedTombstones)} tombstones remapped`)
  }
  if (row.lastFinalLockAttempts != null) parts.push(`${fmtCount(row.lastFinalLockAttempts)} final-lock attempts`)
  if (row.lastQueuedOrphanFiles != null && row.lastQueuedOrphanFiles > 0) {
    parts.push(`${fmtCount(row.lastQueuedOrphanFiles)} files queued for cleanup`)
  }
  if (row.lastOperationError) parts.push(row.lastOperationError)
  return parts.join(" · ")
}

function StateChip({ state, secondsDirty }: { state: LaneState; secondsDirty: number | null }) {
  const cfg =
    state === "catching-up"
      ? { cls: "bg-info/15 text-info", dot: "animate-pulse bg-info", label: "catching up" }
      : state === "backoff"
        ? { cls: "bg-warning/15 text-warning", dot: "animate-pulse bg-warning", label: "lagging" }
      : state === "dirty"
        ? { cls: "bg-warning/15 text-warning", dot: "bg-warning", label: "dirty" }
        : { cls: "bg-success/15 text-success", dot: "bg-success", label: "fresh" }
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px]", cfg.cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
      {(state === "dirty" || state === "backoff") && secondsDirty != null && secondsDirty >= 1 ? (
        <span className="text-warning/70"> {fmtDur(secondsDirty)}</span>
      ) : null}
    </span>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-chrome-text/40">{label}</span>
      <span className="text-[11px]">{children}</span>
    </div>
  )
}

function TargetEditor({
  seconds,
  disabled,
  onCommit,
}: {
  seconds: number
  disabled: boolean
  onCommit: (secs: number) => void
}) {
  // Reset-on-prop-change is handled by a `key` at the call site (remount), so
  // no syncing effect is needed.
  const [val, setVal] = useState(String(seconds))
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-chrome-text/60">
      within
      <input
        value={val}
        disabled={disabled}
        onChange={(e) => setVal(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => {
          const n = Number(val)
          if (n >= 1 && n !== seconds) onCommit(n)
        }}
        className="h-6 w-14 rounded border border-chrome-border bg-secondary-background px-1.5 text-right text-[11px] tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-40"
      />
      s
    </span>
  )
}

function ThresholdEditor({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string
  value: number | null
  disabled: boolean
  onCommit: (value: number | null) => void
}) {
  const [val, setVal] = useState(value == null ? "" : String(value))
  return (
    <span className="inline-flex items-center gap-1 rounded border border-chrome-border/70 bg-secondary-background/60 px-1.5 py-0.5">
      <input
        value={val}
        disabled={disabled}
        inputMode="numeric"
        aria-label={`fold threshold ${label}`}
        placeholder="off"
        onChange={(e) => setVal(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => {
          const next = val.trim() === "" ? null : Math.max(1, Math.floor(Number(val)))
          if (next !== value) onCommit(next)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
        }}
        className="h-5 w-12 bg-transparent text-right text-[10px] tabular-nums text-foreground outline-none placeholder:text-chrome-text/35 disabled:opacity-40"
      />
      <span>{label}</span>
    </span>
  )
}

function fmtDur(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}
