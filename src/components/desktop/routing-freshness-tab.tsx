"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Check,
  Clock,
  Database,
  Hammer,
  RefreshCw,
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
  type AccelFreshnessRow,
  type AccelStrategy,
  type AccelTickPlanRow,
} from "@/lib/rvbbit/routing"

interface Props {
  activeConnectionId: string | null
}

/**
 * Freshness cockpit — the accelerator-management view of Adaptive Routing.
 * Because a stale table degrades to a correct-but-slow heap scan, this is a
 * value-vs-cost surface: see which tables are worth keeping fresh, set a
 * per-table policy, preview what the executor would do, and act.
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
    setToast(res.ok ? { ok: true, msg: "ran accel_tick" } : { ok: false, msg: res.error ?? "failed" })
    setBusyTable(null)
    await load()
  }, [activeConnectionId, load])

  const stats = useMemo(() => {
    const dirty = rows.filter((r) => r.dirty).length
    const wouldAct = [...plan.values()].filter((p) => p.status === "planned").length
    const automated = rows.filter((r) => r.explicit && r.strategy !== "manual" && r.active).length
    return { total: rows.length, dirty, wouldAct, automated }
  }, [rows, plan])

  if (!loaded) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">
        <span className="inline-flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> loading freshness…
        </span>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/60">
        <div>
          <Database className="mx-auto mb-2 h-6 w-6 text-chrome-text/30" />
          No accelerated rvbbit tables yet. Run <span className="font-mono">rvbbit.compact()</span> on a
          table to start.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-3 py-1.5 text-[11px]">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Activity className="h-3.5 w-3.5 text-rvbbit-accent" /> Freshness
        </span>
        <span className="text-chrome-text/40">·</span>
        <span className="tabular-nums text-chrome-text/80">
          {stats.total} accelerated · <span className={stats.dirty ? "text-warning" : ""}>{stats.dirty} dirty</span> ·{" "}
          {stats.automated} automated
        </span>
        {stats.wouldAct > 0 ? (
          <span className="rounded-full bg-rvbbit-accent/15 px-2 py-0.5 text-rvbbit-accent">
            tick would refresh {stats.wouldAct}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={busyTable === "__tick__"}
            onClick={() => void runTick()}
            title="Run the policy-driven executor now (budget 8)"
            className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2 py-1 font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
          >
            <Zap className="h-3 w-3" /> Run tick
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

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2.5">
        {rows.map((r) => (
          <FreshnessLane
            key={r.tableName}
            row={r}
            plan={plan.get(r.tableName) ?? null}
            busy={busyTable === r.tableName}
            onRefresh={(kind) =>
              void act(
                r.tableName,
                kind === "full" ? accelRebuildSql(r.tableName) : accelRefreshSql(r.tableName),
                kind === "full" ? "full rebuild" : "delta refresh",
              )
            }
            onSetPolicy={(strategy, target) =>
              void act(
                r.tableName,
                strategy === "manual"
                  ? clearAccelPolicySql(r.tableName)
                  : setAccelPolicySql(r.tableName, strategy, target),
                `policy → ${strategy}`,
              )
            }
          />
        ))}
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
}: {
  row: AccelFreshnessRow
  plan: AccelTickPlanRow | null
  busy: boolean
  onRefresh: (kind: "delta" | "full") => void
  onSetPolicy: (strategy: AccelStrategy, target: number | null) => void
}) {
  const rec = recommendPolicy(row)
  const recDiffers = rec.strategy !== row.strategy
  const driftPct = row.driftRatio == null ? null : Math.round(row.driftRatio * 100)
  const state = row.opRunning ? "building" : row.dirty ? "dirty" : "fresh"

  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StateChip state={state} secondsDirty={row.secondsDirty} />
        <span className="font-mono text-[12px] text-foreground">{row.tableName}</span>
        {row.lance ? (
          <span
            title="Lance vector dataset — refresh is a full overwrite (expensive)"
            className="inline-flex items-center gap-1 rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] text-fuchsia-300"
          >
            <Sparkles className="h-2.5 w-2.5" /> lance
          </span>
        ) : null}
        {!row.authoritative && !row.dirty ? (
          <span className="text-[10px] text-chrome-text/45">heap empty</span>
        ) : null}

        {/* actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {plan && plan.status === "planned" ? (
            <span
              title={plan.reason}
              className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/10 px-1.5 py-0.5 text-[10px] text-rvbbit-accent"
            >
              <TrendingUp className="h-2.5 w-2.5" /> tick → {plan.action}
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => onRefresh("delta")}
            title="Incremental delta refresh (cheap — appends new row groups)"
            className="inline-flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <Zap className="h-3 w-3" /> Delta
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRefresh("full")}
            title="Full rebuild from the heap (expensive — wipes & re-exports)"
            className="inline-flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/85 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <Hammer className="h-3 w-3" /> Full
          </button>
        </div>
      </div>

      {/* metrics row */}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
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
        <Stat label="last refresh">
          <span className="inline-flex items-center gap-1 text-chrome-text/85">
            <Clock className="h-2.5 w-2.5 text-chrome-text/45" />
            {row.lastRefreshAt ? fmtAgo(row.lastRefreshAt) : "never"}
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
            onCommit={(secs) => onSetPolicy("target", secs)}
          />
        ) : null}
        {!row.explicit ? <span className="text-[10px] text-chrome-text/40">(default)</span> : null}

        {recDiffers ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetPolicy(rec.strategy, rec.targetSecs)}
            title={rec.why}
            className="ml-auto inline-flex items-center gap-1 rounded bg-rvbbit-accent/10 px-2 py-0.5 text-[10px] text-rvbbit-accent hover:bg-rvbbit-accent/20 disabled:opacity-40"
          >
            <Sparkles className="h-2.5 w-2.5" /> suggest: {rec.strategy}
            {rec.targetSecs ? ` ${Math.round(rec.targetSecs / 60)}m` : ""}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function StateChip({ state, secondsDirty }: { state: string; secondsDirty: number | null }) {
  const cfg =
    state === "building"
      ? { cls: "bg-info/15 text-info", dot: "animate-pulse bg-info", label: "building" }
      : state === "dirty"
        ? { cls: "bg-warning/15 text-warning", dot: "bg-warning", label: "dirty" }
        : { cls: "bg-success/15 text-success", dot: "bg-success", label: "fresh" }
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px]", cfg.cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
      {state === "dirty" && secondsDirty != null && secondsDirty >= 1 ? (
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

function fmtDur(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}
